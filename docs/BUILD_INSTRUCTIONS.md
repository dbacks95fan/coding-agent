# Build Instructions

## Objective

Maintain and evolve a stateless Coding Agent that implements one approved work contract in an isolated product-repository worktree. It produces a candidate commit and independently verified Evidence Package for the separate, read-only Evaluator.

The current v0.1 implementation is authoritative for its supported Work Contract v2 behavior. These instructions define the next compatible evolution: the worker must consume provenance for the frozen intent, human-approved `spec.md`, and approved `plan.md`/work contract without rewriting the v0.1 safety controls.

## Existing behavior to preserve

- JSON Schema validation of Work Contract v2.
- Accepted intent metadata plus runtime SHA-256 chain-of-custody verification before worktree creation or model invocation.
- One isolated branch/worktree per work item, scoped file edits, and bounded model turns/budget/runtime.
- No Trello, GitHub, deployment, merge, or branch-push authority.
- Required validation re-run independently by the driver; agent self-report is not authoritative.
- Structured Evidence Package and statuses: `candidate_complete`, `blocked`, `needs_decision`, `failed`.

## Required behavior

1. Validate the request/contract and all artifact provenance before changing a product worktree.
2. Confirm that the frozen intent, approved specification, and approved plan refer to the same work item and immutable source revision.
3. Create or receive the assigned isolated worktree; never touch the caller’s checkout or protected branches.
4. Inspect repository-local instructions and existing code before implementing the approved plan.
5. Make only contract-scoped code, tests, configuration, and agent-owned evidence changes.
6. Run required validation during the agent session, inspect the final diff, commit the candidate locally, then have the driver independently re-run deterministic gates.
7. Emit a schema-valid Evidence Package. Only `candidate_complete` can route to the Evaluator; it never means approval.

## Delivery increments

### 1. Freeze the current external behavior

Add characterization tests for contract loading, preflight integrity, worktree lifecycle, permission denials, validation-result assembly, exit codes, and Evidence Package shape. Do not change v2 output semantics while adding v3-capable inputs.

### 2. Add approved spec and plan provenance

Define a new, versioned contract schema rather than making required v3 fields silently optional in v2. Validate work-item identity, artifact revision/hash, approval records, and compatibility. Return `blocked` before worktree creation for mismatches or missing approvals.

### 3. Strengthen implementation evidence

Record candidate/base commits, changed files, independent validation results, contract/spec/plan provenance, known discrepancies, and human-decision requests. Keep artifacts sanitized and reproducible.

### 4. Operational hardening

Preserve bounded execution and add idempotent request handling, cancellation, structured sanitized logs, timeout behavior, and health/readiness endpoints if deployed as a service. Do not claim container or remote deployment support unless verified in that environment.

## Non-negotiable rules

- Do not build to the test. Passing checks are evidence, not proof that the requested product outcome is delivered.
- Do not expand scope or repair an ambiguous requirement by inventing product decisions. Return `needs_decision` with a concrete question.
- Never mutate the frozen intent, approved spec, plan, or work contract.
- Do not replace the existing implementation wholesale. Evolve it in small, tested, compatible increments.
