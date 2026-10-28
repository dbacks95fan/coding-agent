// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for the editor and bash tool handlers and their permission boundaries.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { sandboxEnv } from "./commands.js";
import { removeDir, tempDir, testShell, writeBytes } from "./testSupport.js";
import { deniedCommandReason, runBash, runEditor, type ToolContext } from "./tools.js";

let workspace: string;
let ctx: ToolContext;

before(() => {
  workspace = tempDir("tools-");
  writeBytes(workspace, "src/app.ts", "const a = 1;\nconst b = 2;\n");
  writeBytes(workspace, "docs/readme.md", "docs\n");
  writeBytes(workspace, ".agent/work/INT-1/intent.md", "frozen\n");
  writeBytes(workspace, ".agent/work/INT-1/evidence-package/old.json", "{}\n");
  writeBytes(workspace, ".git/config", "[core]\n");
  ctx = {
    workspace,
    readPaths: ["."],
    writePaths: ["src", ".agent/work/INT-1"],
    protectedPaths: [".agent/work/INT-1/intent.md"],
    protectedPrefixes: [".agent/work/INT-1/evidence-package/"],
    shell: testShell(),
    env: sandboxEnv(workspace),
    bashTimeoutMs: 30_000,
    maxOutputChars: 10_000,
  };
});

after(() => removeDir(workspace));

test("view numbers lines and honors view_range", () => {
  const result = runEditor({ command: "view", path: "src/app.ts", view_range: [2, -1] }, ctx);
  assert.equal(result.isError, false);
  assert.match(result.content, /^\s+2\tconst b = 2;/);
  assert.doesNotMatch(result.content, /const a/);
});

test("view lists a directory without git metadata", () => {
  const result = runEditor({ command: "view", path: "." }, ctx);
  assert.match(result.content, /src\/app.ts/);
  assert.doesNotMatch(result.content, /\.git\//);
});

test("create, str_replace, and insert edit files inside write_paths", () => {
  assert.equal(runEditor({ command: "create", path: "src/new.ts", file_text: "x\n" }, ctx).isError, false);
  assert.equal(
    runEditor({ command: "str_replace", path: "src/app.ts", old_str: "const a = 1;", new_str: "const a = 10;" }, ctx)
      .isError,
    false,
  );
  assert.equal(
    runEditor({ command: "insert", path: "src/app.ts", insert_line: 0, insert_text: "// header" }, ctx).isError,
    false,
  );
  assert.equal(readFileSync(join(workspace, "src/app.ts"), "utf8"), "// header\nconst a = 10;\nconst b = 2;\n");
});

test("str_replace refuses missing and ambiguous matches", () => {
  writeBytes(workspace, "src/dupe.ts", "x\nx\n");
  assert.match(
    runEditor({ command: "str_replace", path: "src/dupe.ts", old_str: "x", new_str: "y" }, ctx).content,
    /matches 2 places/,
  );
  assert.match(
    runEditor({ command: "str_replace", path: "src/dupe.ts", old_str: "zzz", new_str: "y" }, ctx).content,
    /not found/,
  );
});

test("writes outside write_paths, to protected inputs, or to git metadata are refused", () => {
  assert.match(
    runEditor({ command: "create", path: "docs/x.md", file_text: "x" }, ctx).content,
    /outside this invocation's write_paths/,
  );
  assert.match(
    runEditor({ command: "create", path: ".agent/work/INT-1/intent.md", file_text: "x" }, ctx).content,
    /frozen or recorded/,
  );
  assert.match(
    runEditor({ command: "create", path: ".agent/work/INT-1/evidence-package/new.json", file_text: "x" }, ctx).content,
    /frozen or recorded/,
  );
  assert.match(
    runEditor({ command: "create", path: ".git/hooks/pre-commit", file_text: "x" }, ctx).content,
    /Git metadata/,
  );
  assert.match(
    runEditor({ command: "create", path: "../escape.txt", file_text: "x" }, ctx).content,
    /outside the assigned workspace/,
  );
  assert.equal(readFileSync(join(workspace, ".agent/work/INT-1/intent.md"), "utf8"), "frozen\n");
});

test("view outside read_paths is refused", () => {
  const narrow = { ...ctx, readPaths: ["src"] };
  assert.match(
    runEditor({ command: "view", path: "docs/readme.md" }, narrow).content,
    /outside this invocation's read_paths/,
  );
});

test("bash runs in the workspace without credentials", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
  try {
    const result = await runBash({ command: 'ls src && echo "key=[$ANTHROPIC_API_KEY]"' }, ctx);
    assert.equal(result.isError, false);
    assert.match(result.content, /app.ts/);
    assert.match(result.content, /key=\[\]/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test("bash reports a failing exit code as an error result", async () => {
  const result = await runBash({ command: "exit 4" }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content, /Exit code 4/);
});

test("deniedCommandReason refuses repository-changing git and remote access", () => {
  for (const command of [
    "git push origin HEAD",
    "git -C . commit -m x",
    "npm test && git push",
    "FOO=1 git config user.name x",
    "curl https://example.com",
    "/usr/bin/ssh host",
    "cat /proc/1/environ",
    "docker build .",
    "echo $(git reset --hard)",
  ]) {
    assert.ok(deniedCommandReason(command), command);
  }
});

test("deniedCommandReason allows ordinary development commands", () => {
  for (const command of [
    "npm run build",
    "git status",
    "git diff -- src/commit.ts",
    "git log --oneline -5",
    "grep -rn push src",
  ]) {
    assert.equal(deniedCommandReason(command), null, command);
  }
});
