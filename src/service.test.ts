// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Tests for the HTTP boundary, including an end-to-end run submitted and polled over HTTP.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { validateRecord } from "./lifecycle.js";
import { silentLogger } from "./log.js";
import { executeInvocation, type RunOutcome } from "./run.js";
import { createService, type ServiceDeps } from "./service.js";
import {
  buildScenario,
  completeReport,
  message,
  removeDir,
  ScriptedClient,
  testShell,
  toolUse,
} from "./testSupport.js";
import { sampleInvocation } from "./testFixtures.js";

const TOKEN = "service-test-token-0123456789";

async function withService(overrides: Partial<ServiceDeps>, body: (base: string) => Promise<void>): Promise<void> {
  const server = createService({
    apiToken: TOKEN,
    secrets: [TOKEN],
    log: silentLogger,
    execute: async () => ({
      stageResult: null,
      evidencePackage: null,
      diagnostics: { reasons: [], changedPaths: [], validation: [] },
    }),
    selfTest: async () => [{ name: "x", outcome: "pass", detail: "ok" }],
    ...overrides,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await body(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function poll(base: string, id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 600; i++) {
    const body = (await (await fetch(`${base}/invocations/${id}`, { headers: auth })).json()) as Record<
      string,
      unknown
    >;
    if (body.state === "done") return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("run did not finish");
}

test("health is public; everything else requires the bearer token", async () => {
  await withService({}, async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", busy: false });
    assert.equal((await fetch(`${base}/invocations/x`)).status, 401);
    assert.equal((await fetch(`${base}/invocations/x`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(`${base}/invocations/x`, { headers: auth })).status, 404);
  });
});

test("malformed bodies are rejected with 400", async () => {
  await withService({}, async (base) => {
    assert.equal((await fetch(`${base}/invocations`, { method: "POST", headers: auth, body: "{" })).status, 400);
    assert.equal((await fetch(`${base}/invocations`, { method: "POST", headers: auth, body: "{}" })).status, 400);
  });
});

test("resubmitting is idempotent, conflicting content is refused, and only one run proceeds at a time", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const calls: unknown[] = [];
  const execute = async (raw: unknown): Promise<RunOutcome> => {
    calls.push(raw);
    await gate;
    return {
      stageResult: null,
      evidencePackage: null,
      diagnostics: { reasons: ["done"], changedPaths: [], validation: [] },
    };
  };
  await withService({ execute }, async (base) => {
    const invocation = sampleInvocation();
    const post = (body: unknown) =>
      fetch(`${base}/invocations`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    assert.equal((await post(invocation)).status, 202);
    assert.equal((await post(invocation)).status, 202);
    assert.equal((await post({ ...invocation, trigger_event_id: "other" })).status, 409);
    const busy = await post({ ...invocation, invocation_id: "inv-2" });
    assert.equal(busy.status, 409);
    assert.equal(((await busy.json()) as { error: string }).error, "busy");
    release();
    await poll(base, "inv-1");
    assert.equal(calls.length, 1);
    assert.equal((await post(invocation)).status, 200);
  });
});

test("self-test reports 503 when any check fails", async () => {
  await withService({ selfTest: async () => [{ name: "model", outcome: "fail", detail: "no key" }] }, async (base) => {
    assert.equal((await fetch(`${base}/self-test`, { method: "POST", headers: auth })).status, 503);
  });
});

test("end to end: an invocation submitted over HTTP produces a pushed candidate and a valid StageResult", async () => {
  const scenario = buildScenario({ checks: { build: "grep -q 'hello, world' src/greeting.txt" } });
  try {
    const config = loadConfig({ CODING_AGENT_SHELL: testShell(), CODING_AGENT_WORK_ROOT: join(scenario.root, "work") });
    const model = new ScriptedClient([
      message([
        toolUse("e1", "str_replace_based_edit_tool", {
          command: "str_replace",
          path: "src/greeting.txt",
          old_str: "hello",
          new_str: "hello, world",
        }),
      ]),
      message([toolUse("r1", "submit_report", completeReport)]),
    ]);
    const execute = (raw: unknown) =>
      executeInvocation(raw, { config, manifest: scenario.manifest, model, log: silentLogger });
    await withService({ execute }, async (base) => {
      const submitted = await fetch(`${base}/invocations`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(scenario.invocation),
      });
      assert.equal(submitted.status, 202);
      const done = await poll(base, scenario.invocation.invocation_id);
      const stageResult = done.stage_result as { status: string; output_artifacts: { commit_sha: string }[] };
      assert.equal(stageResult.status, "candidate_complete", JSON.stringify(done.diagnostics));
      assert.equal(validateRecord("StageResult", stageResult).valid, true);
      assert.equal(validateRecord("EvidencePackage", done.evidence_package).valid, true);
      assert.equal(scenario.product.tip("work/INT-T-0001"), stageResult.output_artifacts[0].commit_sha);
    });
  } finally {
    removeDir(scenario.root);
  }
});
