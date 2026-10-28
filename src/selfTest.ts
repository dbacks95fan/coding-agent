// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Deployment self-test: toolchain present, Git remotes reachable with the configured token, model reachable.
// ABOUTME: Used by the installer before it reports a deployment as working.
import Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import { runCommand, sandboxEnv } from "./commands.js";
import { secretValues, type RuntimeConfig } from "./config.js";
import { DriverGit } from "./git.js";
import type { CheckManifest } from "./manifest.js";
import { redact } from "./redact.js";

export interface SelfTestResult {
  name: string;
  outcome: "pass" | "fail";
  detail: string;
}

export type ModelProbe = () => Promise<string>;

/** One minimal real request (a few tokens) proving the key, network path, and model ID all work. */
export function anthropicProbe(config: RuntimeConfig): ModelProbe {
  return async () => {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 64,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Reply with the single word OK." }],
    });
    return `${response.model} answered (stop_reason ${response.stop_reason}).`;
  };
}

export async function runSelfTest(
  config: RuntimeConfig,
  manifest: CheckManifest,
  probe: ModelProbe,
  scratch: string,
): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = [];
  const secrets = secretValues(config);
  const record = async (name: string, check: () => Promise<string>) => {
    try {
      results.push({ name, outcome: "pass", detail: redact(await check(), secrets) });
    } catch (err) {
      results.push({
        name,
        outcome: "fail",
        detail: redact(err instanceof Error ? err.message : String(err), secrets),
      });
    }
  };

  for (const program of ["git --version", "node --version", "npm --version"]) {
    await record(`toolchain: ${program}`, async () => {
      const outcome = await runCommand({
        command: program,
        cwd: scratch,
        shell: config.shell,
        env: sandboxEnv(scratch, config.commandEnv),
        timeoutMs: 30_000,
        maxOutputChars: 500,
      });
      if (outcome.exitCode !== 0) throw new Error(`exited with ${outcome.exitCode}: ${outcome.output}`);
      return outcome.output.trim();
    });
  }

  const git = new DriverGit(join(scratch, "git-home"), config.gitIdentity, config.gitToken);
  const remotes = [...manifest.repositories.map((r) => r.url), ...manifest.intent_repositories];
  for (const url of remotes) {
    await record(`git read access: ${url}`, async () => {
      const out = await git.run(["ls-remote", "--heads", url], scratch);
      return `${out.split("\n").filter(Boolean).length} branch(es) visible.`;
    });
  }

  await record(`model: ${config.model}`, probe);
  return results;
}
