# Integration Contract

## Conductor boundary

The Conductor selects the work item, validates workflow state, supplies the contract and repository, controls concurrency/retries, and updates Trello. The Coding Agent only runs the bounded implementation assignment and returns a structured result.

```text
Prioritized -> Spec & Design -> human accepts spec.md and work contract
  -> card enters Execution -> Conductor dispatches Coding Agent
  -> Candidate + independent validation evidence
  -> Conductor dispatches read-only Evaluator
  -> Human Approval -> Release
```

## Evaluator boundary

The Coding Agent cannot evaluate or approve its own work. It reports `candidate_complete` only after independent deterministic validation. The separate Codex-oriented Evaluator then compares the frozen intent, approved spec and plan, candidate code, validation evidence, and observable behavior. The Evaluator does not alter code or Trello state.

## Idempotency and recovery

The Conductor must associate each attempt with a run ID and retain the contract revision. A retry must not silently discard an inspectable candidate branch or overwrite its evidence. Existing v0.1 stale-worktree cleanup must be treated carefully during migration: cleanup is safe only for a positively identified abandoned run and never for an active or reviewable candidate.

## Compatibility

Current local-process invocation and Work Contract v2 remain supported facts. Work Contract v3 removes the separate `plan.md`: sectioned `spec.md` is the human-reviewed specification and implementation plan, while the YAML contract remains the frozen machine input. Containerization, remote worktree persistence, branch pushing, and Conductor v3 dispatch are separate future work; this documentation does not authorize or claim them.
