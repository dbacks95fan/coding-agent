# Agent Instructions

Read `README.md`, `ARCHITECTURE.md`, and `docs/DECISIONS.md` before modifying this repository. The normative contract is agentic-sdlc Stage Contracts §4 (Execution) and its lifecycle schema; change that contract first, then this component.

- The Coding Agent implements an accepted Work Contract only. It does not plan, alter intent, policy profile, spec, or Work Contract, move Trello cards, evaluate its own outcome, approve, merge, or release. It pushes only its candidate and Evidence Package to the assigned work branch, fast-forward only.
- `candidate_complete` is never approval or done.
- Keep controls deterministic and in code: fail-closed preflight, trusted-command manifest, scrubbed child environments, driver Git isolation, post-run scope checks, and independent validation. Do not weaken one for convenience.
- `schemas/lifecycle-contracts.schema.json` is vendored byte-for-byte; update it only by re-copying from agentic-sdlc and running `npm run check:schema-sync`.
- Never log or commit secrets, credentials, hidden model reasoning, or content outside the authorized artifacts.
- Run `npm run check` before calling a change done.
