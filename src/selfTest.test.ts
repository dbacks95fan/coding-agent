// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests for the deployment self-test using local remotes and a stand-in model probe.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { runSelfTest } from "./selfTest.js";
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
