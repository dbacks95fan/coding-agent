# Project Journal

## 2026-09-06

Documented the existing Coding Agent as a real v0.1 implementation and defined a compatible future contract that consumes frozen intent plus approved design and planning artifacts. The new contract is a target for incremental implementation, not a claim that v3 exists today.

## 2026-10-28

Rebuilt the Coding Agent against the canonical agentic-sdlc Execution contract (StageInvocation 1.1, Work Contract v3, StageResult and EvidencePackage 1.0, schema 1.2.0). Replaced the Claude Agent SDK with a direct Messages API loop because the bundled Claude Code CLI cannot run on the NAS's 3.10 kernel. The agent now fetches the work branch at the handoff SHA and pushes its own candidate and evidence, per the new agent-owned Git handoff rule. Decision: read StageInvocation.target as the handoff commit, since the schema doesn't name a per-stage field; flagged upstream. Frustration: the Conductor still speaks the retired v2 contract, so the Trello path can't reach this worker until it is migrated. Unverified: Chromium on the NAS kernel.
