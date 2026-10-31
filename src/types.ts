// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: TypeScript shapes for the canonical lifecycle records this worker consumes and produces.
// ABOUTME: The JSON Schema in schemas/lifecycle-contracts.schema.json is authoritative; these mirror it.

export interface WorkItem {
  product_id: string;
  intent_id: string;
  intent_version: number;
  trello_card_id: string;
}

export interface CommitRef {
  repository: string;
  commit_sha: string;
}

export interface ArtifactRef extends CommitRef {
  path: string;
  sha256: string;
}

export interface FreezeActivationEvent {
  schema_version: "1.0";
  event_id: string;
  event_type: "activated";
  work_item: WorkItem;
  intent: ArtifactRef;
  policy_profile_id: string;
  policy_profile_version: string;
  policy_profile: ArtifactRef;
  authorized_by: string;
  recorded_at: string;
}

export interface StageInvocation {
  schema_version: "1.1";
  invocation_id: string;
  trigger_event_id: string;
  stage: "spec_design" | "execution" | "evaluation";
  work_item: WorkItem;
  freeze_activation: FreezeActivationEvent;
  input_artifacts: ArtifactRef[];
  target: CommitRef;
  workspace_ref: string;
  read_paths: string[];
  write_paths: string[];
}

export interface RequiredValidation {
  name: string;
  command: string;
}

export interface PolicyControl {
  control_id: string;
  required_action: string;
  evidence_expected: string;
}

export interface WorkContract {
  schema_version: 3;
  work_item: WorkItem;
  intent: ArtifactRef;
  policy_profile_id: string;
  policy_profile_version: string;
  policy_profile: ArtifactRef;
  target: CommitRef;
  acceptance_criteria: string[];
  permitted_scope: { included: string[]; excluded: string[] };
  required_validation: RequiredValidation[];
  policy_controls: PolicyControl[];
  release_requirements: string[];
  observation_requirements: string[];
}

export interface EvaluationFinding {
  category: "implementation" | "specification" | "policy" | "evidence";
  severity: "blocking" | "non_blocking";
  summary: string;
  artifact?: ArtifactRef;
}

export interface EvaluationPackage {
  schema_version: "1.0";
  work_item: WorkItem;
  input_artifacts: ArtifactRef[];
  candidate: CommitRef;
  checks: ValidationResult[];
  findings: EvaluationFinding[];
  status: "pass" | "fail" | "needs_decision" | "blocked" | "failed";
  summary?: string;
}

export interface ValidationResult {
  name: string;
  outcome: "passed" | "failed" | "not_run" | "not_applicable";
  observed_at: string;
  summary: string;
  evidence?: ArtifactRef;
}

export type ExecutionStatus = "candidate_complete" | "needs_decision" | "blocked" | "failed";

export interface PolicyControlEvidence {
  control_id: string;
  outcome: "addressed" | "not_applicable" | "needs_decision";
  summary: string;
  evidence?: ArtifactRef;
}

export interface EvidencePackage {
  schema_version: "1.0";
  work_item: WorkItem;
  input_artifacts: ArtifactRef[];
  candidate: CommitRef;
  changed_paths: string[];
  validation: ValidationResult[];
  policy_control_evidence: PolicyControlEvidence[];
  status: ExecutionStatus;
  summary?: string;
}

export interface StageResult {
  schema_version: "1.0";
  invocation_id: string;
  /** Echoes the invocation's stage; this worker only ever completes "execution". */
  stage: StageInvocation["stage"];
  work_item: WorkItem;
  status: ExecutionStatus;
  output_artifacts: ArtifactRef[];
  candidate?: CommitRef;
  summary?: string;
  findings?: string[];
}
