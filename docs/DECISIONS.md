# Decisions

## Decided

- **Canonical contracts only.** The worker accepts StageInvocation 1.1 and Work Contract v3 and emits StageResult 1.0 and EvidencePackage 1.0, validated against the vendored agentic-sdlc schema (`urn:agentic-sdlc:lifecycle-contracts:1.2.0`). The earlier Work Contract v2 CLI was removed rather than kept alongside it, because the SDLC says consumers must reject older versions instead of coercing them.
- **Messages API engine.** The Claude Agent SDK was replaced by a direct Messages API loop because its bundled CLI cannot run on the NAS kernel. Model `claude-opus-5-5`, effort `high`, server-side refusal fallback on.
- **The agent pushes its own work branch.** This follows the agentic-sdlc rule that agents, not the Conductor, push. Only `candidate_complete` pushes; the push is fast-forward only and blocked if the branch moved.
- **Starting commit.** `StageInvocation.target.commit_sha` is the handoff commit Coding starts from; the Work Contract's `target` is the earlier product base and must be its ancestor.
- **Inputs recognized by path.** Spec, Work Contract, and Evaluation Package inputs are identified by their `.agent/work/<intent-id>/` paths, following the Architecture's suggested layout.
- **Evidence location.** `.agent/work/<intent-id>/evidence-package/<invocation-id>.json`, committed after the candidate.
- **Trusted check manifest is operator configuration.** It lives with the deployment, not in the product repository, so no spec or agent change can widen what runs.
- **Transport.** Authenticated HTTP with submit-then-poll, one run at a time, results held in memory.
- **HTTP is the only way in.** The command for running one invocation from a file was removed. The agent runs only as the NAS service, using Claude through the API, so a second path would bypass the service's authentication and single-run guard.

## Open

- **Upstream clarification.** agentic-sdlc does not name, per stage, which StageInvocation field carries the handoff commit. A one-line note in Stage Contracts would remove the reliance on reading `target` this way.
- **Conductor migration.** The Conductor must send StageInvocation 1.1 over HTTP and drop its v3-to-v2 adapter and its own pushes. Until it does, Execution through Trello will not reach this worker.
- **Tool isolation.** Running the shell as a separate user would close the same-user secret exposure noted in SECURITY.md.
- **Chromium on the NAS kernel.** Playwright's Chromium has not yet been exercised on the 3.10 kernel; the first real MealFlow run will show it.
