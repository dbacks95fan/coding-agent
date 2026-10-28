// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Decides the run's status from observed facts and builds the canonical Evidence Package and StageResult.
// ABOUTME: The agent's report is one input; it can lower the status but never raise it on its own.
import { isCovered } from "./paths.js";
import type { AgentReport } from "./report.js";
import type {
  ArtifactRef,
  CommitRef,
  EvidencePackage,
  ExecutionStatus,
  PolicyControlEvidence,
  StageResult,
  ValidationResult,
  WorkContract,
  WorkItem,
} from "./types.js";
import type { LoopOutcome } from "./agentLoop.js";

export interface Verdict {
  status: ExecutionStatus;
  reasons: string[];
  /** True when the candidate should be validated (the agent claims it is complete and nothing disqualifies it yet). */
  validate: boolean;
}

export interface ScopeRules {
  writePaths: string[];
  protectedPaths: string[];
  protectedPrefixes: string[];
}

export function scopeViolations(changedPaths: string[], scope: ScopeRules): string[] {
  return changedPaths
    .filter(
      (path) =>
        path === ".git" ||
        path.startsWith(".git/") ||
        scope.protectedPaths.includes(path) ||
        scope.protectedPrefixes.some((prefix) => path.startsWith(prefix)) ||
        !isCovered(path, scope.writePaths),
    )
    .map((path) => `Changed ${path}, which this invocation does not authorize.`);
}

/** Everything that can be decided before the required checks run. */
export function preValidationVerdict(
  loop: LoopOutcome,
  contract: WorkContract,
  changedPaths: string[],
  violations: string[],
): Verdict {
  const done = (status: ExecutionStatus, reasons: string[]): Verdict => ({ status, reasons, validate: false });
  if (loop.limitHit)
    return done("blocked", [`The run stopped at its ${loop.limitHit.replace("max_", "")} limit before finishing.`]);
  if (loop.refused) return done("failed", ["The model declined the request."]);
  const report = loop.report;
  if (!report) return done("failed", [loop.problem ?? "The agent produced no valid report."]);
  if (violations.length) return done("failed", violations);

  if (report.status === "needs_decision") {
    const questions = report.decisions_needed.map(
      (d) =>
        `Decision needed: ${d.question} Options: ${d.options.join(" | ") || "(none given)"}. Recommendation: ${d.recommendation}`,
    );
    return done("needs_decision", questions.length ? questions : [`The agent needs a decision: ${report.summary}`]);
  }
  if (report.status === "blocked") return done("blocked", [`The agent reported it was blocked: ${report.summary}`]);
  if (report.status === "failed") return done("failed", [`The agent reported failure: ${report.summary}`]);

  const reasons: string[] = [];
  const decisions: string[] = [];
  if (changedPaths.length === 0) {
    decisions.push(
      "No files changed. The acceptance criteria may already be met; a person should decide how to proceed.",
    );
  }
  contract.acceptance_criteria.forEach((criterion, index) => {
    const entry = report.acceptance_criteria.find((ac) => ac.index === index);
    if (!entry) reasons.push(`The agent did not report acceptance criterion [${index}]: ${criterion}`);
    else if (entry.status !== "satisfied")
      reasons.push(`Acceptance criterion [${index}] is ${entry.status}: ${entry.evidence}`);
  });
  for (const control of contract.policy_controls) {
    const entry = report.policy_controls.find((c) => c.control_id === control.control_id);
    if (!entry) reasons.push(`The agent did not report policy control ${control.control_id}.`);
    else if (entry.outcome === "needs_decision")
      decisions.push(`Policy control ${control.control_id} needs a decision: ${entry.summary}`);
  }
  if (reasons.length) return done("failed", reasons);
  if (decisions.length) return done("needs_decision", decisions);
  return { status: "candidate_complete", reasons: [], validate: true };
}

/** A failing or missing required check prevents candidate_complete. */
export function postValidationVerdict(contract: WorkContract, validation: ValidationResult[]): Verdict {
  const reasons: string[] = [];
  for (const required of contract.required_validation) {
    const result = validation.find((v) => v.name === required.name);
    if (!result) reasons.push(`Required check ${required.name} has no recorded outcome.`);
    else if (result.outcome !== "passed")
      reasons.push(`Required check ${required.name} ${result.outcome}: ${result.summary}`);
  }
  return reasons.length
    ? { status: "failed", reasons, validate: false }
    : { status: "candidate_complete", reasons, validate: false };
}

export function policyEvidence(contract: WorkContract, report: AgentReport): PolicyControlEvidence[] {
  return contract.policy_controls.map((control) => {
    const entry = report.policy_controls.find((c) => c.control_id === control.control_id);
    return entry
      ? { control_id: control.control_id, outcome: entry.outcome, summary: entry.summary || "(no summary given)" }
      : {
          control_id: control.control_id,
          outcome: "needs_decision",
          summary: "The agent did not report evidence for this control.",
        };
  });
}

export function evidenceSummary(report: AgentReport, loop: LoopOutcome): string {
  const criteria = report.acceptance_criteria.map((ac) => `[${ac.index}] ${ac.status}: ${ac.evidence}`).join("; ");
  const risks = report.risks.length ? ` Risks noted by the agent: ${report.risks.join("; ")}.` : "";
  return (
    `${report.summary} Agent self-assessment of acceptance criteria (not proof): ${criteria || "(none)"}.${risks} ` +
    `Model(s): ${loop.models.join(", ") || "none"}; turns: ${loop.turns}; estimated model cost: $${loop.costUsd.toFixed(2)}.`
  );
}

export function buildEvidencePackage(args: {
  workItem: WorkItem;
  inputArtifacts: ArtifactRef[];
  candidate: CommitRef;
  changedPaths: string[];
  validation: ValidationResult[];
  policyControlEvidence: PolicyControlEvidence[];
  status: ExecutionStatus;
  summary: string;
}): EvidencePackage {
  return {
    schema_version: "1.0",
    work_item: args.workItem,
    input_artifacts: args.inputArtifacts,
    candidate: args.candidate,
    changed_paths: args.changedPaths,
    validation: args.validation,
    policy_control_evidence: args.policyControlEvidence,
    status: args.status,
    summary: args.summary,
  };
}

export function buildStageResult(args: {
  invocationId: string;
  stage?: StageResult["stage"];
  workItem: WorkItem;
  status: ExecutionStatus;
  summary: string;
  findings?: string[];
  outputArtifacts?: ArtifactRef[];
  candidate?: CommitRef;
}): StageResult {
  return {
    schema_version: "1.0",
    invocation_id: args.invocationId,
    stage: args.stage ?? "execution",
    work_item: args.workItem,
    status: args.status,
    output_artifacts: args.outputArtifacts ?? [],
    ...(args.candidate ? { candidate: args.candidate } : {}),
    summary: args.summary,
    ...(args.findings?.length ? { findings: args.findings } : {}),
  };
}
