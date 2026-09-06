# Artifact Contracts

## Inputs

| Artifact | Ownership | Coding Agent rule |
| --- | --- | --- |
| Frozen `intent.md` | Intent backlog / first engineering handoff | Verify and never edit |
| Approved `spec.md` | Spec & Design stage / human Design Review | Consume in v3; never edit |
| Approved `plan.md` | Implementation Planning stage | Consume in v3; never edit |
| Work Contract | Planning/Conductor | Validate and never edit |

## Candidate workspace evidence

The current implementation writes durable evidence in the target repository:

```text
.agent/audit/<work-item>-<run-id>.jsonl
.agent/evidence/<work-item>-<run-id>.json
```

The candidate branch contains the product changes and any agent-owned work-item artifacts. It must be traceable to base commit, candidate commit, work item, and validated contract inputs.

## Evidence Package requirements

The final package must include:

- Work item and run identifiers
- Contract hash and intent provenance; v3 adds spec and plan provenance
- Base, candidate, and worktree branch commits
- Files changed according to actual Git state
- Agent-reported findings separated from driver-observed facts
- Required validation commands, outcomes, exit codes, and captured safe output
- Discrepancies, unresolved decisions, blockers, and terminal status

No Evidence Package may contain secrets, credentials, hidden model reasoning, or unsupported claims. The Evaluator independently assesses the package, artifacts, code, and user-observable outcome alignment.
