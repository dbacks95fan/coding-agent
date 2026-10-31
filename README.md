# coding-agent

The Coding Agent for the [Agentic SDLC](https://github.com/dbacks95fan/agentic-sdlc) Execution stage. It receives a `StageInvocation` 1.1 from the Conductor, fetches the assigned work branch at the exact handoff commit, verifies every frozen and accepted input, implements the accepted `spec.md` and Work Contract v3 with Claude, independently re-runs the contract's required checks, and pushes the candidate commit plus a canonical Evidence Package to the work branch. It returns a correlated `StageResult`.

It never approves, merges, releases, moves Trello cards, or changes the intent, policy profile, spec, or Work Contract. `candidate_complete` means "ready for the independent Evaluator", not "done".

The normative contract is `agentic-sdlc` (Stage Contracts Â§4 Execution, Artifacts, Workflow, Governance, and `schemas/lifecycle-contracts.schema.json`). This repository vendors that schema byte-for-byte; `npm run check:schema-sync` confirms it matches a sibling checkout.

## How a run works

1. **Admit** the invocation: schema 1.1, stage `execution`, matching work identity, `workspace_ref` equal to `work/<intent-id>`, trusted repositories, recognized inputs, normalized `read_paths`/`write_paths`. Anything wrong returns `blocked` before any network or model call.
2. **Fetch and verify**: the remote branch tip must equal `target.commit_sha` (the handoff). The accepted `spec.md` and `work-contract.yaml` must hash correctly at their accepted commit and be unchanged at the handoff. The frozen intent and policy-profile copies must match the freeze fingerprints, and their originals are fetched from `intent-backlog` and checked too. The Work Contract must agree with the freeze and target. Every required check must appear, with the identical command, in the trusted manifest.
3. **Set up** the repository with its manifest setup commands (for example `npm ci`).
4. **Implement** with Claude through the Messages API: Anthropic's bash and text-editor tools plus a `submit_report` tool, bounded by turns, estimated cost, and wall-clock time.
5. **Check scope**: the driver folds all changes into one candidate commit on the handoff and rejects any changed path outside `write_paths` or touching a frozen or recorded artifact.
6. **Validate independently**: each required check runs exactly as the manifest defines it. The agent's own claims never decide the status.
7. **Publish** (only for `candidate_complete`): commit the Evidence Package after the candidate and push fast-forward only. If the branch moved, nothing is pushed and the result is `blocked`.

Other outcomes (`needs_decision`, `blocked`, `failed`) push nothing and explain why in `StageResult.findings`.

## Commands

```
npm ci
npm run check            # typecheck, lint, format check, tests, build
npm run test:live        # real Claude API run against local repos; costs money, needs ANTHROPIC_API_KEY
npm run check:schema-sync

node dist/cli.js run --invocation <stage-invocation.json>
node dist/cli.js serve
node dist/cli.js self-test
```

`run` prints `{stage_result, evidence_package, diagnostics}` and exits `0` candidate_complete, `1` failed, `2` blocked, `3` needs_decision, `4` input could not be correlated, `64` usage error.

## HTTP API (`serve`)

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | `200 {"status":"ok","busy":bool}` |
| `POST /invocations` | Bearer | Body is a StageInvocation. `202` starts it; resubmitting the same body is idempotent; different content for the same ID or a second concurrent run returns `409`. |
| `GET /invocations/{id}` | Bearer | `{"state":"running"}` or `{"state":"done","stage_result":â€¦,"evidence_package":â€¦,"diagnostics":â€¦}` |
| `POST /self-test` | Bearer | Toolchain, a GitHub App token for every access a run can need, Git access to every manifest repository, proof that the intent token cannot write, and one tiny model request. `200` all pass, `503` otherwise. |

See [docs/INTEGRATION.md](docs/INTEGRATION.md) for what the Conductor must send and verify.

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | required | Claude API key |
| `CODING_AGENT_GITHUB_APP_ID` / `_INSTALLATION_ID` / `_PRIVATE_KEY_FILE` | none | GitHub App for the driver's Git calls on product repositories. All three or none; none only suits local remotes. See [GitHub access](#github-access). |
| `CODING_AGENT_INTENT_TOKEN` | none | Read-only fine-grained token for the intent repositories. Required when they are on GitHub. |
| `CODING_AGENT_API_TOKEN` | required for `serve` | Bearer token the Conductor sends |
| `CODING_AGENT_MANIFEST` | `/etc/coding-agent/manifest.json` | Trusted repositories, setup, and check commands ([MealFlow](config/manifest.json)) |
| `CODING_AGENT_MODEL` / `CODING_AGENT_EFFORT` | `claude-opus-5-5` / `high` | Execution-plane model and effort |
| `CODING_AGENT_SERVER_SIDE_FALLBACK` | `on` | On a policy refusal the API retries the turn on a fallback model; the model that answered is recorded |
| `CODING_AGENT_MAX_TURNS` / `_MAX_COST_USD` / `_MAX_RUNTIME_MIN` | `60` / `5` / `30` | Run limits; hitting one returns `blocked` |
| `CODING_AGENT_PRICE_*` | Opus 5.5 list prices | Per-million-token prices used for the cost ceiling |
| `CODING_AGENT_WORK_ROOT` | OS temp | Per-run scratch space; each run's directory is deleted afterward |
| `CODING_AGENT_SHELL` | `bash` | Shell for agent commands, setup, and checks |
| `CODING_AGENT_COMMAND_ENV_<NAME>` | none | Passed to commands as `<NAME>` (for example shared npm and Playwright caches) |

## GitHub access

The driver uses two credentials, chosen per remote, so GitHub itself enforces that intents are never written:

- **Product repositories: a GitHub App.** The app has **Contents: read and write** and **Metadata: read**, webhooks off, and is installed on product repositories only. For each Git call the driver asks for a one-hour token limited to that call's one repository: **write** only to push to the target repository, **read** otherwise. Tokens are reused until ten minutes before they expire, and a token GitHub returns with any wider scope is refused.
- **Intent repositories: a read-only fine-grained token** (`CODING_AGENT_INTENT_TOKEN`), because the app is not installed there. The driver refuses any write to an intent repository before Git runs, and the self-test proves the token cannot write with a dry-run push that GitHub must refuse.
- Credentials stay in the service process. Git sees a token only through a credential helper that reads it from the Git child's environment; agent shell commands never receive them.

## Deploying on the NAS

The container never runs the Claude Code CLI, which cannot run on the NAS's 3.10 kernel; it calls the Messages API with an API key. It starts as root with only SETUID and SETGID, loads its secrets, and switches to uid 10001 before any job runs (see [docs/SECURITY.md](docs/SECURITY.md)); it has a read-only root, `no-new-privileges`, host networking on port 8081 (bridge NAT drops outbound traffic on this NAS, and the Evaluator owns 8080), and data under `/volume2/docker/coding-agent-data`.

1. Copy `.env.example` to `C:\Repos\.config\coding-agent\runtime.env`, outside any repository, and fill in `ANTHROPIC_API_KEY`, the GitHub App's ID, installation ID, and the path to its `.pem` private key on this PC, the read-only `CODING_AGENT_INTENT_TOKEN`, and a random `CODING_AGENT_API_TOKEN` of at least 32 characters.
2. `scripts/set-nas-secrets.ps1` checks that file and the key, then writes the key to `/volume2/docker/coding-agent/github-app.pem` and the settings to `/volume2/docker/coding-agent/.runtime.env` (both mode 600) over SSH stdin. Values are never printed or put on a command line.
3. `scripts/deploy-synology.ps1` builds the image from a committed revision on this PC, gzips it with the compose file, installer, and `config/manifest.json`, stages it under `/volume2/docker/coding-agent-data/incoming` (not `/tmp`, which is a RAM disk smaller than the image), and runs `scripts/install-on-nas.sh`.
4. The installer refuses to change anything if a secret or the key is missing, then loads the image, copies the key to `/volume2/docker/coding-agent-data/secrets` readable only by the container user, starts it with the NAS's `docker-compose` 1.28, and reports success only when `GET /health` returns `200` and `POST /self-test` passes. The self-test makes one tiny paid model request.

Defaults: host `10.100.10.10`, user `DockerDeploy`, key `~/.ssh/nas_key`. `npm run test:deploy` runs the Pester tests for these scripts.
## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): design and why each boundary exists
- [docs/INTEGRATION.md](docs/INTEGRATION.md): the Conductor contract
- [docs/SECURITY.md](docs/SECURITY.md): controls and known residual risks
- [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md): what the tests prove
- [docs/DECISIONS.md](docs/DECISIONS.md): decisions and open questions
