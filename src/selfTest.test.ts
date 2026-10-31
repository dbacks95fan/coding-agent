// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests for the deployment self-test using local remotes and a stand-in model probe.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import type { GitAccess } from "./git.js";
import { githubAccessChecks, judgeReadOnlyProbe, runSelfTest } from "./selfTest.js";
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

test("asks the GitHub App for write and read tokens on target repositories only", async () => {
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
  ]);
  assert.ok(results.every((r) => r.outcome === "pass"));
  assert.equal(results.length, 2, "intent repositories use their own token, checked separately");
});

test("fails each GitHub check when no app is configured or a token is refused", async () => {
  const unconfigured = await githubAccessChecks(GITHUB_MANIFEST, undefined, []);
  assert.equal(unconfigured.length, 2);
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
    ["fail", "pass"],
  );
  assert.ok(!JSON.stringify(refused).includes(leaked));
});

test("the read-only probe passes only when GitHub refuses the push", () => {
  assert.match(
    judgeReadOnlyProbe(new Error("git push failed: remote: Write access to repository not granted.")),
    /refused/,
  );
  assert.match(judgeReadOnlyProbe(new Error("remote: Permission to x/y.git denied to someone.")), /refused/);
  assert.match(judgeReadOnlyProbe(new Error("The requested URL returned error: 403")), /refused/);
  assert.throws(() => judgeReadOnlyProbe(undefined), /accepted, so it can write/);
  assert.throws(
    () => judgeReadOnlyProbe(new Error("Could not resolve host: github.com")),
    /could not reach GitHub: Could not resolve host/,
  );
});
