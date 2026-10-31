// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Integration tests for workspace preflight against real Git repositories.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DriverGit } from "./git.js";
import { admitInvocation, BlockedError } from "./invocation.js";
import { prepareWorkspace } from "./preflight.js";
import { buildScenario, removeDir, sha256, type Scenario } from "./testSupport.js";

function driverFor(scenario: Scenario): DriverGit {
  return new DriverGit(join(scenario.root, "driver-home"), { name: "coding-agent", email: "agent@example.com" });
}

async function blockedReasons(scenario: Scenario, runName: string): Promise<string> {
  const admitted = admitInvocation(scenario.invocation, scenario.manifest);
  try {
    await prepareWorkspace(admitted, driverFor(scenario), join(scenario.root, runName));
  } catch (err) {
    assert.ok(err instanceof BlockedError, String(err));
    return err.reasons.join(" ");
  }
  assert.fail("expected preflight to block");
}

test("a consistent handoff is verified and its inputs are returned", async () => {
  const scenario = buildScenario();
  try {
    const admitted = admitInvocation(scenario.invocation, scenario.manifest);
    const verified = await prepareWorkspace(admitted, driverFor(scenario), join(scenario.root, "run"));
    assert.equal(verified.handoff, scenario.handoff);
    assert.equal(verified.intentText, scenario.intentText);
    assert.equal(verified.workContract.schema_version, 3);
    assert.match(verified.specText, /hello, world/);
    assert.equal(verified.inputArtifacts.length, 4);
  } finally {
    removeDir(scenario.root);
  }
});

test("a branch that moved past the handoff is blocked", async () => {
  const scenario = buildScenario();
  try {
    scenario.product.commit({ "src/other.txt": "x" }, "concurrent writer", "work/INT-T-0001");
    assert.match(await blockedReasons(scenario, "run"), /another writer may have pushed/);
  } finally {
    removeDir(scenario.root);
  }
});

test("a spec edited after acceptance is blocked", async () => {
  const scenario = buildScenario();
  try {
    const edited = scenario.product.commit(
      { ".agent/work/INT-T-0001/spec.md": "# Spec\n\nSomething else.\n" },
      "edit spec",
      "work/INT-T-0001",
    );
    scenario.invocation.target.commit_sha = edited;
    assert.match(await blockedReasons(scenario, "run"), /spec.md has changed since its accepted commit/);
  } finally {
    removeDir(scenario.root);
  }
});

test("a frozen intent copy whose bytes changed (line endings) is blocked", async () => {
  const scenario = buildScenario();
  try {
    const converted = scenario.product.commit(
      { ".agent/work/INT-T-0001/intent.md": scenario.intentText.replace(/\r\n/g, "\n") },
      "line endings converted",
      "work/INT-T-0001",
    );
    scenario.invocation.target.commit_sha = converted;
    assert.match(await blockedReasons(scenario, "run"), /frozen intent copy .* does not match its recorded SHA-256/);
  } finally {
    removeDir(scenario.root);
  }
});

test("a frozen source that cannot be fetched from the intent backlog is blocked", async () => {
  const scenario = buildScenario();
  try {
    scenario.invocation.freeze_activation.policy_profile.commit_sha = "f".repeat(40);
    const reasons = await blockedReasons(scenario, "run");
    assert.match(reasons, /Could not fetch frozen source/);
    assert.match(reasons, /policy profile does not match the active freeze/);
  } finally {
    removeDir(scenario.root);
  }
});

test("a Work Contract that disagrees with the freeze is blocked", async () => {
  const scenario = buildScenario();
  try {
    scenario.invocation.freeze_activation.policy_profile_version = "2";
    assert.match(await blockedReasons(scenario, "run"), /policy profile does not match the active freeze/);
  } finally {
    removeDir(scenario.root);
  }
});

test("a required check whose command is not trusted is blocked", async () => {
  const scenario = buildScenario();
  try {
    scenario.manifest.repositories[0].checks = { build: "npm run build" };
    assert.match(await blockedReasons(scenario, "run"), /trusted command is "npm run build"/);
  } finally {
    removeDir(scenario.root);
  }
});

test("rework accepts a failed Evaluation Package and rejects a passing one", async () => {
  const scenario = buildScenario();
  try {
    const work = ".agent/work/INT-T-0001";
    const evaluation = (status: "fail" | "pass") =>
      JSON.stringify({
        schema_version: "1.0",
        work_item: scenario.invocation.work_item,
        input_artifacts: scenario.invocation.input_artifacts,
        candidate: { repository: scenario.product.url, commit_sha: scenario.handoff },
        checks: [{ name: "build", outcome: "passed", observed_at: "2026-10-27T11:00:00Z", summary: "ok" }],
        findings: [
          {
            category: "implementation",
            severity: status === "fail" ? "blocking" : "non_blocking",
            summary: "Greeting is still 'hello'.",
          },
        ],
        status,
        summary: "Evaluated.",
      });
    const failText = evaluation("fail");
    const evalCommit = scenario.product.commit(
      { [`${work}/evaluation-package/eval-1.json`]: failText },
      "eval",
      "work/INT-T-0001",
    );
    scenario.invocation.target.commit_sha = evalCommit;
    scenario.invocation.input_artifacts.push({
      repository: scenario.product.url,
      commit_sha: evalCommit,
      path: `${work}/evaluation-package/eval-1.json`,
      sha256: sha256(failText),
    });
    const admitted = admitInvocation(scenario.invocation, scenario.manifest);
    const verified = await prepareWorkspace(admitted, driverFor(scenario), join(scenario.root, "run-fail"));
    assert.equal(verified.evaluation?.findings[0].summary, "Greeting is still 'hello'.");

    const passText = evaluation("pass");
    const passCommit = scenario.product.commit(
      { [`${work}/evaluation-package/eval-2.json`]: passText },
      "eval 2",
      "work/INT-T-0001",
    );
    scenario.invocation.target.commit_sha = passCommit;
    scenario.invocation.input_artifacts[2] = {
      repository: scenario.product.url,
      commit_sha: passCommit,
      path: `${work}/evaluation-package/eval-2.json`,
      sha256: sha256(passText),
    };
    assert.match(await blockedReasons(scenario, "run-pass"), /Only a failed evaluation routes back to Execution/);
  } finally {
    removeDir(scenario.root);
  }
});
