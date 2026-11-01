// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Deployment self-test: toolchain, GitHub App tokens, Git remotes, intent-backlog refusal, and the model.
// ABOUTME: Used by the installer before it reports a deployment as working.
import Anthropic from "@anthropic-ai/sdk";
import { join } from "node:path";
import { runCommand, sandboxEnv } from "./commands.js";
import { secretValues, type RuntimeConfig } from "./config.js";
import { DriverGit, type GitAccess, type GitCredentials } from "./git.js";
import { githubRepository } from "./githubApp.js";
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

type Recorder = (name: string, check: () => Promise<string>) => Promise<void>;

function recorder(results: SelfTestResult[], secrets: string[]): Recorder {
  return async (name, check) => {
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
}

/**
 * Asks the GitHub App for every token a run can need on a target repository: write
 * to push, read for everything else. Local remotes need none and are skipped.
 * Intent repositories get no token at all; see intentRefusalChecks.
 */
export async function githubAccessChecks(
  manifest: CheckManifest,
  credentials: GitCredentials | undefined,
  secrets: string[],
): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = [];
  const record = recorder(results, secrets);
  const wanted: [string, GitAccess][] = manifest.repositories.flatMap((r): [string, GitAccess][] => [
    [r.url, "write"],
    [r.url, "read"],
  ]);
  for (const [url, access] of wanted) {
    if (!githubRepository(url)) continue;
    await record(`github app ${access} token: ${url}`, async () => {
      if (!credentials) throw new Error("No GitHub App is configured; set the CODING_AGENT_GITHUB_APP_* settings.");
      if (!(await credentials.tokenFor(url, access))) throw new Error("No token was issued.");
      return `GitHub issued a token with ${access} access to this repository alone.`;
    });
  }
  return results;
}

/**
 * Proves the driver refuses every intent repository, read or write, before any Git
 * call. The frozen intent reaches this agent only as copies on the work branch.
 */
export async function intentRefusalChecks(
  manifest: CheckManifest,
  credentials: GitCredentials | undefined,
  secrets: string[],
): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = [];
  const record = recorder(results, secrets);
  for (const url of manifest.intent_repositories) {
    await record(`intent repository is refused: ${url}`, async () => {
      if (!credentials) throw new Error("No credential router is configured, so nothing refuses this repository.");
      for (const access of ["read", "write"] as const) {
        const refused = await credentials.tokenFor(url, access).then(
          () => false,
          () => true,
        );
        if (!refused) throw new Error(`The driver would ${access} this intent repository; it must refuse.`);
      }
      return "The driver refuses read and write before any Git call.";
    });
  }
  return results;
}

export async function runSelfTest(
  config: RuntimeConfig,
  manifest: CheckManifest,
  probe: ModelProbe,
  scratch: string,
  credentials?: GitCredentials,
): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = [];
  const secrets = secretValues(config);
  const record = recorder(results, secrets);

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

  results.push(...(await githubAccessChecks(manifest, credentials, secrets)));

  const git = new DriverGit(join(scratch, "git-home"), config.gitIdentity, credentials);
  for (const url of manifest.repositories.map((r) => r.url)) {
    await record(`git read access: ${url}`, async () => {
      const out = await git.run(["ls-remote", "--heads", url], scratch, { url, access: "read" });
      return `${out.split("\n").filter(Boolean).length} branch(es) visible.`;
    });
  }

  results.push(...(await intentRefusalChecks(manifest, credentials, secrets)));

  await record(`model: ${config.model}`, probe);
  return results;
}
