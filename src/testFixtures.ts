// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Shared sample lifecycle records for unit tests; values are illustrative, not real hashes.
import type { FreezeActivationEvent, StageInvocation, WorkContract, WorkItem } from "./types.js";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);
export const HASH_1 = "1".repeat(64);
export const HASH_2 = "2".repeat(64);
export const HASH_3 = "3".repeat(64);
export const HASH_4 = "4".repeat(64);
export const TARGET_REPO = "https://github.com/example/mealflow.git";
export const INTENT_REPO = "https://github.com/example/intent-backlog.git";

export function sampleWorkItem(): WorkItem {
  return { product_id: "MF", intent_id: "INT-MF-0042", intent_version: 1, trello_card_id: "card-1" };
}

export function sampleFreeze(): FreezeActivationEvent {
  return {
    schema_version: "1.0",
    event_id: "freeze-1",
    event_type: "activated",
    work_item: sampleWorkItem(),
    intent: {
      repository: INTENT_REPO,
      commit_sha: SHA_A,
      path: "products/mealflow/intents/INT-MF-0042/intent.md",
      sha256: HASH_1,
    },
    policy_profile_id: "MEALFLOW-DEFAULT",
    policy_profile_version: "1",
    policy_profile: {
      repository: INTENT_REPO,
      commit_sha: SHA_A,
      path: "products/mealflow/policy-profiles/MEALFLOW-DEFAULT.md",
      sha256: HASH_2,
    },
    authorized_by: "owner-1",
    recorded_at: "2026-10-27T10:00:00Z",
  };
}

export function sampleInvocation(): StageInvocation {
  return {
    schema_version: "1.1",
    invocation_id: "inv-1",
    trigger_event_id: "evt-1",
    stage: "execution",
    work_item: sampleWorkItem(),
    freeze_activation: sampleFreeze(),
    input_artifacts: [
      { repository: TARGET_REPO, commit_sha: SHA_C, path: ".agent/work/INT-MF-0042/spec.md", sha256: HASH_3 },
      {
        repository: TARGET_REPO,
        commit_sha: SHA_C,
        path: ".agent/work/INT-MF-0042/work-contract.yaml",
        sha256: HASH_4,
      },
    ],
    target: { repository: TARGET_REPO, commit_sha: SHA_C },
    workspace_ref: "work/INT-MF-0042",
    read_paths: ["."],
    write_paths: ["src", "tests", ".agent/work/INT-MF-0042/evidence-package"],
  };
}

export function sampleWorkContract(): WorkContract {
  const freeze = sampleFreeze();
  return {
    schema_version: 3,
    work_item: sampleWorkItem(),
    intent: freeze.intent,
    policy_profile_id: freeze.policy_profile_id,
    policy_profile_version: freeze.policy_profile_version,
    policy_profile: freeze.policy_profile,
    target: { repository: TARGET_REPO, commit_sha: SHA_B },
    acceptance_criteria: ["The empty recipe library shows a call to action."],
    permitted_scope: { included: ["Recipe library empty state"], excluded: ["Recipe API changes"] },
    required_validation: [{ name: "build", command: "npm run build" }],
    policy_controls: [
      { control_id: "SEC-BASE-001", required_action: "Do not hardcode secrets.", evidence_expected: "Secret scan." },
    ],
    release_requirements: [],
    observation_requirements: [],
  };
}
