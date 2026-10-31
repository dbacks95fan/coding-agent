#!/usr/bin/env node
// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Process entry: serve the authenticated HTTP API or run the deployment self-test.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AnthropicModelClient } from "./agentLoop.js";
import { loadConfig, secretValues, type RuntimeConfig } from "./config.js";
import { RoutedCredentials } from "./credentials.js";
import type { GitCredentials } from "./git.js";
import { GitHubAppCredentials } from "./githubApp.js";
import { createLogger } from "./log.js";
import { loadManifest, type CheckManifest } from "./manifest.js";
import { currentProcessIdentity, dropPrivileges } from "./privileges.js";
import { redact } from "./redact.js";
import { executeInvocation } from "./run.js";
import { anthropicProbe, runSelfTest } from "./selfTest.js";
import { createService } from "./service.js";

const USAGE = `Usage:
  coding-agent serve
  coding-agent self-test

Invocations arrive only through the HTTP API started by "serve".
Configuration comes from environment variables; see README.md.`;

const USAGE_EXIT_CODE = 64;

function requireModelKey(config: RuntimeConfig): void {
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
}

type CredentialsFor = (manifest: CheckManifest) => GitCredentials;

async function selfTest(config: RuntimeConfig, credentialsFor: CredentialsFor) {
  const scratch = mkdtempSync(join(config.workRoot, "self-test-"));
  try {
    const manifest = loadManifest(config.manifestPath);
    return await runSelfTest(config, manifest, anthropicProbe(config), scratch, credentialsFor(manifest));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  // Secrets are read first, while root can still open the root-only key file; nothing else runs as root.
  const config = loadConfig();
  const identity = currentProcessIdentity();
  const privileges = identity ? dropPrivileges(identity) : "not-root";
  if (privileges === "dropped") process.env.HOME = "/home/agent";
  const secrets = secretValues(config);
  const log = createLogger(secrets);
  if (privileges === "dropped") log("privileges_dropped", { uid: process.getuid?.() });
  // One app instance per process, so runs and self-tests reuse tokens until they near expiry.
  const appCredentials = config.githubApp ? new GitHubAppCredentials(config.githubApp) : undefined;
  const credentialsFor: CredentialsFor = (manifest) =>
    new RoutedCredentials(manifest, config.intentToken, appCredentials);
  mkdirSync(config.workRoot, { recursive: true });

  if (command === "serve") {
    requireModelKey(config);
    if (!config.apiToken)
      throw new Error("CODING_AGENT_API_TOKEN is not set; the service will not run unauthenticated.");
    const manifest = loadManifest(config.manifestPath);
    const credentials = credentialsFor(manifest);
    const model = new AnthropicModelClient(config);
    const server = createService({
      apiToken: config.apiToken,
      secrets,
      log,
      execute: (raw) => executeInvocation(raw, { config, manifest, model, log, credentials }),
      selfTest: () => selfTest(config, credentialsFor),
    });
    server.listen(config.port, () => log("service_listening", { port: config.port, model: config.model }));
    return new Promise<number>((resolvePromise) => {
      const stop = () => server.close(() => resolvePromise(0));
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
  }

  if (command === "self-test") {
    requireModelKey(config);
    const results = await selfTest(config, credentialsFor);
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
    return results.every((r) => r.outcome === "pass") ? 0 : 1;
  }

  process.stderr.write(`${USAGE}\n`);
  return USAGE_EXIT_CODE;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    let secrets: string[] = [];
    try {
      secrets = secretValues(loadConfig());
    } catch {
      // The configuration itself was the problem; the message below says why.
    }
    process.stderr.write(`${redact(err instanceof Error ? err.message : String(err), secrets)}\n`);
    process.exit(1);
  },
);
