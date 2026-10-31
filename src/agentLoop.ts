// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Drives the Claude Messages API tool-use loop for one run, bounded by turns, cost, and wall clock.
// ABOUTME: The history is append-only; the loop ends when the model calls submit_report or a limit is hit.
import Anthropic from "@anthropic-ai/sdk";
import type { Prices, RuntimeConfig } from "./config.js";
import { parseReport, REPORT_TOOL_NAME, reportTool, type AgentReport } from "./report.js";
import { runBash, runEditor, type ToolContext } from "./tools.js";

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export interface TurnRequest {
  system: string;
  messages: MessageParam[];
}

/** The model boundary; tests substitute a scripted client. */
export interface ModelClient {
  send(request: TurnRequest, signal: AbortSignal): Promise<Message>;
}

export const BASH_TOOL = { type: "bash_20250124", name: "bash" } as const;
export const EDITOR_TOOL = { type: "text_editor_20250728", name: "str_replace_based_edit_tool" } as const;

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(private readonly config: RuntimeConfig) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  async send(request: TurnRequest, signal: AbortSignal): Promise<Message> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.config.model,
        max_tokens: 32_000,
        system: request.system,
        messages: request.messages,
        tools: [BASH_TOOL, EDITOR_TOOL, reportTool],
        output_config: { effort: this.config.effort },
        cache_control: { type: "ephemeral" },
        // On a policy refusal the API re-runs the turn on a fallback model; the
        // model that answered is recorded per turn so the evidence stays honest.
        ...(this.config.serverSideFallback
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      },
      { signal },
    );
    return stream.finalMessage();
  }
}

export interface LoopLimits {
  maxTurns: number;
  maxCostUsd: number;
  maxRuntimeMs: number;
}

export type LimitHit = "max_turns" | "max_cost" | "max_runtime";

export interface LoopOutcome {
  report: AgentReport | null;
  limitHit: LimitHit | null;
  refused: boolean;
  turns: number;
  costUsd: number;
  durationMs: number;
  models: string[];
  /** Why no report exists when report is null and no limit was hit. */
  problem?: string;
}

export interface LoopParams {
  client: ModelClient;
  system: string;
  firstMessage: string;
  tools: ToolContext;
  limits: LoopLimits;
  prices: Prices;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
}

export function turnCost(usage: Message["usage"], prices: Prices): number {
  const perToken = (perMTok: number) => perMTok / 1_000_000;
  return (
    usage.input_tokens * perToken(prices.inputPerMTok) +
    usage.output_tokens * perToken(prices.outputPerMTok) +
    (usage.cache_creation_input_tokens ?? 0) * perToken(prices.cacheWritePerMTok) +
    (usage.cache_read_input_tokens ?? 0) * perToken(prices.cacheReadPerMTok)
  );
}

export async function runAgentLoop(params: LoopParams): Promise<LoopOutcome> {
  const { client, limits, prices } = params;
  const emit = params.onEvent ?? (() => undefined);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.maxRuntimeMs);
  const tools: ToolContext = { ...params.tools, signal: controller.signal };
  const messages: MessageParam[] = [{ role: "user", content: params.firstMessage }];
  const models = new Set<string>();

  let turns = 0;
  let costUsd = 0;
  let nudged = false;
  const finish = (partial: Partial<LoopOutcome>): LoopOutcome => {
    clearTimeout(timer);
    return {
      report: null,
      limitHit: null,
      refused: false,
      turns,
      costUsd,
      durationMs: Date.now() - started,
      models: [...models],
      ...partial,
    };
  };

  for (;;) {
    if (controller.signal.aborted) return finish({ limitHit: "max_runtime" });
    if (turns >= limits.maxTurns) return finish({ limitHit: "max_turns" });
    if (costUsd >= limits.maxCostUsd) return finish({ limitHit: "max_cost" });

    let message: Message;
    try {
      message = await client.send({ system: params.system, messages }, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return finish({ limitHit: "max_runtime" });
      throw err;
    }
    turns += 1;
    costUsd += turnCost(message.usage, prices);
    models.add(message.model);
    emit("model_turn", {
      turn: turns,
      model: message.model,
      stopReason: message.stop_reason,
      costUsd: Number(costUsd.toFixed(4)),
    });

    if (message.stop_reason === "refusal") return finish({ refused: true, problem: "The model declined the request." });
    messages.push({ role: "assistant", content: message.content });

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      if (message.stop_reason === "pause_turn") continue;
      if (nudged) return finish({ problem: "The model stopped without calling submit_report." });
      nudged = true;
      messages.push({
        role: "user",
        content: "You stopped without calling submit_report. Call submit_report now with your final result.",
      });
      continue;
    }

    const truncated = message.stop_reason === "max_tokens";
    const results: ToolResult[] = [];
    let report: AgentReport | null = null;
    for (const use of toolUses) {
      const result = await executeTool(use, truncated, tools, (r) => (report = r));
      emit("tool_call", { tool: use.name, isError: result.is_error ?? false });
      results.push(result);
    }
    if (report) return finish({ report });
    messages.push({ role: "user", content: results });
  }
}

async function executeTool(
  use: Anthropic.Beta.BetaToolUseBlock,
  truncated: boolean,
  tools: ToolContext,
  onReport: (report: AgentReport) => void,
): Promise<ToolResult> {
  const result = (content: string, isError: boolean): ToolResult => ({
    type: "tool_result",
    tool_use_id: use.id,
    content,
    is_error: isError,
  });
  // A tool input cut off at max_tokens can still parse as a partial object; never run it.
  if (truncated) return result("Your tool input was cut off by the output limit. Send a smaller call.", true);

  switch (use.name) {
    case REPORT_TOOL_NAME: {
      const { report, errors } = parseReport(use.input);
      if (!report)
        return result(`The report is invalid: ${errors.join("; ")}. Fix it and call submit_report again.`, true);
      onReport(report);
      return result("Report recorded.", false);
    }
    case BASH_TOOL.name: {
      const outcome = await runBash(use.input, tools);
      return result(outcome.content, outcome.isError);
    }
    case EDITOR_TOOL.name: {
      const outcome = runEditor(use.input, tools);
      return result(outcome.content, outcome.isError);
    }
    default:
      return result(`Unknown tool "${use.name}".`, true);
  }
}
