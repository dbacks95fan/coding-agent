# Test Strategy

Tests use Node's built-in runner (`npm test`). Git-dependent tests create real bare repositories that stand in for GitHub, so the byte-exact, ancestry, push, and concurrency behavior is exercised for real. The model is replaced by a scripted client except in the live test.

| Layer | Files | What it proves |
| --- | --- | --- |
| Unit | `lifecycle`, `paths`, `redact`, `commands`, `config`, `manifest`, `invocation`, `tools`, `agentLoop`, `evidence` tests | Schema enforcement (including formats and version rejection), path confinement, scrubbed environments, trusted-command matching, admission rules, tool permission boundaries, loop limits and stop reasons, status rules |
| Integration | `git.test.ts`, `preflight.test.ts`, `run.test.ts`, `selfTest.test.ts` | Driver Git against real repositories, each preflight rejection, and full runs: success, failing check, scope violation, frozen-input tampering, needs_decision, setup failure, concurrent writer, planted Git config, rework, secret redaction |
| End to end | `service.test.ts` | An invocation submitted and polled over HTTP produces a pushed candidate and schema-valid StageResult and Evidence Package |
| Deployment scripts | `scripts/tests/DeployScripts.Tests.ps1` (`npm run test:deploy`) | Package layout and checksums, staging on /volume2, the ssh command shape, secrets checks that never echo values, and agreement between compose, installer, and secrets script |
| Live end to end | `live.e2e.ts` (`npm run test:live`) | A real Claude model completes a small contract through the whole pipeline. It costs money, so it is not part of `npm test`. |

The suite also runs on Linux inside the production image, covering the POSIX process-group kill path.

Green tests are evidence that this component honors its contract. They are not evidence that any particular candidate delivers its product outcome; that is the Evaluator's and the accountable human's job.
