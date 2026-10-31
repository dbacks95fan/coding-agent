// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for status decisions and canonical record construction.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopOutcome } from "./agentLoop.js";
import { buildStageResult, postValidationVerdict, preValidationVerdict, scopeViolations } from "./evidence.js";
import { validateRecord } from "./lifecycle.js";
import { sampleWorkContract, sampleWorkItem } from "./testFixtures.js";
import { completeReport } from "./testSupport.js";

const loop = (partial: Partial<LoopOutcome> = {}): LoopOutcome => ({
  report: { ...completeReport },
  limitHit: null,
  refused: false,
  turns: 3,
  costUsd: 0.1,
  durationMs: 1000,
  models: ["claude-opus-5-5"],
  ...partial,
});
const contract = sampleWorkContract();

test("a complete, consistent report proceeds to validation", () => {
  const verdict = preValidationVerdict(loop(), contract, ["src/a.ts"], []);
  assert.equal(verdict.status, "candidate_complete");
  assert.equal(verdict.validate, true);
});

test("limits, refusals, and missing reports never reach validation", () => {
  assert.equal(preValidationVerdict(loop({ limitHit: "max_cost" }), contract, ["src/a.ts"], []).status, "blocked");
  assert.equal(preValidationVerdict(loop({ refused: true }), contract, ["src/a.ts"], []).status, "failed");
  assert.equal(
    preValidationVerdict(loop({ report: null, problem: "no report" }), contract, ["src/a.ts"], []).status,
    "failed",
  );
});

test("scope violations fail the run even when the agent claims success", () => {
  const verdict = preValidationVerdict(
    loop(),
    contract,
    ["README.md"],
    ["Changed README.md, which this invocation does not authorize."],
  );
  assert.equal(verdict.status, "failed");
  assert.match(verdict.reasons[0], /README.md/);
});

test("the agent's own needs_decision, blocked, and failed statuses are respected", () => {
  const decision = {
    ...completeReport,
    status: "needs_decision" as const,
    decisions_needed: [{ question: "Which copy?", options: ["A", "B"], recommendation: "A" }],
  };
  const verdict = preValidationVerdict(loop({ report: decision }), contract, ["src/a.ts"], []);
  assert.equal(verdict.status, "needs_decision");
  assert.match(verdict.reasons[0], /Which copy\? Options: A \| B\. Recommendation: A/);
  assert.equal(
    preValidationVerdict(loop({ report: { ...completeReport, status: "blocked" } }), contract, ["src/a.ts"], []).status,
    "blocked",
  );
  assert.equal(
    preValidationVerdict(loop({ report: { ...completeReport, status: "failed" } }), contract, ["src/a.ts"], []).status,
    "failed",
  );
});

test("an unsatisfied or unreported acceptance criterion fails a claimed completion", () => {
  const partial = {
    ...completeReport,
    acceptance_criteria: [{ index: 0, status: "partial" as const, evidence: "half done" }],
  };
  assert.equal(preValidationVerdict(loop({ report: partial }), contract, ["src/a.ts"], []).status, "failed");
  const missing = { ...completeReport, acceptance_criteria: [] };
  assert.match(
    preValidationVerdict(loop({ report: missing }), contract, ["src/a.ts"], []).reasons[0],
    /did not report acceptance criterion \[0\]/,
  );
});

test("policy controls must all be reported, and a flagged control needs a decision", () => {
  const missing = { ...completeReport, policy_controls: [] };
  assert.equal(preValidationVerdict(loop({ report: missing }), contract, ["src/a.ts"], []).status, "failed");
  const flagged = {
    ...completeReport,
    policy_controls: [
      { control_id: "SEC-BASE-001", outcome: "needs_decision" as const, summary: "needs a secret store" },
    ],
  };
  assert.equal(preValidationVerdict(loop({ report: flagged }), contract, ["src/a.ts"], []).status, "needs_decision");
});

test("a claimed completion with no changes asks a person", () => {
  assert.equal(preValidationVerdict(loop(), contract, [], []).status, "needs_decision");
});

test("every required check must have passed", () => {
  const passed = [{ name: "build", outcome: "passed" as const, observed_at: "2026-10-27T10:00:00Z", summary: "ok" }];
  assert.equal(postValidationVerdict(contract, passed).status, "candidate_complete");
  assert.equal(postValidationVerdict(contract, [{ ...passed[0], outcome: "failed" }]).status, "failed");
  assert.match(postValidationVerdict(contract, []).reasons[0], /no recorded outcome/);
});

test("scopeViolations flags paths outside write_paths and protected artifacts", () => {
  const rules = {
    writePaths: ["src", ".agent/work/X"],
    protectedPaths: [".agent/work/X/intent.md"],
    protectedPrefixes: [".agent/work/X/evidence-package/"],
  };
  assert.deepEqual(scopeViolations(["src/a.ts"], rules), []);
  assert.equal(
    scopeViolations(["README.md", ".agent/work/X/intent.md", ".agent/work/X/evidence-package/a.json"], rules).length,
    3,
  );
});

test("built StageResults satisfy the canonical schema for each status", () => {
  const base = { invocationId: "inv-1", workItem: sampleWorkItem(), summary: "s" };
  for (const status of ["needs_decision", "blocked", "failed"] as const) {
    assert.equal(
      validateRecord("StageResult", buildStageResult({ ...base, status, findings: ["why"] })).valid,
      true,
      status,
    );
  }
  const complete = buildStageResult({
    ...base,
    status: "candidate_complete",
    candidate: { repository: "https://github.com/example/x.git", commit_sha: "a".repeat(40) },
    outputArtifacts: [
      {
        repository: "https://github.com/example/x.git",
        commit_sha: "b".repeat(40),
        path: "e.json",
        sha256: "c".repeat(64),
      },
    ],
  });
  assert.equal(validateRecord("StageResult", complete).valid, true);
  assert.equal(validateRecord("StageResult", buildStageResult({ ...base, status: "candidate_complete" })).valid, false);
});
