// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Live end-to-end test against the real Claude API; spends money, so it runs only via `npm run test:live`.
// ABOUTME: Requires ANTHROPIC_API_KEY. Uses local Git remotes, so no GitHub access is needed.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { AnthropicModelClient } from "./agentLoop.js";
import { loadConfig } from "./config.js";
import { validateRecord } from "./lifecycle.js";
import { createLogger } from "./log.js";
import { executeInvocation } from "./run.js";
import { buildScenario, removeDir, testShell } from "./testSupport.js";

test("a real model implements a small accepted contract and the candidate is pushed", async () => {
  assert.ok(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY must be set for the live test");
  const scenario = buildScenario({ checks: { build: "grep -qx 'hello, world' src/greeting.txt" } });
  try {
    const config = loadConfig({
      ...process.env,
      CODING_AGENT_SHELL: testShell(),
      CODING_AGENT_WORK_ROOT: join(scenario.root, "work"),
      CODING_AGENT_MAX_TURNS: process.env.CODING_AGENT_MAX_TURNS ?? "25",
      CODING_AGENT_MAX_COST_USD: process.env.CODING_AGENT_MAX_COST_USD ?? "1.5",
    });
    const outcome = await executeInvocation(scenario.invocation, {
      config,
      manifest: scenario.manifest,
      model: new AnthropicModelClient(config),
      log: createLogger([config.anthropicApiKey ?? ""]),
    });
    process.stdout.write(`${JSON.stringify(outcome.diagnostics.agent, null, 2)}\n`);
    const result = outcome.stageResult!;
    assert.equal(result.status, "candidate_complete", JSON.stringify(outcome.diagnostics.reasons));
    assert.equal(validateRecord("StageResult", result).valid, true);
    assert.equal(scenario.product.show(result.candidate!.commit_sha, "src/greeting.txt"), "hello, world");
    assert.equal(scenario.product.tip("work/INT-T-0001"), result.output_artifacts[0].commit_sha);
  } finally {
    removeDir(scenario.root);
  }
});
