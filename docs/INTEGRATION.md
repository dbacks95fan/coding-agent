# Conductor Integration

What the Conductor must send to the Coding Agent and verify afterward. The lifecycle rules come from agentic-sdlc Stage Contracts §4 and the shared rules; this page is the concrete wire contract for this component.

## Invoke

`POST /invocations` with `Authorization: Bearer <CODING_AGENT_API_TOKEN>` and a `StageInvocation` 1.1 body:

| Field | Required value |
| --- | --- |
| `schema_version` | `"1.1"` (1.0 is rejected) |
| `stage` | `"execution"` |
| `work_item` | Equal to `freeze_activation.work_item` |
| `freeze_activation` | The active `FreezeActivationEvent`, unchanged |
| `input_artifacts` | The accepted `.agent/work/<intent-id>/spec.md` and `.agent/work/<intent-id>/work-contract.yaml` references from the Spec Acceptance Record. On rework, also the failing `.agent/work/<intent-id>/evaluation-package/<name>.json`. Nothing else. |
| `target` | The product repository and the **handoff commit** the agent must start from: the accepted spec commit, or on rework the Evaluation Package commit. The remote branch tip must equal it. |
| `workspace_ref` | `work/<intent-id>` |
| `read_paths` | Repository-relative scopes, usually `["."]` |
| `write_paths` | Product scopes the agent may change, plus `.agent/work/<intent-id>/evidence-package` (or a parent of it) |

Then poll `GET /invocations/{invocation_id}` until `state` is `done`. The service runs one invocation at a time and returns `409 busy` for a second. Resubmitting an identical body is safe.

## Verify the result

Before routing, the Conductor (read-only) should:

1. Validate `stage_result` against `#/$defs/StageResult` and confirm `invocation_id` and `work_item` match.
2. For `candidate_complete`: confirm the work branch tip equals `output_artifacts[0].commit_sha`, its parent is `candidate.commit_sha`, the candidate's parent is the handoff, and the evidence file's SHA-256 matches.
3. Validate the Evidence Package against `#/$defs/EvidencePackage` and compare its `validation` names and outcomes to the accepted Work Contract's `required_validation`, and its `policy_control_evidence` to the frozen profile.
4. Revalidate that the freeze is still active, then record a `StageResultDecision`.

`needs_decision`, `blocked`, and `failed` push nothing; their reasons are in `stage_result.findings`, with more detail in `diagnostics` (not a lifecycle record).

## Conductor status

The Conductor (trello-orchestrator) sends the StageInvocation above over HTTP, polls for the result, and does not write to the product repository. With trello-orchestrator PR #16 it also performs steps 1, 2, and 4, compares Evidence Package validation outcomes to `required_validation` (step 3), records the StageInvocation and StageResult on the card, and sends a rework invocation with the failing Evaluation Package when an evaluation fails on implementation findings. It does not yet:

- compare `policy_control_evidence` to the frozen profile (step 3);
- send product scopes plus the evidence path as `write_paths`; it sends `["."]`.
