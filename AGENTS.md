# Agent Instructions

Read `ARCHITECTURE.md`, `docs/BUILD_INSTRUCTIONS.md`, and `docs/OPERATING_CONTRACT.md` before modifying this repository.

- Preserve the current v0.1 Work Contract v2, intent chain-of-custody gate, worktree isolation, permission policy, and independent validation unless a versioned migration replaces them.
- The Coding Agent implements an approved contract only. It does not plan, alter intent/spec/plan, move Trello, evaluate its own outcome, approve, merge, push, or release.
- A candidate with passing deterministic validation is `candidate_complete`, never approved or done.
- Prefer deterministic validation and schema enforcement to prompt-only controls. Do not weaken a safety boundary for convenience.
- Never log or commit secrets, credentials, hidden model reasoning, or sensitive content outside the authorized artifacts.

Document a material deviation, compatibility effect, and migration path before changing an external contract.
