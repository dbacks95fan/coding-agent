# coding-agent (v0.1)

The "Coding Agent" step of an experimental Agentic SDLC (Kanban flow, XP quality
practices, AI execution, human judgment). Given an approved **Work Contract**
(YAML) and a target git repository, it implements the contract in an isolated
worktree using the Claude Agent SDK, then **independently re-runs** whatever
validation the contract requires — it does not trust its own claim that tests
pass. Output is one structured Evidence Package, never a self-declared "Done".

It does not plan work, does not decide whether a result is approved, and does
not talk to Trello, GitHub, or anything else — see
[ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and why each boundary
exists.

**Status**: validated end-to-end against a real story in the
[MealFlow](https://github.com/dbacks95fan/menuapp) repo — reached
`candidate_complete` with build, unit, and Playwright gates independently
passing, then merged after human review.

## Install

```
npm install
npm run build
```

## Usage

```
npm run run -- run --contract examples/MEAL-EMPTY-STATE.yaml --repo /path/to/menuapp
```

or, after `npm run build`:

```
node dist/cli.js run --contract <path> --repo <path> [options]
```

Options (all optional):

| Flag | Default | Meaning |
|---|---|---|
| `--base-branch` | `main` | Branch the isolated worktree is created from |
| `--max-turns` | `40` | SDK conversation-turn cap |
| `--max-budget-usd` | `2` | SDK API-cost cap |
| `--max-runtime-min` | `20` | Wall-clock cap |
| `--discard-worktree` | off | Remove the worktree/branch when done instead of leaving it for inspection |

Prints one JSON Evidence Package to stdout. Exit code: `0` candidate_complete,
`2` blocked, `3` needs_decision, `1` failed.

## What it needs in the target repo

- Git repository, with the `--base-branch` (default `main`) present.
- A `CLAUDE.md` or `AGENTS.md` at the repo root (read into the agent's system
  prompt as repository context — not required, but strongly recommended; without
  one the agent proceeds from direct inspection alone).
- The document referenced by the contract's `intent.path` (see below) must
  actually exist in the repo, unchanged since acceptance.
- npm scripts matching the gate names it knows how to run independently:
  `npm run build`, `npm run test:server`, `npm run test:e2e`, plus a root
  `Dockerfile` for the `docker_build` gate. See `src/validators.ts` — this mapping
  is intentionally a fixed convention, not something the contract or the agent can
  redefine.

## Work Contract v2: intent chain of custody

Every contract must be `schema_version: 2` and carry `intent` (its own acceptance
record — path, revision, sha256, reviewUrl, status, acceptedBy, acceptedAt) and
`board` (tracker linkage — provider, workItemId, workItemUrl, workItemType). See
`examples/*.yaml` for the shape.

Before touching anything, the tool verifies this chain of custody:

- `intent.status === "Accepted"` and `acceptedBy`/`acceptedAt` are present — enforced
  by schema validation; a contract that fails this is rejected before it's even
  fully loaded.
- `intent.sha256` matches the real, current SHA-256 of the file at `intent.path` in
  the target repo — enforced at runtime (`src/preflight.ts`), since schema
  validation has no way to check actual repo file content.

Either failure returns `status: "blocked"` immediately — no worktree, no SDK call,
no cost — with `reasons` explaining exactly what didn't check out. See
[ARCHITECTURE.md](./ARCHITECTURE.md#v2-intent-chain-of-custody-gate) for the full
rationale.

## What it will not do, on purpose

- Push, merge, or check out `main`/`master`.
- Touch Trello, GitHub, or any other MCP-connected service — the sub-session gets
  zero MCP servers and no ambient settings, regardless of what's configured for
  whoever runs this tool.
- SSH/SCP anywhere, or otherwise touch a deployment target.
- Write to the Work Contract file, or to its own permission settings.
- Trust its own claim that tests pass — `required_validation` gates are re-run by
  this tool after the agent's turn ends, against the resulting code, and that
  result is what's authoritative in the Evidence Package.

## Auditing a run

Every run writes `.agent/audit/<work_item>-<runId>.jsonl` and
`.agent/evidence/<work_item>-<runId>.json` **inside the target repo** (not this
tool's repo) — so the audit trail travels with the code it's about.
