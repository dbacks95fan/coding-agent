// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Runs shell commands for the agent's bash tool, repository setup, and independent checks.
// ABOUTME: Children get a scrubbed environment (no credentials), bounded output, and a tree-kill on timeout.
import { spawn, spawnSync } from "node:child_process";

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface CommandOptions {
  command: string;
  cwd: string;
  shell: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}

/** Environment variables a child process may inherit. Credentials are never on this list. */
const INHERITED = ["PATH", "LANG", "LC_ALL", "TZ", "SystemRoot", "ComSpec", "PATHEXT", "WINDIR", "TEMP", "TMP"];

/**
 * Builds the environment for commands that run repository or model-chosen code.
 * Only an allowlist is inherited, so API keys and Git tokens held by this process
 * are not visible to the agent's shell, setup scripts, or validation commands.
 */
export function sandboxEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  };
}

/** Keeps the start and end of long output, which is where failures usually show. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n... [${dropped} characters omitted] ...\n${text.slice(-half)}`;
}

function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
}

export function runCommand(options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(options.shell, ["-c", options.command], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Collect a bounded window so a chatty command cannot exhaust memory.
    const limit = options.maxOutputChars * 4;
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > limit) output = truncateMiddle(output, options.maxOutputChars * 2);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      if (child.pid) killTree(child.pid);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        exitCode: timedOut || aborted ? null : exitCode,
        output: truncateMiddle(output, options.maxOutputChars),
        timedOut,
        aborted,
        durationMs: Date.now() - started,
      });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
  });
}
