// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for admitting an Execution StageInvocation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { admitInvocation, BlockedError, identityOf } from "./invocation.js";
import { parseManifest } from "./manifest.js";
import { HASH_3, INTENT_REPO, sampleInvocation, SHA_C, TARGET_REPO } from "./testFixtures.js";
import type { StageInvocation } from "./types.js";

const manifest = parseManifest({
  repositories: [{ url: TARGET_REPO, setup: [], checks: { build: "npm run build" } }],
  intent_repositories: [INTENT_REPO],
});

function blockedReasons(invocation: unknown): string[] {
  try {
    admitInvocation(invocation, manifest);
  } catch (err) {
    assert.ok(err instanceof BlockedError);
    return err.reasons;
  }
  assert.fail("expected the invocation to be blocked");
}

test("a well-formed execution invocation is admitted with its inputs classified", () => {
  const admitted = admitInvocation(sampleInvocation(), manifest);
  assert.equal(admitted.branch, "work/INT-MF-0042");
  assert.equal(admitted.spec.path, ".agent/work/INT-MF-0042/spec.md");
  assert.equal(admitted.workContract.path, ".agent/work/INT-MF-0042/work-contract.yaml");
  assert.equal(admitted.evaluation, undefined);
  assert.equal(admitted.evidencePath, ".agent/work/INT-MF-0042/evidence-package/inv-1.json");
  assert.ok(admitted.protectedPaths.includes(".agent/work/INT-MF-0042/intent.md"));
  assert.ok(admitted.protectedPaths.includes(".agent/work/INT-MF-0042/policy-profile.md"));
});

test("an Evaluation Package input is recognized for rework", () => {
  const invocation = sampleInvocation();
  invocation.input_artifacts.push({
    repository: TARGET_REPO,
    commit_sha: SHA_C,
    path: ".agent/work/INT-MF-0042/evaluation-package/eval-1.json",
    sha256: HASH_3,
  });
  const admitted = admitInvocation(invocation, manifest);
  assert.equal(admitted.evaluation?.path, ".agent/work/INT-MF-0042/evaluation-package/eval-1.json");
});

test("a schema-invalid record is blocked", () => {
  const reasons = blockedReasons({ ...sampleInvocation(), schema_version: "1.0" });
  assert.match(reasons[0], /not a valid 1.1 record/);
});

test("another stage is blocked", () => {
  assert.match(blockedReasons({ ...sampleInvocation(), stage: "evaluation" }).join(" "), /execution stage/);
});

test("a work item that differs from the freeze is blocked", () => {
  const invocation = sampleInvocation();
  invocation.work_item = { ...invocation.work_item, intent_version: 2 };
  assert.match(blockedReasons(invocation).join(" "), /does not match the work item of its freeze/);
});

test("a workspace_ref other than the assigned work branch is blocked", () => {
  assert.match(blockedReasons({ ...sampleInvocation(), workspace_ref: "main" }).join(" "), /assigned work branch/);
});

test("an untrusted target or intent repository is blocked", () => {
  const invocation: StageInvocation = sampleInvocation();
  invocation.target = { ...invocation.target, repository: "https://github.com/evil/repo.git" };
  invocation.freeze_activation.intent = {
    ...invocation.freeze_activation.intent,
    repository: "https://github.com/evil/intents.git",
  };
  const reasons = blockedReasons(invocation).join(" ");
  assert.match(reasons, /not in the trusted manifest/);
  assert.match(reasons, /not an allowed intent repository/);
});

test("missing or unrecognized inputs are blocked", () => {
  const invocation = sampleInvocation();
  invocation.input_artifacts = [{ ...invocation.input_artifacts[0], path: "notes/extra.md" }];
  const reasons = blockedReasons(invocation).join(" ");
  assert.match(reasons, /not a recognized Execution input/);
  assert.match(reasons, /spec.md input is missing/);
  assert.match(reasons, /work-contract.yaml input is missing/);
});

test("invalid path scopes and an unauthorized evidence path are blocked", () => {
  const reasons = blockedReasons({ ...sampleInvocation(), write_paths: ["../escape", "src"] }).join(" ");
  assert.match(reasons, /write_paths: Path scope "..\/escape"/);
  assert.match(reasons, /does not authorize the Evidence Package path/);
});

test("identityOf recovers correlation identity from a partly valid record", () => {
  const invocation = sampleInvocation();
  assert.deepEqual(identityOf({ invocation_id: "inv-9", work_item: invocation.work_item, stage: "evaluation" }), {
    invocationId: "inv-9",
    workItem: invocation.work_item,
    stage: "evaluation",
  });
  assert.equal(
    identityOf({ invocation_id: "inv-9", work_item: invocation.work_item, stage: "bogus" })?.stage,
    "execution",
  );
  assert.equal(identityOf({ invocation_id: "inv-9" }), null);
  assert.equal(identityOf("not an object"), null);
});
