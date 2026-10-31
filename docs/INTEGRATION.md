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

## Not yet done on the Conductor side

The current Conductor still converts Work Contract v3 to the retired v2 format and runs this agent as a local subprocess. It must instead send the StageInvocation above over HTTP and stop writing to the product repository, per the agentic-sdlc rule that agents, not the Conductor, push work branches.
