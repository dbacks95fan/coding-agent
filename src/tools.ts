// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Executes the model's text-editor and bash tool calls inside the assigned workspace.
// ABOUTME: Paths are confined, writes honor write_paths and protected inputs, and bash runs without credentials.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCommand, truncateMiddle } from "./commands.js";
import { confineToWorkspace, isCovered } from "./paths.js";

export interface ToolContext {
  workspace: string;
  readPaths: string[];
  writePaths: string[];
  protectedPaths: string[];
  protectedPrefixes: string[];
  shell: string;
  env: NodeJS.ProcessEnv;
  bashTimeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

const ok = (content: string): ToolOutcome => ({ content, isError: false });
const fail = (content: string): ToolOutcome => ({ content, isError: true });

/** Git subcommands that change refs, history, config, or remotes. Read-only inspection stays available. */
const DENIED_GIT = new Set([
  "push",
  "merge",
  "rebase",
  "commit",
  "reset",
  "checkout",
  "switch",
  "config",
  "remote",
  "tag",
  "branch",
  "filter-branch",
  "filter-repo",
  "update-ref",
  "worktree",
  "am",
  "cherry-pick",
  "revert",
  "stash",
  "clean",
  "fetch",
  "pull",
  "clone",
  "submodule",
  "credential",
  "gc",
  "prune",
  "replace",
  "notes",
]);

const DENIED_PROGRAMS = new Map<string, string>([
  ["docker", "Container and image operations are outside the Coding Agent's authority."],
  ["ssh", "Remote hosts are outside the Coding Agent's authority."],
  ["scp", "Remote hosts are outside the Coding Agent's authority."],
  ["sftp", "Remote hosts are outside the Coding Agent's authority."],
  ["rsync", "Remote hosts are outside the Coding Agent's authority."],
  ["curl", "Fetching arbitrary URLs is not allowed; use the repository's package manager for dependencies."],
  ["wget", "Fetching arbitrary URLs is not allowed; use the repository's package manager for dependencies."],
  ["nc", "Raw network connections are not allowed."],
  ["ncat", "Raw network connections are not allowed."],
  ["netcat", "Raw network connections are not allowed."],
  ["gh", "GitHub operations belong to the driver, not the agent."],
]);

function programName(token: string): string {
  return token.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
}

/**
 * Screens a shell command before it runs. This is defense in depth, not the boundary:
 * the shell has no credentials, the driver restores Git config and ignores hooks,
 * and every changed path is checked against write_paths after the run.
 */
export function deniedCommandReason(command: string): string | null {
  if (/\/proc\/[^\s]*\/(environ|mem|maps|cmdline)/.test(command) || /\/proc\/(self|\d+|\*)/.test(command)) {
    return "Reading process memory or environment is not allowed.";
  }
  if (/trello\.com|api\.trello/i.test(command)) return "The Coding Agent must not touch the workflow board.";
  if (/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(\s|$)/i.test(command)) return "Deleting the filesystem root is not allowed.";

  for (const segment of command.split(/[;&|\n()`]+|\$\(/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    while (
      tokens.length &&
      ["sudo", "env", "nohup", "time", "exec", "command", "xargs"].includes(programName(tokens[0]))
    ) {
      tokens.shift();
    }
    if (!tokens.length) continue;
    const program = programName(tokens[0]);
    const deniedProgram = DENIED_PROGRAMS.get(program);
    if (deniedProgram) return deniedProgram;
    if (program === "git") {
      let i = 1;
      while (i < tokens.length && tokens[i].startsWith("-")) {
        i +=
          tokens[i] === "-C" || tokens[i] === "-c" || tokens[i] === "--git-dir" || tokens[i] === "--work-tree" ? 2 : 1;
      }
      const sub = tokens[i];
      if (sub && DENIED_GIT.has(sub)) {
        return `"git ${sub}" is not available: the driver commits and pushes the candidate. Use read-only git (status, diff, log, show).`;
      }
    }
  }
  return null;
}

export async function runBash(input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const args = (input ?? {}) as { command?: unknown; restart?: unknown };
  if (args.restart === true) return ok("Shell restarted. Each command runs in a fresh shell at the repository root.");
  if (typeof args.command !== "string" || !args.command.trim()) return fail("bash requires a non-empty command.");
  const denied = deniedCommandReason(args.command);
  if (denied) return fail(`Command refused: ${denied}`);

  const result = await runCommand({
    command: args.command,
    cwd: ctx.workspace,
    shell: ctx.shell,
    env: ctx.env,
    timeoutMs: ctx.bashTimeoutMs,
    maxOutputChars: ctx.maxOutputChars,
    signal: ctx.signal,
  });
  if (result.timedOut)
    return fail(`Command timed out after ${Math.round(ctx.bashTimeoutMs / 1000)}s.\n${result.output}`);
  if (result.aborted) return fail("Command stopped because the run was cancelled.");
  const body = result.output.trim() ? result.output : "(no output)";
  return result.exitCode === 0 ? ok(body) : fail(`Exit code ${result.exitCode}\n${body}`);
}

type EditorInput = {
  command?: unknown;
  path?: unknown;
  view_range?: unknown;
  file_text?: unknown;
  old_str?: unknown;
  new_str?: unknown;
  insert_line?: unknown;
  insert_text?: unknown;
};

export function runEditor(input: unknown, ctx: ToolContext): ToolOutcome {
  const args = (input ?? {}) as EditorInput;
  if (typeof args.path !== "string" || !args.path) return fail("A path is required.");
  let rel: string;
  try {
    rel = confineToWorkspace(ctx.workspace, args.path);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (rel === ".git" || rel.startsWith(".git/")) return fail("Git metadata is not accessible through the editor.");
  const full = rel === "." ? ctx.workspace : join(ctx.workspace, rel);

  switch (args.command) {
    case "view":
      return view(rel, full, args.view_range, ctx);
    case "create": {
      const denied = writeDenied(rel, ctx);
      if (denied) return fail(denied);
      if (typeof args.file_text !== "string") return fail("create requires file_text.");
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, args.file_text, "utf8");
      return ok(`Wrote ${rel}.`);
    }
    case "str_replace": {
      const denied = writeDenied(rel, ctx);
      if (denied) return fail(denied);
      if (typeof args.old_str !== "string" || !args.old_str) return fail("str_replace requires old_str.");
      if (!existsSync(full) || !statSync(full).isFile()) return fail(`${rel} does not exist.`);
      const text = readFileSync(full, "utf8");
      const count = text.split(args.old_str).length - 1;
      if (count === 0) return fail(`old_str was not found in ${rel}.`);
      if (count > 1) return fail(`old_str matches ${count} places in ${rel}; include more context so it is unique.`);
      const replacement = typeof args.new_str === "string" ? args.new_str : "";
      writeFileSync(
        full,
        text.replace(args.old_str, () => replacement),
        "utf8",
      );
      return ok(`Edited ${rel}.`);
    }
    case "insert": {
      const denied = writeDenied(rel, ctx);
      if (denied) return fail(denied);
      if (typeof args.insert_text !== "string") return fail("insert requires insert_text.");
      if (!Number.isInteger(args.insert_line)) return fail("insert requires an integer insert_line.");
      if (!existsSync(full) || !statSync(full).isFile()) return fail(`${rel} does not exist.`);
      const lines = readFileSync(full, "utf8").split("\n");
      const at = args.insert_line as number;
      if (at < 0 || at > lines.length) return fail(`insert_line must be between 0 and ${lines.length}.`);
      lines.splice(at, 0, ...args.insert_text.split("\n"));
      writeFileSync(full, lines.join("\n"), "utf8");
      return ok(`Inserted text into ${rel} after line ${at}.`);
    }
    default:
      return fail(`Unsupported editor command "${String(args.command)}". Use view, create, str_replace, or insert.`);
  }
}

function writeDenied(rel: string, ctx: ToolContext): string | null {
  if (rel === ".") return "Cannot write to the repository root itself.";
  if (ctx.protectedPaths.includes(rel) || ctx.protectedPrefixes.some((prefix) => rel.startsWith(prefix))) {
    return `${rel} is a frozen or recorded lifecycle artifact and must not be changed.`;
  }
  if (!isCovered(rel, ctx.writePaths)) {
    return `${rel} is outside this invocation's write_paths (${ctx.writePaths.join(", ")}).`;
  }
  return null;
}

function view(rel: string, full: string, range: unknown, ctx: ToolContext): ToolOutcome {
  if (rel !== "." && !isCovered(rel, ctx.readPaths)) return fail(`${rel} is outside this invocation's read_paths.`);
  if (!existsSync(full)) return fail(`${rel} does not exist.`);
  if (statSync(full).isDirectory()) return ok(truncateMiddle(listDirectory(full, rel), ctx.maxOutputChars));

  const bytes = readFileSync(full);
  if (bytes.includes(0)) return ok(`${rel} is a binary file (${bytes.length} bytes).`);
  const lines = bytes.toString("utf8").split("\n");
  let start = 1;
  let end = lines.length;
  if (Array.isArray(range) && range.length === 2 && range.every(Number.isInteger)) {
    start = Math.max(1, range[0] as number);
    end = (range[1] as number) === -1 ? lines.length : Math.min(lines.length, range[1] as number);
    if (start > end) return fail(`view_range ${JSON.stringify(range)} is empty for a ${lines.length}-line file.`);
  }
  const numbered = lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
    .join("\n");
  return ok(truncateMiddle(numbered, ctx.maxOutputChars));
}

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next"]);

function listDirectory(full: string, rel: string, depth = 2): string {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string, level: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      lines.push(entry.isDirectory() ? `${path}/` : path);
      if (entry.isDirectory() && level < depth) walk(join(dir, entry.name), path, level + 1);
    }
  };
  walk(full, rel === "." ? "" : rel, 1);
  return lines.join("\n") || "(empty directory)";
}
