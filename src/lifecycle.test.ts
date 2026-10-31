// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for canonical lifecycle schema validation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LIFECYCLE_SCHEMA_ID, schemaId, validateRecord } from "./lifecycle.js";
import { sampleInvocation, sampleWorkContract } from "./testFixtures.js";

test("the vendored schema is the version this worker was built against", () => {
  assert.equal(schemaId(), LIFECYCLE_SCHEMA_ID);
});

test("a complete StageInvocation 1.1 validates", () => {
  const result = validateRecord("StageInvocation", sampleInvocation());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("StageInvocation 1.0 is rejected rather than coerced", () => {
  const invocation = { ...sampleInvocation(), schema_version: "1.0" };
  assert.equal(validateRecord("StageInvocation", invocation).valid, false);
});

test("a StageInvocation without freeze_activation is rejected", () => {
  const { freeze_activation: _removed, ...invocation } = sampleInvocation();
  const result = validateRecord("StageInvocation", invocation);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("freeze_activation")));
});

test("format constraints are enforced, not just types", () => {
  const invocation = sampleInvocation();
  invocation.freeze_activation.recorded_at = "yesterday";
  const result = validateRecord("StageInvocation", invocation);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("date-time")));
});

test("Work Contract v3 validates and v2 does not", () => {
  assert.equal(validateRecord("WorkContract", sampleWorkContract()).valid, true);
  assert.equal(validateRecord("WorkContract", { ...sampleWorkContract(), schema_version: 2 }).valid, false);
});

test("the published example invocation is a valid StageInvocation 1.1", () => {
  const example: unknown = JSON.parse(readFileSync("examples/stage-invocation.example.json", "utf8"));
  assert.deepEqual(validateRecord("StageInvocation", example).errors, []);
});

test("unknown properties are rejected", () => {
  assert.equal(validateRecord("WorkContract", { ...sampleWorkContract(), objective: "extra" }).valid, false);
});
