// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: The submit_report tool through which the model ends its run, and validation of what it submits.
// ABOUTME: The report is the agent's claim only; the driver independently decides the final status.
import type Anthropic from "@anthropic-ai/sdk";
import { compileValidator } from "./lifecycle.js";

export interface AgentReport {
  status: "candidate_complete" | "needs_decision" | "blocked" | "failed";
  summary: string;
  acceptance_criteria: { index: number; status: "satisfied" | "not_satisfied" | "partial"; evidence: string }[];
  policy_controls: { control_id: string; outcome: "addressed" | "needs_decision"; summary: string }[];
  decisions_needed: { question: string; options: string[]; recommendation: string }[];
  risks: string[];
  checks_run: { name: string; outcome: "passed" | "failed" | "not_run"; summary: string }[];
}

export const REPORT_TOOL_NAME = "submit_report";

const stringArray = { type: "array", items: { type: "string" } } as const;

const reportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "acceptance_criteria", "policy_controls", "decisions_needed", "risks", "checks_run"],
  properties: {
    status: { type: "string", enum: ["candidate_complete", "needs_decision", "blocked", "failed"] },
    summary: { type: "string" },
    acceptance_criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "status", "evidence"],
        properties: {
          index: { type: "integer" },
          status: { type: "string", enum: ["satisfied", "not_satisfied", "partial"] },
          evidence: { type: "string" },
        },
      },
    },
    policy_controls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["control_id", "outcome", "summary"],
        properties: {
          control_id: { type: "string" },
          outcome: { type: "string", enum: ["addressed", "needs_decision"] },
          summary: { type: "string" },
        },
      },
    },
    decisions_needed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "options", "recommendation"],
        properties: { question: { type: "string" }, options: stringArray, recommendation: { type: "string" } },
      },
    },
    risks: stringArray,
    checks_run: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "outcome", "summary"],
        properties: {
          name: { type: "string" },
          outcome: { type: "string", enum: ["passed", "failed", "not_run"] },
          summary: { type: "string" },
        },
      },
    },
  },
};

export const reportTool: Anthropic.Beta.BetaTool = {
  name: REPORT_TOOL_NAME,
  description:
    "Submit your final result and end the run. Call this exactly once, after you have finished working. " +
    "Report what you observed, not what you hope: the driver re-runs every required check itself.",
  input_schema: reportSchema as Anthropic.Beta.BetaTool.InputSchema,
  strict: true,
};

const validateReport = compileValidator("submit_report", reportSchema);

export function parseReport(input: unknown): { report: AgentReport | null; errors: string[] } {
  const outcome = validateReport(input);
  return outcome.valid ? { report: input as AgentReport, errors: [] } : { report: null, errors: outcome.errors };
}
