# coding-agent (v0.1)

Executes one approved Work Contract against a target git repository using the
Claude Agent SDK, and produces an independently-verified Evidence Package. Part of
an experimental Agentic SDLC — see [ARCHITECTURE.md](./ARCHITECTURE.md) for the full
design and rationale.

This tool does not plan work, does not evaluate whether a result should be
"Done", and does not talk to Trello. It takes a contract and a repo, and hands
back structured proof.

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
- npm scripts matching the gate names it knows how to run independently:
  `npm run build`, `npm run test:server`, `npm run test:e2e`, plus a root
  `Dockerfile` for the `docker_build` gate. See `src/validators.ts` — this mapping
  is intentionally a fixed convention, not something the contract or the agent can
  redefine.

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
