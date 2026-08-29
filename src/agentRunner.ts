import { query } from "@anthropic-ai/claude-agent-sdk";
import agentReportSchema from "../schemas/agent-report.schema.json" with { type: "json" };
import { newAjv } from "./ajvLoader.js";
import type { AuditLog } from "./audit.js";
import { ALLOWED_TOOLS, buildPermissionPolicy, DISALLOWED_TOOLS } from "./permissions.js";
import { buildSystemPrompt, USER_PROMPT } from "./prompt.js";
import type { AgentReport, WorkContract } from "./types.js";
import type { Worktree } from "./worktree.js";

export interface AgentRunLimits {
  maxTurns: number;
  maxBudgetUsd: number;
  maxRuntimeMs: number;
}

export interface AgentRunOutcome {
  report: AgentReport | null;
  reportSchemaValid: boolean;
  numTurns: number | null;
  totalCostUsd: number | null;
  durationMs: number;
  limitHit: "max_turns" | "max_budget_usd" | "max_runtime" | null;
  rawResultSubtype: string | null;
}

export async function runCodingAgent(
  contract: WorkContract,
  contractPath: string,
  repoRoot: string,
  worktree: Worktree,
  limits: AgentRunLimits,
  audit: AuditLog,
): Promise<AgentRunOutcome> {
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    audit.write("runtime_limit_hit", { maxRuntimeMs: limits.maxRuntimeMs });
    abortController.abort();
  }, limits.maxRuntimeMs);

  const started = Date.now();
  let limitHitByTimeout = false;

  const q = query({
    prompt: USER_PROMPT,
    options: {
      cwd: worktree.path,
      abortController,
      settingSources: [], // no ambient user/project/local settings — fully isolated
      systemPrompt: buildSystemPrompt(repoRoot, contract),
      tools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      canUseTool: buildPermissionPolicy(worktree.path, contractPath),
      permissionMode: "default", // canUseTool is the actual decision-maker; 'dontAsk' would bypass it entirely
      maxTurns: limits.maxTurns,
      maxBudgetUsd: limits.maxBudgetUsd,
      outputFormat: { type: "json_schema", schema: agentReportSchema as Record<string, unknown> },
    },
  });

  let numTurns: number | null = null;
  let totalCostUsd: number | null = null;
  let rawResultSubtype: string | null = null;
  let structuredOutput: unknown = null;

  try {
    for await (const message of q) {
      if (message.type === "assistant") {
        const toolCalls = (message.message.content as Array<{ type: string; name?: string }>).filter(
          (b) => b.type === "tool_use",
        );
        for (const call of toolCalls) {
          audit.write("tool_call", { tool: call.name });
        }
      } else if (message.type === "result") {
        rawResultSubtype = message.subtype;
        numTurns = message.num_turns;
        totalCostUsd = message.total_cost_usd;
        if (message.subtype === "success") {
          structuredOutput = message.structured_output ?? null;
        }
        audit.write("result", {
          subtype: message.subtype,
          numTurns: message.num_turns,
          totalCostUsd: message.total_cost_usd,
          durationMs: message.duration_ms,
        });
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      limitHitByTimeout = true;
    } else {
      audit.write("agent_error", { message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - started;

  let limitHit: AgentRunOutcome["limitHit"] = null;
  if (limitHitByTimeout) limitHit = "max_runtime";
  else if (rawResultSubtype === "error_max_turns") limitHit = "max_turns";
  else if (rawResultSubtype === "error_max_budget_usd") limitHit = "max_budget_usd";

  let report: AgentReport | null = null;
  let reportSchemaValid = false;
  if (structuredOutput) {
    const ajv = newAjv({ allErrors: true });
    const validate = ajv.compile(agentReportSchema);
    if (validate(structuredOutput)) {
      report = structuredOutput as AgentReport;
      reportSchemaValid = true;
    } else {
      audit.write("agent_report_schema_invalid", {
        errors: (validate.errors ?? []).map(
          (e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message}`,
        ),
      });
    }
  }

  return { report, reportSchemaValid, numTurns, totalCostUsd, durationMs, limitHit, rawResultSubtype };
}
