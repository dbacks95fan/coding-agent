# Architecture

This document explains how the Coding Agent satisfies the agentic-sdlc Execution contract and why each boundary exists. The contract itself lives in `agentic-sdlc`; when this document and that contract disagree, the contract wins and this document is wrong.

## Position in the lifecycle

```text
Spec & Design (pushes spec.md + work-contract.yaml) -> human acceptance (Spec Acceptance Record)
  -> Conductor sends StageInvocation 1.1 (stage: execution)
  -> [Coding Agent] fetch handoff SHA -> verify -> implement -> check -> push candidate + evidence
  -> StageResult -> Conductor validates refs read-only -> Evaluation
```

The Conductor owns workflow state and never writes product repositories. The Coding Agent owns exactly two kinds of commits on the assigned branch: one candidate commit and one Evidence Package commit.

## Components

| Module | Responsibility |
| --- | --- |
| `invocation.ts` | Admits the StageInvocation: schema, stage, identity, branch, trusted repositories, input classification, path scopes |
| `preflight.ts` | Fetches the branch at the handoff and verifies tip, accepted artifacts, frozen copies, frozen sources, Work Contract consistency, and trusted checks |
| `agentLoop.ts` | Messages API tool loop with turn, cost, and wall-clock limits; append-only history |
| `tools.ts` | Text-editor and bash execution with path confinement, write scopes, protected inputs, and a command screen |
| `commands.ts` | Every child process: scrubbed environment, bounded output, tree-kill on timeout |
| `git.ts` | Driver Git: no hooks, no ambient config, byte-exact reads, single candidate commit, fast-forward-only push |
| `evidence.ts` | Status decisions and canonical Evidence Package and StageResult construction |
| `run.ts` | The end-to-end pipeline |
| `service.ts`, `cli.ts`, `selfTest.ts` | HTTP boundary, command line, deployment self-test |

## Why the Messages API, not the Claude Agent SDK

The Agent SDK runs the Claude Code CLI, a native binary that cannot run on the NAS's 3.10 kernel (it needs the `getrandom` syscall). The agent therefore drives `POST /v1/messages` directly with Anthropic's schema-less `bash_20250124` and `text_editor_20250728` tools, which Claude is trained on, plus a strict `submit_report` tool. Owning the loop also puts every permission check in this codebase, where it is tested, rather than in a callback around another harness.

The loop uses Claude Opus 5.5 with adaptive thinking at `high` effort, automatic prompt caching, and server-side refusal fallback. The history is append-only. Forced tool choice is not available on this model, so the system prompt tells the model to finish with `submit_report`, and the loop nudges once if it stops without one.

## Which commit to start from

Stage Contracts say a later worker "checks out the exact commit SHA in its StageInvocation or the latest accepted handoff", and Workflow says "Coding starts from that exact accepted handoff SHA". This worker reads `StageInvocation.target.commit_sha` as that handoff commit. On first entry it is the commit holding the accepted spec and Work Contract; on rework it is the commit holding the Evaluation Package. The Work Contract's own `target` is the product base commit and must be an ancestor of the handoff. The schema does not name a field for this per stage; see [docs/DECISIONS.md](docs/DECISIONS.md).

## Verification before any spend

Nothing reaches the model until all of these hold, and each failure is reported as a `blocked` finding:

- The invocation is a valid 1.1 record for `execution`, its work item equals the freeze's, and `workspace_ref` is `work/<intent-id>`.
- The target and intent-backlog repositories are in the operator's manifest.
- `input_artifacts` contain exactly one `.agent/work/<id>/spec.md`, one `.agent/work/<id>/work-contract.yaml`, and at most one `.agent/work/<id>/evaluation-package/*.json`.
- The remote branch tip equals the handoff, so no other writer is active.
- Each accepted artifact hashes correctly at its recorded commit, that commit is in the branch history, and the bytes are unchanged at the handoff.
- The frozen intent and profile copies at the handoff, and the originals in intent-backlog, match the freeze fingerprints. Line-ending conversion is disabled for every driver Git call, so a converted copy fails.
- The Work Contract is valid v3 and its work item, intent, and policy-profile references equal the freeze's; its base commit is in the branch history.
- On rework, the Evaluation Package is valid, has status `fail`, and evaluated a commit in the branch history.
- Every `required_validation` entry matches the manifest's trusted command exactly.

## Status rules

The agent's report can lower the status but never raise it.

| Condition | Status |
| --- | --- |
| Any admission, preflight, setup, or publish failure; a limit hit; the branch moved | `blocked` |
| The agent reports a material decision, flags a policy control, or changed nothing | `needs_decision` |
| A changed path is outside `write_paths` or touches a protected artifact | `failed` |
| An acceptance criterion or policy control is unreported or unsatisfied | `failed` |
| A required check did not pass, or the model refused | `failed` |
| Everything above is clear and every required check passed | `candidate_complete` |

## Candidate and evidence commits

The driver resets softly to the handoff and commits the whole working tree once, so the branch reads handoff, then candidate, then evidence, whatever the agent did locally. The Evidence Package names the candidate commit, so it is committed afterward at `.agent/work/<id>/evidence-package/<invocation-id>.json`. That path must be inside `write_paths`. The StageResult's `candidate` is the candidate commit and its single `output_artifact` is the evidence file at the evidence commit, with its SHA-256.

Only `candidate_complete` pushes. Pushing an unaccepted attempt would move the branch tip away from the last accepted handoff and block the next legitimate run, so other outcomes are returned in the HTTP response and logs only.

## Statelessness

Each run uses a fresh directory under `CODING_AGENT_WORK_ROOT` and deletes it afterward. The service keeps finished results in memory for polling; a restart loses them, but a `candidate_complete` result is still fully recoverable from the pushed branch.
