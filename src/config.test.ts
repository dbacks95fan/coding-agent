// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for environment configuration.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, secretValues } from "./config.js";

test("defaults use Claude Opus 5.5 at high effort with bounded limits", () => {
  const config = loadConfig({});
  assert.equal(config.model, "claude-opus-5-5");
  assert.equal(config.effort, "high");
  assert.equal(config.serverSideFallback, true);
  assert.equal(config.limits.maxTurns, 60);
  assert.equal(config.limits.maxCostUsd, 5);
  assert.equal(config.limits.maxRuntimeMs, 30 * 60_000);
});

test("invalid effort and non-positive limits are rejected", () => {
  assert.throws(() => loadConfig({ CODING_AGENT_EFFORT: "extreme" }), /CODING_AGENT_EFFORT/);
  assert.throws(() => loadConfig({ CODING_AGENT_MAX_TURNS: "0" }), /CODING_AGENT_MAX_TURNS/);
  assert.throws(() => loadConfig({ CODING_AGENT_MAX_COST_USD: "abc" }), /CODING_AGENT_MAX_COST_USD/);
});

test("prefixed variables become command environment without the prefix", () => {
  const config = loadConfig({ CODING_AGENT_COMMAND_ENV_npm_config_cache: "/cache/npm" });
  assert.deepEqual(config.commandEnv, { npm_config_cache: "/cache/npm" });
});

test("secretValues lists every configured credential", () => {
  const config = loadConfig({
    ANTHROPIC_API_KEY: "sk-ant-key-123456",
    GITHUB_TOKEN: "ghp_token_123456",
    CODING_AGENT_API_TOKEN: "service-token-123",
  });
  assert.deepEqual(secretValues(config).sort(), ["ghp_token_123456", "service-token-123", "sk-ant-key-123456"]);
});
