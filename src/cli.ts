#!/usr/bin/env node
// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Command-line entry: run one invocation from a file, serve the HTTP API, or run the deployment self-test.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AnthropicModelClient } from "./agentLoop.js";
import { loadConfig, secretValues, type RuntimeConfig } from "./config.js";
import { createLogger } from "./log.js";
import { loadManifest } from "./manifest.js";
import { redact } from "./redact.js";
import { executeInvocation } from "./run.js";
import { anthropicProbe, runSelfTest } from "./selfTest.js";
import { createService } from "./service.js";

const USAGE = `Usage:
  coding-agent run --invocation <stage-invocation.json>
  coding-agent serve
  coding-agent self-test

Configuration comes from environment variables; see README.md.`;

/** Exit codes for "run": one per Execution status, plus 4 when the input cannot be correlated. */
export const EXIT_CODES = {
  candidate_complete: 0,
  failed: 1,
  blocked: 2,
  needs_decision: 3,
  uncorrelated: 4,
  usage: 64,
} as const;

function requireModelKey(config: RuntimeConfig): void {
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
}

async function selfTest(config: RuntimeConfig) {
  const scratch = mkdtempSync(join(config.workRoot, "self-test-"));
  try {
    return await runSelfTest(config, loadManifest(config.manifestPath), anthropicProbe(config), scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const config = loadConfig();
  const secrets = secretValues(config);
  const log = createLogger(secrets);
  mkdirSync(config.workRoot, { recursive: true });

  if (command === "run") {
    const flag = rest.indexOf("--invocation");
    const file = flag >= 0 ? rest[flag + 1] : undefined;
    if (!file) {
      process.stderr.write(`${USAGE}\n`);
      return EXIT_CODES.usage;
    }
    requireModelKey(config);
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const outcome = await executeInvocation(raw, {
      config,
      manifest: loadManifest(config.manifestPath),
      model: new AnthropicModelClient(config),
      log,
    });
    process.stdout.write(
      `${redact(JSON.stringify({ stage_result: outcome.stageResult, evidence_package: outcome.evidencePackage, diagnostics: outcome.diagnostics }, null, 2), secrets)}\n`,
    );
    return outcome.stageResult ? EXIT_CODES[outcome.stageResult.status] : EXIT_CODES.uncorrelated;
  }

  if (command === "serve") {
    requireModelKey(config);
    if (!config.apiToken)
      throw new Error("CODING_AGENT_API_TOKEN is not set; the service will not run unauthenticated.");
    const manifest = loadManifest(config.manifestPath);
    const model = new AnthropicModelClient(config);
    const server = createService({
      apiToken: config.apiToken,
      secrets,
      log,
      execute: (raw) => executeInvocation(raw, { config, manifest, model, log }),
      selfTest: () => selfTest(config),
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
    const results = await selfTest(config);
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
    return results.every((r) => r.outcome === "pass") ? 0 : 1;
  }

  process.stderr.write(`${USAGE}\n`);
  return EXIT_CODES.usage;
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
