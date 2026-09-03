# Coding Agent v0.1 — Architecture

Part of an experimental Agentic SDLC (Kanban flow, XP quality practices, AI execution,
human judgment). This document covers only the Coding Agent — the component that,
given an approved Work Contract and a repository, produces a candidate implementation
and independently-checked evidence that it satisfies the contract. It does not plan
work (Planner), independently re-judge the result (Evaluator), or talk to Trello.

## Position in the larger system

```
Human -> Codex Planner -> Work Contract -> [Coding Agent] -> Deterministic Graders
                                                                    |
                                                                    v
                                            Codex Evaluator -> Human Approver
```

The Coding Agent's world is intentionally narrow: a Work Contract, a repository, a
fixed toolset, fixed boundaries, and a fixed way to prove completion. It does not know
about Trello, WIP limits, or the rest of the workflow.

## Why the Claude Agent SDK, not the bare CLI

The `claude` CLI's headless mode (`-p --output-format json`) has no `--max-turns`
flag, so iteration bounding would require parsing `stream-json` output and killing
the process — fragile. `@anthropic-ai/claude-agent-sdk` exposes `maxTurns` and
`maxBudgetUsd` as first-class `query()` options, returning `error_max_turns` /
`error_max_budget_usd` result subtypes when hit, plus `canUseTool` for programmatic
per-call permission decisions and `outputFormat: {type:'json_schema', schema}` to
force the final message into a validated shape. All three are load-bearing for this
design, so the SDK is used directly rather than shelling out to the CLI.

## Isolation

Before invoking the agent, the driver creates a git worktree on a new branch:

```
git worktree add <tmp>/agent-<workItem>-<ts> -b agent/<workItem> <baseBranch>
```

The agent operates entirely inside that worktree (`cwd` is set to it). It commits
locally on the branch. It never pushes, never merges, never touches the caller's
actual working directory or branch.

## Permission model (defense in depth)

1. **Tool allowlist** (`allowedTools`): `Read, Glob, Grep, Edit, Write, Bash`. Nothing
   else is offered — no `WebFetch`, `WebSearch`, `Agent` (no spawning subagents in
   v0.1), no `Artifact`.
2. **Zero MCP surface**: `mcpServers` is left empty and `settingSources: []` is passed,
   so the sub-session inherits no ambient MCP config from the host machine. It cannot
   reach Trello, GitHub connectors, or anything else configured for the outer session,
   regardless of prompt content.
3. **`canUseTool` callback** — the actual enforcement point, evaluated on every tool
   call:
   - `Bash`: deny commands matching `git push`, `git merge`, `git checkout
     (main|master)`, `git switch (main|master)`, `docker push`, `ssh `, `scp `, bare
     `curl`/`wget`, or anything referencing the NAS host or Trello API. Local
     `docker build` / `docker compose build` (required for the `docker_build`
     validation gate) are explicitly allowed.
   - `Write`/`Edit`: deny if the resolved path is outside the worktree root, or if it
     targets the Work Contract file itself, or `.claude/settings*.json`.
4. **`permissionMode: 'default'` with `canUseTool` supplied.** `canUseTool` is the
   programmatic substitute for the interactive permission prompt `'default'` mode
   would otherwise show a human — it's the actual decision-maker described above.
   (`'dontAsk'` looks tempting for headless use but is a different, stricter mode:
   it denies anything not on a *static* pre-approved list and does not consult
   `canUseTool` at all — confirmed the hard way in the first real run, which
   denied even `Read`.) The five allowed tools (`Read`, `Glob`, `Grep`, `Edit`,
   `Write`, `Bash`) are the only ones offered at all (via `tools`), so there is no
   path to a tool `canUseTool` doesn't explicitly reason about.

## Bounded execution

Three independent limits, configurable per run (env or CLI flags), sane defaults:

| Limit | Default | Mechanism | Result on hit |
|---|---|---|---|
| Iterations | 40 turns | SDK `maxTurns` | `error_max_turns` -> `status: blocked` |
| Cost | $2.00 | SDK `maxBudgetUsd` | `error_max_budget_usd` -> `status: blocked` |
| Wall clock | 20 min | `AbortController` + `setTimeout` | abort -> `status: blocked` |

No custom outer retry loop is implemented. The SDK's own agentic loop (Claude reading
tool results, diagnosing failures, and retrying within one `query()` session) already
**is** the read/plan/implement/test/observe/fix loop the design calls for; wrapping it
in a second, hand-rolled loop would just duplicate that mechanism.

## Work Contract

YAML on disk (see `schemas/work-contract.schema.json`, examples in `examples/`).
Loaded and schema-validated *before* the agent is invoked — a structurally invalid
contract never reaches Claude at all; the driver fails fast with a `failed` result
that names the schema violation. A SHA-256 of the raw file is recorded in the audit
log and in the evidence package's `contractHash` field, so any later mismatch between
the contract used and the contract on file is detectable.

The agent is never given a tool capable of writing to the contract path (enforced by
the `canUseTool` path check above), so "the Coding Agent must not modify this
contract" is a mechanical guarantee, not just an instruction.

## v2: intent chain-of-custody gate

A Work Contract (`schema_version: 2`) now carries its own acceptance record inline —
`intent: {path, revision, sha256, reviewUrl, status, acceptedBy, acceptedAt}` — and
its tracker linkage, `board: {provider, workItemId, workItemUrl, workItemType, ...}`.
Most of what a naive implementation would need custom code to check is instead
enforced for free by ordinary JSON Schema validation at `loadContract()` time:
`intent.status` is a `const: "Accepted"`, and `acceptedBy`/`acceptedAt` are required
non-empty strings. A contract that doesn't satisfy this never gets past schema
validation, let alone reaches the agent.

What schema validation *can't* verify — because it has no access to the target
repository's actual file contents — is whether `intent.sha256` still matches the
real, current content of the document at `intent.path`. That's `src/preflight.ts`
(`verifyIntentIntegrity`), run in `cli.ts` immediately after schema validation and
strictly *before* any worktree is created or any SDK call is made:

1. Resolve `intent.path` relative to `--repo`.
2. If the file doesn't exist, or its SHA-256 doesn't match `intent.sha256` — the
   accepted intent has drifted since the contract was approved, or the contract
   points at the wrong document entirely — stop.
3. On failure, emit a `blocked` result (workItem, status, summary, contractHash,
   runId, reasons) directly to stdout and `.agent/evidence/`, exit `2`. No worktree,
   no agent invocation, no cost incurred for a contract that was never going to be
   legitimate to act on.

This is the literal reading of "if the Work Contract is contradictory, impossible,
unsafe, or materially ambiguous, stop and return blocked" applied to the *chain of
custody* specifically, before it's even applied to the work itself — a forged or
stale contract doesn't get a chance to waste a real implementation attempt.

## Evidence is independently verified, not self-reported

The agent's structured final output (`AgentReport`, forced via `outputFormat`)
includes a `selfReportedValidation` block, but **the driver does not trust it**.
After the agent's turn completes (successfully, blocked, or otherwise), the driver:

1. Reads `required_validation` from the (immutable) Work Contract.
2. Independently executes the corresponding command for each entry
   (`npm run build`, `npm run test:server`, `npm run test:e2e`, `docker build .`,
   etc. — mapped per-repo, see `src/validators.ts`) against the worktree, regardless
   of what the agent claimed.
3. Parses real pass/fail/counts from the command output where possible.
4. Writes *that* into the final Evidence Package's `validation` block, and flags a
   `discrepancy` note if the agent's self-report disagreed with reality.

Final `status` is computed by the driver from these independently-observed results,
never taken as-is from the agent:

- `candidate_complete` — every `required_validation` entry independently passed, and
  every acceptance criterion has a `satisfied` entry with evidence.
- `blocked` — an iteration/cost/time limit was hit before the above was reached.
- `needs_decision` — the agent's own output set `status: needs_decision` with an
  `escalations[]` entry (contradictory/impossible/unsafe/materially ambiguous
  contract). The driver does not second-guess this judgment call, but also does not
  let the agent stop here *and* claim `candidate_complete` at the same time.
- `failed` — a hard failure: contract failed schema validation, the worktree could
  not be created, a validation command errored in an unexpected way (not just "tests
  failed" but e.g. the command itself couldn't run), or the agent's output didn't
  conform to the schema at all.

## Evidence Package / Escalation schema

One schema, `schemas/agent-report.schema.json` — evidence-shaped and
escalation-shaped outputs share a shape (`status` discriminates; escalation-only
fields are simply absent on a completed report and vice versa). See that file for the
authoritative shape; matches the examples in the brief. The agent may self-report
`discrepancies` (gaps it's aware of between intent and actual result); the driver
appends its own independently-observed discrepancies (agent claims vs. git diff /
re-run validation) to the same list in the final Evidence Package — both are
informational, neither is trusted over the other's actual evidence.

The pre-flight chain-of-custody failure path (above) emits a smaller, separate shape
— `{workItem, status: "blocked", summary, contractHash, runId, reasons}` — since no
worktree or agent run exists yet to report `filesChanged`, `validation`, etc. against.

## Audit trail

Every run appends one JSON-lines file at
`<repo>/.agent/audit/<workItem>-<runId>.jsonl` with one line per: contract loaded
(+hash), worktree created, each SDK message of type `assistant` (tool calls made,
denied, or allowed) and `result` (turns/cost/duration), each independent validation
command run (+exit code +duration), and the final computed status. This is the
"auditable record of important actions and validation results" — plain JSONL,
greppable, no new infrastructure.

## CLI contract (for the Orchestrator)

```
coding-agent run --contract <path> --repo <path> \
  [--base-branch main] [--max-turns 40] [--max-budget-usd 2] [--max-runtime-min 20] \
  [--discard-worktree]
```

Prints exactly one JSON object (the final Evidence/Escalation Package) to stdout.
Exit codes: `0` candidate_complete, `2` blocked, `3` needs_decision, `1` failed.
`orchestrator` (Trello Conductor) invokes this as a local `node` subprocess
(`src/codingAgent/runCodingAgent.ts` there) and treats it exactly like any other
deterministic CLI tool — no knowledge of the SDK, prompts, or permission model
required, both processes running on the same machine.

## What v0.1 deliberately does not do

- No outer Orchestrator, no Trello polling, no WIP limits — those live in the
  separate `orchestrator` (Trello Conductor) project, which invokes this tool as
  a local subprocess.
- No Codex Planner integration — a separate system this tool's output is
  designed to feed. (The Evaluator step now exists in `orchestrator`, invoked
  after this tool reaches `candidate_complete`.)
- No metrics collection beyond what the SDK hands back for free (turns, cost,
  duration) — written to the audit log so it exists for later aggregation, but no
  dashboard, storage, or analysis is built now.
- No multi-agent / subagent delegation inside the Coding Agent itself.
- No automatic PR creation or push — the worktree and branch are left on disk by
  default (pass `--discard-worktree` to clean up instead) for a human or the
  Orchestrator to inspect, push, or open a PR from.
- **No container packaging.** An earlier revision of this tool was packaged as a
  Docker image intended for unattended NAS deployment (API-key auth, a
  Docker-socket mount for the `docker_build` gate, and — briefly — letting the
  agent push its own branch so work would survive an ephemeral container). That
  path is on hold: the NAS's Docker networking proved unreliable for this use
  (containers intermittently lost outbound internet access, blocking `npm ci`
  during image builds), and the whole thing added real complexity — a second git
  push credential, API billing separate from a claude.ai subscription — for a
  problem local execution doesn't have. Reverted back to local-process execution,
  which is what's actually running today. If NAS deployment comes back later,
  the git history has the container work to build on again.
