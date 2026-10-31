// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for the scrubbed, bounded command runner.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand, sandboxEnv, truncateMiddle } from "./commands.js";
import { removeDir, tempDir, testShell } from "./testSupport.js";

test("sandboxEnv never carries credentials from the parent process", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
  process.env.CODING_AGENT_GIT_TOKEN = "ghp_should_not_leak";
  try {
    const env = sandboxEnv("/home/sandbox");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CODING_AGENT_GIT_TOKEN, undefined);
    assert.equal(env.HOME, "/home/sandbox");
    assert.equal(env.CI, "1");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CODING_AGENT_GIT_TOKEN;
  }
});

test("runCommand captures output and exit code", async () => {
  const cwd = tempDir("cmd-");
  try {
    const result = await runCommand({
      command: "echo hello; echo oops >&2; exit 3",
      cwd,
      shell: testShell(),
      env: sandboxEnv(cwd),
      timeoutMs: 30_000,
      maxOutputChars: 1000,
    });
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /hello/);
    assert.match(result.output, /oops/);
    assert.equal(result.timedOut, false);
  } finally {
    removeDir(cwd);
  }
});

test("runCommand does not expose parent credentials to the command", async () => {
  const cwd = tempDir("cmd-");
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
  try {
    const result = await runCommand({
      command: 'echo "key=[$ANTHROPIC_API_KEY]"',
      cwd,
      shell: testShell(),
      env: sandboxEnv(cwd),
      timeoutMs: 30_000,
      maxOutputChars: 1000,
    });
    assert.match(result.output, /key=\[\]/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    removeDir(cwd);
  }
});

test("runCommand kills a command that exceeds its timeout", async () => {
  const cwd = tempDir("cmd-");
  try {
    const result = await runCommand({
      command: "sleep 30",
      cwd,
      shell: testShell(),
      env: sandboxEnv(cwd),
      timeoutMs: 500,
      maxOutputChars: 1000,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.ok(result.durationMs < 20_000);
  } finally {
    removeDir(cwd);
  }
});

test("runCommand stops when its abort signal fires", async () => {
  const cwd = tempDir("cmd-");
  const controller = new AbortController();
  try {
    setTimeout(() => controller.abort(), 300);
    const result = await runCommand({
      command: "sleep 30",
      cwd,
      shell: testShell(),
      env: sandboxEnv(cwd),
      timeoutMs: 60_000,
      maxOutputChars: 1000,
      signal: controller.signal,
    });
    assert.equal(result.aborted, true);
  } finally {
    removeDir(cwd);
  }
});

test("truncateMiddle keeps both ends of long output", () => {
  const text = `START${"x".repeat(1000)}END`;
  const out = truncateMiddle(text, 100);
  assert.ok(out.startsWith("START"));
  assert.ok(out.endsWith("END"));
  assert.match(out, /characters omitted/);
});
