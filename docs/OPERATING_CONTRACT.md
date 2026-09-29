# Operating Contract

## Role

The Coding Agent is a Claude-oriented implementation worker. Given a verified work contract and target repository, it makes a scoped candidate change in an isolated worktree and returns independently observed evidence. It does not decide product intent, design, plan, acceptance, workflow state, or release.

## Current contract: v2

The implemented interface accepts Work Contract v2. Its `intent` block includes the intent path, revision, SHA-256 hash, review URL, accepted status, acceptor, and acceptance time. The driver verifies the actual target-repository intent bytes before creating a worktree. See `ARCHITECTURE.md` and `schemas/work-contract.schema.json`.

## Target contract: versioned evolution

A future Work Contract v3 must add immutable references to the approved specification and policy profile while retaining the intent reference:

```json
{
  "schema_version": 3,
  "work_item": "INT-MF-0042",
  "intent": { "path": ".agent/work/INT-MF-0042/intent.md", "commit": "sha", "sha256": "hash" },
  "spec": { "path": ".agent/work/INT-MF-0042/spec.md", "commit": "sha", "sha256": "hash", "approvedBy": "id", "approvedAt": "RFC-3339" },
  "policyProfile": { "id": "MF-DEFAULT", "version": 1, "sha256": "hash" },
  "acceptance_criteria": [],
  "required_validation": []
}
```

This is a target schema, not a claim of current support. A v3 implementation must reject incomplete or inconsistent provenance fail-closed and keep v2 behavior available until the Conductor migrates.

## Preconditions

- Contract schema and approval records are valid.
- Frozen intent exists and matches its recorded hash.
- For v3, `spec.md` exists, matches its recorded hash, is approved, identifies the same work item, and contains the implementation and validation plan. The policy profile and work contract must also match their recorded immutable references.
- Target is a Git repository with an allowed base branch and a writable isolated worktree.
- Required validation gates are known and executable for the target repository.

## Process

1. Validate the contract and perform integrity preflight before any agent cost or worktree mutation.
2. Create the assigned worktree/branch and scope permissions to it.
3. Read repository instructions and inspect relevant existing code.
4. Implement only the approved plan; add or update tests as required by the repository and contract.
5. Inspect the diff, run relevant checks, commit candidate changes locally, and report the agent’s observations.
6. Independently re-run contract-required validation. Assemble evidence from observed Git state and driver-run validation.
7. Return a terminal structured status to the Conductor.

## Statuses

| Status | Meaning | Next owner |
| --- | --- | --- |
| `candidate_complete` | Candidate commit exists and every required deterministic gate independently passed | Evaluator |
| `needs_decision` | A material product/design/contract decision is missing | Human authority via Conductor |
| `blocked` | Preconditions, integrity, authorization, or environment prevented safe work | Conductor/operator |
| `failed` | Unexpected worker failure occurred | Conductor retry/failure policy |

`candidate_complete` is not approval, release authorization, or proof of outcome delivery.
