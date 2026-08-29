import { spawn } from "node:child_process";
import type { IndependentValidationResult, ValidationGate } from "./types.js";

/**
 * Command each gate runs, independent of anything the agent did or claimed.
 * This is intentionally a fixed, per-repo-convention mapping rather than something
 * the contract or the agent can influence — that's the point of a deterministic
 * grader: the Coding Agent does not get to redefine what constitutes a pass.
 */
const GATE_COMMANDS: Record<ValidationGate, { command: string; args: string[] }> = {
  build: { command: "npm", args: ["run", "build"] },
  automated_tests: { command: "npm", args: ["run", "test:server"] },
  playwright: { command: "npm", args: ["run", "test:e2e"] },
  docker_build: { command: "docker", args: ["build", "-t", "coding-agent-validation:latest", "."] },
};

function runCommand(cwd: string, command: string, args: string[], timeoutMs: number): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, stdout, stderr, durationMs: Date.now() - started });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

/** Parses "Tests  47 passed (2 skipped)" / "X passed, Y failed" style summaries. Best-effort only. */
function parseCounts(output: string): { passed?: number; failed?: number } {
  const failMatch = output.match(/(\d+)\s+failed/i);
  const passMatch = output.match(/(\d+)\s+passed/i);
  return {
    passed: passMatch ? Number(passMatch[1]) : undefined,
    failed: failMatch ? Number(failMatch[1]) : undefined,
  };
}

export async function runIndependentValidation(
  worktreePath: string,
  gates: ValidationGate[],
  perGateTimeoutMs: number,
): Promise<Record<string, IndependentValidationResult>> {
  const results: Record<string, IndependentValidationResult> = {};

  for (const gate of gates) {
    const spec = GATE_COMMANDS[gate];
    const commandStr = `${spec.command} ${spec.args.join(" ")}`;
    const { exitCode, stdout, stderr, durationMs } = await runCommand(
      worktreePath,
      spec.command,
      spec.args,
      perGateTimeoutMs,
    );
    const combined = stdout + "\n" + stderr;
    const counts = parseCounts(combined);
    const excerpt = combined.slice(-2000);

    results[gate] = {
      status: exitCode === 0 ? "pass" : exitCode === null ? "error" : "fail",
      command: commandStr,
      exitCode,
      durationMs,
      passed: counts.passed,
      failed: counts.failed,
      logExcerpt: excerpt,
    };
  }

  return results;
}
