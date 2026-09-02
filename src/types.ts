export type ValidationGate = "build" | "automated_tests" | "playwright" | "docker_build";

export interface WorkContract {
  schema_version: 2;
  work_item: string;
  objective: string;
  acceptance_criteria: Record<string, string>;
  constraints?: string[];
  architectural_constraints?: string[];
  known_dependencies?: string[];
  non_goals?: string[];
  required_validation: ValidationGate[];
  escalation_conditions?: string[];
  intent: {
    path: string;
    revision: string;
    sha256: string;
    reviewUrl: string;
    status: "Accepted";
    acceptedBy: string;
    acceptedAt: string;
  };
  board: {
    provider: "trello" | "jira" | "azure_devops" | "other";
    workItemId: string;
    workItemUrl: string;
    workItemType: "User Story" | "Feature" | "Epic" | "Technical Enabler";
    parentWorkItemId?: string;
    parentWorkItemUrl?: string;
  };
}

export type AgentStatus = "candidate_complete" | "blocked" | "needs_decision" | "failed";

export interface AcceptanceCriterionResult {
  status: "satisfied" | "not_satisfied" | "partial";
  evidence: string[];
}

export interface EscalationEntry {
  issue: string;
  evidence?: string[];
  options?: { option: string; impact: string }[];
  recommendation?: string;
  decisionRequired: boolean;
}

/** The agent's own structured final output (forced via outputFormat json_schema). */
export interface AgentReport {
  workItem: string;
  status: AgentStatus;
  summary: string;
  acceptanceCriteria?: Record<string, AcceptanceCriterionResult>;
  selfReportedValidation?: Record<string, { status: "pass" | "fail" | "not_run"; passed?: number; failed?: number }>;
  filesChanged?: string[];
  assumptions?: string[];
  risks?: string[];
  escalations?: EscalationEntry[];
}

export interface IndependentValidationResult {
  status: "pass" | "fail" | "not_run" | "error";
  command: string;
  exitCode: number | null;
  durationMs: number;
  passed?: number;
  failed?: number;
  logExcerpt?: string;
}

/** The final artifact written to disk / printed to stdout. Authoritative. */
export interface EvidencePackage {
  workItem: string;
  status: AgentStatus;
  summary: string;
  contractHash: string;
  runId: string;
  acceptanceCriteria: Record<string, AcceptanceCriterionResult>;
  validation: Record<string, IndependentValidationResult>;
  filesChanged: string[];
  assumptions: string[];
  risks: string[];
  escalations: EscalationEntry[];
  discrepancies: string[];
  execution: {
    numTurns: number | null;
    totalCostUsd: number | null;
    durationMs: number;
    limitHit: "max_turns" | "max_budget_usd" | "max_runtime" | null;
  };
  worktree: {
    path: string;
    branch: string;
    baseBranch: string;
  };
}
