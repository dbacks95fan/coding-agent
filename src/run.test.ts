// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Integration tests for a full Execution run against real Git remotes with a scripted model.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.js";
import { validateRecord } from "./lifecycle.js";
import { silentLogger } from "./log.js";
import { executeInvocation, type RunOutcome } from "./run.js";
import {
  buildScenario,
  completeReport,
  git,
  message,
  removeDir,
  ScriptedClient,
  sha256,
  testShell,
  toolUse,
  type Scenario,
  type ScenarioOptions,
} from "./testSupport.js";

const WORK = ".agent/work/INT-T-0001";
const editGreeting = () =>
  message([
    toolUse("e1", "str_replace_based_edit_tool", {
      command: "str_replace",
      path: "src/greeting.txt",
      old_str: "hello",
      new_str: "hello, world",
    }),
  ]);
const report = (overrides: Partial<typeof completeReport> = {}) =>
  message([toolUse("r1", "submit_report", { ...completeReport, ...overrides })]);

async function run(scenario: Scenario, client: ScriptedClient, env: Record<string, string> = {}): Promise<RunOutcome> {
  const config = loadConfig({
    CODING_AGENT_SHELL: testShell(),
    CODING_AGENT_WORK_ROOT: join(scenario.root, "work"),
    CODING_AGENT_MAX_TURNS: "10",
    ...env,
  });
  return executeInvocation(scenario.invocation, {
    config,
    manifest: scenario.manifest,
    model: client,
    log: silentLogger,
  });
}

function withScenario(name: string, options: ScenarioOptions, body: (scenario: Scenario) => Promise<void>): void {
  test(name, async () => {
    const scenario = buildScenario(options);
    try {
      await body(scenario);
    } finally {
      removeDir(scenario.root);
    }
  });
}

const greetingCheck = { checks: { build: "grep -q 'hello, world' src/greeting.txt" } };

withScenario(
  "a successful run pushes a candidate and its Evidence Package to the work branch",
  greetingCheck,
  async (scenario) => {
    const outcome = await run(scenario, new ScriptedClient([editGreeting(), report()]));
    const result = outcome.stageResult!;
    assert.equal(result.status, "candidate_complete", JSON.stringify(outcome.diagnostics));
    assert.equal(validateRecord("StageResult", result).valid, true);
    assert.equal(result.invocation_id, scenario.invocation.invocation_id);

    const evidenceRef = result.output_artifacts[0];
    const tip = scenario.product.tip("work/INT-T-0001");
    assert.equal(tip, evidenceRef.commit_sha);
    assert.equal(git(scenario.product.bare, ["rev-parse", `${tip}^`]), result.candidate!.commit_sha);
    assert.equal(git(scenario.product.bare, ["rev-parse", `${result.candidate!.commit_sha}^`]), scenario.handoff);
    assert.equal(evidenceRef.path, `${WORK}/evidence-package/inv-t-1.json`);

    const published = scenario.product.show(tip, evidenceRef.path) + "\n";
    assert.equal(sha256(published), evidenceRef.sha256);
    const evidence = JSON.parse(published);
    assert.equal(validateRecord("EvidencePackage", evidence).valid, true);
    assert.equal(evidence.candidate.commit_sha, result.candidate!.commit_sha);
    assert.deepEqual(evidence.changed_paths, ["src/greeting.txt"]);
    assert.equal(evidence.validation[0].outcome, "passed");
    assert.equal(evidence.policy_control_evidence[0].outcome, "addressed");
    assert.equal(scenario.product.show(result.candidate!.commit_sha, "src/greeting.txt"), "hello, world");
  },
);

withScenario(
  "a failing required check is reported as failed and nothing is pushed",
  greetingCheck,
  async (scenario) => {
    const wrongEdit = message([
      toolUse("e1", "str_replace_based_edit_tool", {
        command: "str_replace",
        path: "src/greeting.txt",
        old_str: "hello",
        new_str: "goodbye",
      }),
    ]);
    const outcome = await run(scenario, new ScriptedClient([wrongEdit, report()]));
    assert.equal(outcome.stageResult!.status, "failed");
    assert.match(outcome.stageResult!.findings!.join(" "), /Required check build failed/);
    assert.equal(scenario.product.tip("work/INT-T-0001"), scenario.handoff);
    assert.equal(outcome.evidencePackage, null);
  },
);

withScenario(
  "changes outside write_paths fail the run even when the agent claims success",
  greetingCheck,
  async (scenario) => {
    const sneaky = message([toolUse("b1", "bash", { command: "echo changed >> README.md" })]);
    const outcome = await run(scenario, new ScriptedClient([editGreeting(), sneaky, report()]));
    assert.equal(outcome.stageResult!.status, "failed");
    assert.match(outcome.stageResult!.findings!.join(" "), /Changed README.md/);
    assert.equal(scenario.product.tip("work/INT-T-0001"), scenario.handoff);
  },
);

withScenario("altering a frozen input through the shell fails the run", { ...greetingCheck }, async (scenario) => {
  scenario.invocation.write_paths = ["src", WORK];
  const tamper = message([toolUse("b1", "bash", { command: `echo tampered >> ${WORK}/intent.md` })]);
  const outcome = await run(scenario, new ScriptedClient([editGreeting(), tamper, report()]));
  assert.equal(outcome.stageResult!.status, "failed");
  assert.match(outcome.stageResult!.findings!.join(" "), /Changed .*intent\.md/);
});

withScenario("a needs_decision report returns the decision without pushing", greetingCheck, async (scenario) => {
  const decision = report({
    status: "needs_decision",
    decisions_needed: [{ question: "Should the greeting be localized?", options: ["Yes", "No"], recommendation: "No" }],
  });
  const outcome = await run(scenario, new ScriptedClient([decision]));
  assert.equal(outcome.stageResult!.status, "needs_decision");
  assert.match(outcome.stageResult!.findings![0], /Should the greeting be localized\?/);
  assert.equal(scenario.product.tip("work/INT-T-0001"), scenario.handoff);
});

withScenario("a preflight failure blocks before any model call", greetingCheck, async (scenario) => {
  scenario.manifest.repositories[0].checks = { build: "something else" };
  const client = new ScriptedClient([]);
  const outcome = await run(scenario, client);
  assert.equal(outcome.stageResult!.status, "blocked");
  assert.equal(client.requests.length, 0);
  assert.match(outcome.stageResult!.findings!.join(" "), /trusted command/);
});

withScenario("a failing setup command blocks the run", { ...greetingCheck, setup: ["exit 7"] }, async (scenario) => {
  const client = new ScriptedClient([]);
  const outcome = await run(scenario, client);
  assert.equal(outcome.stageResult!.status, "blocked");
  assert.match(outcome.stageResult!.findings!.join(" "), /Setup command "exit 7" exited with 7/);
  assert.equal(client.requests.length, 0);
});

withScenario("a branch that moves during the run blocks the push", greetingCheck, async (scenario) => {
  const concurrent = async () => {
    scenario.product.commit({ "src/other.txt": "x" }, "concurrent writer", "work/INT-T-0001");
    return report();
  };
  const outcome = await run(scenario, new ScriptedClient([editGreeting(), concurrent]));
  assert.equal(outcome.stageResult!.status, "blocked");
  assert.match(outcome.stageResult!.findings!.join(" "), /work branch moved/);
});

withScenario("Git config planted by the agent's shell cannot redirect the push", greetingCheck, async (scenario) => {
  const plant = message([
    toolUse("b1", "bash", {
      command: `printf '[url "file:///nonexistent/"]\\n\\tinsteadOf = file:///\\n' >> .git/config`,
    }),
  ]);
  const outcome = await run(scenario, new ScriptedClient([editGreeting(), plant, report()]));
  assert.equal(outcome.stageResult!.status, "candidate_complete", JSON.stringify(outcome.diagnostics.reasons));
  assert.equal(scenario.product.tip("work/INT-T-0001"), outcome.stageResult!.output_artifacts[0].commit_sha);
});

withScenario("rework carries the Evaluator's findings to the model", greetingCheck, async (scenario) => {
  const findingsText = JSON.stringify({
    schema_version: "1.0",
    work_item: scenario.invocation.work_item,
    input_artifacts: scenario.invocation.input_artifacts,
    candidate: { repository: scenario.product.url, commit_sha: scenario.handoff },
    checks: [{ name: "build", outcome: "failed", observed_at: "2026-10-27T11:00:00Z", summary: "greeting wrong" }],
    findings: [{ category: "implementation", severity: "blocking", summary: "The greeting must read 'hello, world'." }],
    status: "fail",
    summary: "Rework needed.",
  });
  const path = `${WORK}/evaluation-package/eval-1.json`;
  const evalCommit = scenario.product.commit({ [path]: findingsText }, "evaluation", "work/INT-T-0001");
  scenario.invocation.target.commit_sha = evalCommit;
  scenario.invocation.input_artifacts.push({
    repository: scenario.product.url,
    commit_sha: evalCommit,
    path,
    sha256: sha256(findingsText),
  });

  const client = new ScriptedClient([editGreeting(), report()]);
  const outcome = await run(scenario, client);
  assert.equal(outcome.stageResult!.status, "candidate_complete", JSON.stringify(outcome.diagnostics.reasons));
  assert.match(String(client.requests[0].messages[0].content), /The greeting must read 'hello, world'\./);
  assert.equal(git(scenario.product.bare, ["rev-parse", `${outcome.stageResult!.candidate!.commit_sha}^`]), evalCommit);
});

withScenario("secrets are redacted from results even if the model repeats them", greetingCheck, async (scenario) => {
  const key = "sk-ant-api03-test-secret-value-123456";
  const outcome = await run(
    scenario,
    new ScriptedClient([editGreeting(), report({ summary: `I saw ${key} somewhere.` })]),
    {
      ANTHROPIC_API_KEY: key,
    },
  );
  assert.equal(outcome.stageResult!.status, "candidate_complete", JSON.stringify(outcome.diagnostics.reasons));
  assert.ok(!JSON.stringify(outcome.stageResult).includes(key));
  assert.ok(!JSON.stringify(outcome.evidencePackage).includes(key));
});

test("input that cannot be correlated returns no StageResult", async () => {
  const config = loadConfig({ CODING_AGENT_SHELL: testShell() });
  const outcome = await executeInvocation(
    { hello: "world" },
    {
      config,
      manifest: { repositories: [], intent_repositories: [] },
      model: new ScriptedClient([]),
      log: silentLogger,
    },
  );
  assert.equal(outcome.stageResult, null);
});
