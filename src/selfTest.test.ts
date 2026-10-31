// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests for the deployment self-test using local remotes and a stand-in model probe.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import type { GitAccess } from "./git.js";
import { githubAccessChecks, runSelfTest } from "./selfTest.js";
import { buildScenario, removeDir, testShell } from "./testSupport.js";

test("passes when the toolchain, remotes, and model probe all work", async () => {
  const scenario = buildScenario();
  try {
    const config = loadConfig({ CODING_AGENT_SHELL: testShell() });
    const results = await runSelfTest(config, scenario.manifest, async () => "probe ok", scenario.root);
    assert.ok(
      results.every((r) => r.outcome === "pass"),
      JSON.stringify(results),
    );
    assert.ok(results.some((r) => r.name.startsWith("git read access") && /branch\(es\) visible/.test(r.detail)));
  } finally {
    removeDir(scenario.root);
  }
});

test("reports an unreachable remote and a failing model probe without leaking secrets", async () => {
  const scenario = buildScenario();
  try {
    const key = "sk-ant-api03-self-test-secret-999";
    const config = loadConfig({ CODING_AGENT_SHELL: testShell(), ANTHROPIC_API_KEY: key });
    scenario.manifest.intent_repositories.push(`file:///${join(scenario.root, "missing.git").replace(/\\/g, "/")}`);
    const results = await runSelfTest(
      config,
      scenario.manifest,
      async () => {
        throw new Error(`401 invalid x-api-key ${key}`);
      },
      scenario.root,
    );
    const failed = results.filter((r) => r.outcome === "fail");
    assert.equal(failed.length, 2);
    assert.ok(!JSON.stringify(results).includes(key));
  } finally {
    removeDir(scenario.root);
  }
});

const GITHUB_MANIFEST = {
  repositories: [{ url: "https://github.com/dbacks95fan/mealflow.git", setup: ["npm ci"], checks: { b: "npm test" } }],
  intent_repositories: ["https://github.com/dbacks95fan/intent-backlog.git", "file:///C:/local/intents.git"],
};

test("asks the GitHub App for write and read tokens on targets and read on intent repositories", async () => {
  const requests: [string, GitAccess][] = [];
  const results = await githubAccessChecks(
    GITHUB_MANIFEST,
    {
      tokenFor: async (url, access) => {
        requests.push([url, access]);
        return "ghs_issued_token_value_123456";
      },
    },
    [],
  );
  assert.deepEqual(requests, [
    ["https://github.com/dbacks95fan/mealflow.git", "write"],
    ["https://github.com/dbacks95fan/mealflow.git", "read"],
    ["https://github.com/dbacks95fan/intent-backlog.git", "read"],
  ]);
  assert.ok(results.every((r) => r.outcome === "pass"));
  assert.equal(results.length, 3, "the local intent repository needs no token");
});

test("fails each GitHub check when no app is configured or a token is refused", async () => {
  const unconfigured = await githubAccessChecks(GITHUB_MANIFEST, undefined, []);
  assert.equal(unconfigured.length, 3);
  assert.ok(unconfigured.every((r) => r.outcome === "fail" && /No GitHub App is configured/.test(r.detail)));

  const leaked = "ghs_leaked_value_in_error_123456";
  const refused = await githubAccessChecks(
    GITHUB_MANIFEST,
    {
      tokenFor: async (_url, access) => {
        if (access === "write") throw new Error(`HTTP 422 while holding ${leaked}`);
        return "ghs_issued_token_value_123456";
      },
    },
    [],
  );
  assert.deepEqual(
    refused.map((r) => r.outcome),
    ["fail", "pass", "pass"],
  );
  assert.ok(!JSON.stringify(refused).includes(leaked));
});
