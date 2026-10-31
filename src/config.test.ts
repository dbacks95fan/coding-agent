// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for environment configuration.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, secretValues } from "./config.js";
import { removeDir, tempDir } from "./testSupport.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** Runs a test with a key file on disk and the three GitHub App settings pointing at it. */
function withAppSettings(body: (env: NodeJS.ProcessEnv, keyFile: string) => void, keyText = privateKey): void {
  const dir = tempDir("config-");
  try {
    const keyFile = join(dir, "app.pem");
    writeFileSync(keyFile, keyText);
    body(
      {
        CODING_AGENT_GITHUB_APP_ID: "5555873",
        CODING_AGENT_GITHUB_APP_INSTALLATION_ID: "177232772",
        CODING_AGENT_GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
      },
      keyFile,
    );
  } finally {
    removeDir(dir);
  }
}

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

test("secretValues lists every configured credential, including the GitHub App key", () => {
  withAppSettings((appEnv) => {
    const config = loadConfig({
      ...appEnv,
      ANTHROPIC_API_KEY: "sk-ant-key-123456",
      CODING_AGENT_INTENT_TOKEN: "github_pat_intent_123",
      CODING_AGENT_API_TOKEN: "service-token-123",
    });
    assert.equal(config.intentToken, "github_pat_intent_123");
    assert.deepEqual(
      secretValues(config).sort(),
      [privateKey, "github_pat_intent_123", "service-token-123", "sk-ant-key-123456"].sort(),
    );
  });
});

test("loads the GitHub App settings and its private key", () => {
  withAppSettings((appEnv) => {
    const app = loadConfig(appEnv).githubApp;
    assert.equal(app?.appId, "5555873");
    assert.equal(app?.installationId, "177232772");
    assert.equal(app?.privateKey, privateKey);
    assert.equal(app?.apiUrl, "https://api.github.com");
  });
});

test("runs without a GitHub App when none of its settings are present", () => {
  assert.equal(loadConfig({}).githubApp, undefined);
});

test("names the missing GitHub App settings when only some are present", () => {
  assert.throws(
    () => loadConfig({ CODING_AGENT_GITHUB_APP_ID: "5555873" }),
    /also set CODING_AGENT_GITHUB_APP_INSTALLATION_ID, CODING_AGENT_GITHUB_APP_PRIVATE_KEY_FILE/,
  );
});

test("rejects non-numeric GitHub App IDs", () => {
  withAppSettings((appEnv) => {
    assert.throws(
      () => loadConfig({ ...appEnv, CODING_AGENT_GITHUB_APP_ID: "Iv23lighUM0vlezmbCTG" }),
      /numeric App ID/,
    );
    assert.throws(
      () => loadConfig({ ...appEnv, CODING_AGENT_GITHUB_APP_INSTALLATION_ID: "abc" }),
      /numeric installation ID/,
    );
  });
});

test("reports an unreadable or unusable key file by path, never by content", () => {
  withAppSettings((appEnv, keyFile) => {
    assert.throws(
      () => loadConfig({ ...appEnv, CODING_AGENT_GITHUB_APP_PRIVATE_KEY_FILE: `${keyFile}.missing` }),
      /Cannot read the GitHub App private key file .*\.missing \(ENOENT\)/,
    );
  });
  withAppSettings((appEnv) => {
    assert.throws(
      () => loadConfig(appEnv),
      (err: Error) => /does not hold a usable private key/.test(err.message) && !err.message.includes("not-a-key"),
    );
  }, "-----BEGIN RSA PRIVATE KEY-----\nnot-a-key\n-----END RSA PRIVATE KEY-----\n");
});

test("refuses the retired single-token setting", () => {
  assert.throws(() => loadConfig({ CODING_AGENT_GIT_TOKEN: "github_pat_old" }), /no longer used/);
});
