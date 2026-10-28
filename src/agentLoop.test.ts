// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for the agent loop using a scripted model client.
import type Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { runAgentLoop, turnCost } from "./agentLoop.js";
import { sandboxEnv } from "./commands.js";
import {
  completeReport,
  message,
  removeDir,
  ScriptedClient,
  tempDir,
  testShell,
  toolUse,
  writeBytes,
} from "./testSupport.js";
import type { ToolContext } from "./tools.js";

type Message = Anthropic.Beta.BetaMessage;

let workspace: string;
let tools: ToolContext;
const prices = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
const limits = { maxTurns: 10, maxCostUsd: 5, maxRuntimeMs: 60_000 };

before(() => {
  workspace = tempDir("loop-");
  writeBytes(workspace, "src/greeting.txt", "hello\n");
  tools = {
    workspace,
    readPaths: ["."],
    writePaths: ["src"],
    protectedPaths: [],
    protectedPrefixes: [],
    shell: testShell(),
    env: sandboxEnv(workspace),
    bashTimeoutMs: 30_000,
    maxOutputChars: 10_000,
  };
});

after(() => removeDir(workspace));

test("runs editor and bash tools, then ends on a valid report", async () => {
  const client = new ScriptedClient([
    message([
      toolUse("t1", "str_replace_based_edit_tool", {
        command: "str_replace",
        path: "src/greeting.txt",
        old_str: "hello",
        new_str: "hello, world",
      }),
    ]),
    message([toolUse("t2", "bash", { command: "cat src/greeting.txt" })]),
    message([toolUse("t3", "submit_report", completeReport)]),
  ]);
  const outcome = await runAgentLoop({ client, system: "rules", firstMessage: "work", tools, limits, prices });
  assert.deepEqual(outcome.report, completeReport);
  assert.equal(outcome.turns, 3);
  assert.equal(readFileSync(join(workspace, "src/greeting.txt"), "utf8"), "hello, world\n");
  const bashResult = client.requests[2].messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
  assert.match(String(bashResult[0].content), /hello, world/);
  assert.equal(client.requests[0].messages.length, 1);
  assert.equal(client.requests[1].messages.length, 3);
});

test("an invalid report is returned to the model as an error so it can correct it", async () => {
  const client = new ScriptedClient([
    message([toolUse("t1", "submit_report", { status: "done" })]),
    message([toolUse("t2", "submit_report", completeReport)]),
  ]);
  const outcome = await runAgentLoop({ client, system: "rules", firstMessage: "work", tools, limits, prices });
  assert.deepEqual(outcome.report, completeReport);
  const firstResult = client.requests[1].messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
  assert.equal(firstResult[0].is_error, true);
  assert.match(String(firstResult[0].content), /report is invalid/);
});

test("a model that stops without reporting is nudged once, then recorded as a problem", async () => {
  const text = { type: "text", text: "All done!" } as Anthropic.Beta.BetaContentBlock;
  const client = new ScriptedClient([message([text], "end_turn"), message([text], "end_turn")]);
  const outcome = await runAgentLoop({ client, system: "rules", firstMessage: "work", tools, limits, prices });
  assert.equal(outcome.report, null);
  assert.match(outcome.problem ?? "", /without calling submit_report/);
  assert.equal(client.requests.length, 2);
});

test("the turn limit stops the loop", async () => {
  const bash = () => message([toolUse("t", "bash", { command: "true" })]);
  const client = new ScriptedClient([bash(), bash(), bash()]);
  const outcome = await runAgentLoop({
    client,
    system: "rules",
    firstMessage: "work",
    tools,
    limits: { ...limits, maxTurns: 2 },
    prices,
  });
  assert.equal(outcome.limitHit, "max_turns");
  assert.equal(outcome.turns, 2);
});

test("the cost ceiling stops the loop", async () => {
  const bash = () => message([toolUse("t", "bash", { command: "true" })]);
  const client = new ScriptedClient([bash(), bash(), bash()]);
  // Each scripted turn costs 1000*$4/M + 100*$20/M = $0.006.
  const outcome = await runAgentLoop({
    client,
    system: "rules",
    firstMessage: "work",
    tools,
    limits: { ...limits, maxCostUsd: 0.01 },
    prices,
  });
  assert.equal(outcome.limitHit, "max_cost");
  assert.equal(outcome.turns, 2);
});

test("the wall-clock limit aborts an in-flight request", async () => {
  const hang = (signal: AbortSignal) =>
    new Promise<Message>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const client = new ScriptedClient([hang]);
  const outcome = await runAgentLoop({
    client,
    system: "rules",
    firstMessage: "work",
    tools,
    limits: { ...limits, maxRuntimeMs: 200 },
    prices,
  });
  assert.equal(outcome.limitHit, "max_runtime");
});

test("a refusal ends the loop without running tools", async () => {
  const client = new ScriptedClient([
    message([toolUse("t1", "bash", { command: "touch src/should-not-exist" })], "refusal"),
  ]);
  const outcome = await runAgentLoop({ client, system: "rules", firstMessage: "work", tools, limits, prices });
  assert.equal(outcome.refused, true);
  assert.equal(existsSync(join(workspace, "src/should-not-exist")), false);
});

test("tool input cut off by max_tokens is not executed", async () => {
  const client = new ScriptedClient([
    message([toolUse("t1", "bash", { command: "touch src/truncated" })], "max_tokens"),
    message([toolUse("t2", "submit_report", completeReport)]),
  ]);
  await runAgentLoop({ client, system: "rules", firstMessage: "work", tools, limits, prices });
  assert.equal(existsSync(join(workspace, "src/truncated")), false);
  const result = client.requests[1].messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
  assert.match(String(result[0].content), /cut off by the output limit/);
});

test("turnCost prices input, output, and cache tokens", () => {
  const cost = turnCost(
    {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    } as Message["usage"],
    prices,
  );
  assert.equal(Number(cost.toFixed(2)), 29.2);
});
