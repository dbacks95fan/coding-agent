// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests for the command-line entry point's argument handling and failure modes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function cli(args: string[], env: Record<string, string> = {}) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete childEnv.ANTHROPIC_API_KEY;
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", env: childEnv });
}

test("an unknown command prints usage and exits 64", () => {
  const result = cli(["frobnicate"]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /Usage:/);
});

test("run is not a command; invocations arrive only over the HTTP API", () => {
  const result = cli(["run", "--invocation", "invocation.json"], { ANTHROPIC_API_KEY: "sk-ant-placeholder-for-test" });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /coding-agent run/);
});

test("serve refuses to start without a model key and says why", () => {
  const result = cli(["serve"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ANTHROPIC_API_KEY is not set/);
});

test("serve refuses to run unauthenticated", () => {
  const result = cli(["serve"], { ANTHROPIC_API_KEY: "sk-ant-placeholder-for-test" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CODING_AGENT_API_TOKEN is not set/);
});

test("invalid configuration is reported clearly", () => {
  const result = cli(["self-test"], { CODING_AGENT_EFFORT: "extreme" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CODING_AGENT_EFFORT/);
});
