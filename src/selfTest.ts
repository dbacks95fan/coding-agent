// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Deployment self-test: toolchain, GitHub App tokens, Git remotes, a read-only intent token, and the model.
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
 * Intent repositories use their own read-only token; see intentReadOnlyCheck.
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
      return `GitHub issued a ${access}-only token for this repository alone.`;
    });
  }
  return results;
}

/**
 * Judges a dry-run push made with the intent token. GitHub checks push permission
 * before a dry run ends, so acceptance means the token can write.
 */
export function judgeReadOnlyProbe(pushError: unknown): string {
  if (pushError === undefined) {
    throw new Error("A dry-run push with the intent token was accepted, so it can write; use a read-only token.");
  }
  const message = pushError instanceof Error ? pushError.message : String(pushError);
  if (/denied|not granted|\b403\b/i.test(message)) return "GitHub refused a dry-run push with the intent token.";
  throw new Error(`The read-only probe could not reach GitHub: ${message}`);
}

/** Proves the intent token cannot write, by a dry-run push that GitHub must refuse. */
async function intentReadOnlyCheck(git: DriverGit, url: string, scratch: string, probeDir: string): Promise<string> {
  const tip = (await git.run(["ls-remote", url, "HEAD"], scratch, { url, access: "read" })).split("\t")[0];
  await git.fetchCommit(url, tip, probeDir);
  let pushError: unknown;
  try {
    // A dry run: GitHub checks permission, and nothing is written even if it allows it.
    await git.run(
      ["push", "--dry-run", "--porcelain", url, `${tip}:refs/heads/coding-agent-read-only-probe`],
      probeDir,
      {
        url,
        access: "read",
      },
    );
  } catch (err) {
    pushError = err;
  }
  return judgeReadOnlyProbe(pushError);
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
  const remotes = [...manifest.repositories.map((r) => r.url), ...manifest.intent_repositories];
  for (const url of remotes) {
    await record(`git read access: ${url}`, async () => {
      const out = await git.run(["ls-remote", "--heads", url], scratch, { url, access: "read" });
      return `${out.split("\n").filter(Boolean).length} branch(es) visible.`;
    });
  }

  for (const [index, url] of manifest.intent_repositories.entries()) {
    if (!githubRepository(url)) continue;
    await record(`intent repository is read-only: ${url}`, () =>
      intentReadOnlyCheck(git, url, scratch, join(scratch, `intent-probe-${index}`)),
    );
  }

  await record(`model: ${config.model}`, probe);
  return results;
}
