# Decisions and Open Questions

## Decided

- The repository remains a standalone Coding Agent, not the Conductor, planner, evaluator, or release worker.
- The existing v0.1 implementation uses the Claude Agent SDK, local-process invocation, Work Contract v2, and independent driver validation.
- Intent chain of custody is a fail-closed preflight gate.
- Candidate work stays isolated and local; the agent does not push, merge, deploy, or update Trello.
- `candidate_complete` routes to independent evaluation and never means approval.

## Target evolution

- Adopt a versioned Work Contract v3 carrying approved, hash-pinned `spec.md` and `plan.md` provenance.
- Preserve v2 compatibility until the Conductor and planning stages are migrated together.
- Keep deterministic validation mappings explicit and repository-specific rather than model-selected.

## Open before migration

- Final v3 JSON Schema, contract storage location, and backward-compatibility window.
- Worktree/branch lifecycle policy and retention of candidate/evidence artifacts.
- Conductor transport and authentication for local versus service execution.
- Model/runtime deployment approach, secret management, observability, and capacity limits.
- Exact human approval and release integration after evaluator disposition.
