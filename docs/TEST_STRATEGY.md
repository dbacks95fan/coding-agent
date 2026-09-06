# Test Strategy

The implementation must retain unit, integration, and end-to-end coverage. Deterministic checks are necessary evidence, not a substitute for the separate Evaluator or human approval.

| Layer | Required evidence |
| --- | --- |
| Unit | Contract/schema validation, intent/spec/plan hash checks, permission denials, status selection, evidence assembly, output redaction |
| Integration | Isolated worktree lifecycle, v2/v3 compatibility, local commit behavior, independent validation mapping, audit/evidence persistence |
| End-to-end | A fixture contract drives a real isolated repository change, creates a candidate commit, re-runs validation independently, and returns an Evidence Package |
| Negative end-to-end | Missing acceptance, changed hash, cross-worktree path, invalid gate, budget/timeout, unresolvable decision, and validation failure stop safely |

Run the existing test suite before and after any behavioral change. Add characterization tests before changing legacy v0.1 behavior. Review generated candidates against the frozen intent/spec/plan; a green suite alone cannot prove outcome delivery.
