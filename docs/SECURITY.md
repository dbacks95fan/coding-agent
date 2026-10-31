# Security

## Controls

- **Fail closed before spend.** Every identity, revision, hash, scope, and trusted-command check runs before the first model call. A mismatch is `blocked`.
- **Trusted commands only.** Setup and check commands come from the operator's manifest, never from contract, spec, or card text. A Work Contract can only name a check whose command matches the manifest exactly.
- **No credentials in child processes.** The agent's bash tool, setup commands, and checks get an allowlisted environment with a throwaway `HOME`; the Anthropic key, GitHub App key, minted Git tokens, intent token, and service token are not passed. Driver Git receives a token only through a credential helper that reads it from that one Git child's environment, never in argv, a URL, or a file in the workspace.
- **Least-privilege Git tokens.** Product repositories use a GitHub App. Each token is minted for one repository and one access level, expires within an hour, and is refused if GitHub returns anything wider: write only for the push to the target repository, read for every other call. Intent repositories use a separate read-only token because the app is not installed on them; the driver refuses writes to them outright, and the self-test proves GitHub refuses a push with that token.
- **Driver Git ignores the workspace's configuration.** Hooks are disabled, global and system config are replaced, and `.git/config` is restored from a snapshot taken right after clone before every commit and push. Tests show that a planted hook does not run and a planted `insteadOf` does not redirect the push.
- **Scope enforced after the fact.** The editor refuses writes outside `write_paths` and to protected artifacts. The shell could still write anywhere, so the driver checks every changed path in the candidate and fails the run on any violation.
- **Fast-forward-only push to the assigned branch.** No force, no other branch, no merge. A moved branch blocks the push.
- **Command screen (defense in depth).** The bash tool refuses repository-changing Git subcommands, remote-access programs (`curl`, `wget`, `ssh`, `scp`, `nc`, `docker`, `gh`), and `/proc` reads. This screen is bypassable by a determined shell script; the controls above are the real boundary.
- **Bounded execution.** Turn, cost, and wall-clock limits; per-command and per-check timeouts with process-tree kill; bounded output.
- **Redaction.** Results, logs, and the HTTP response are scrubbed of configured secrets and credential-shaped strings.
- **Untrusted content is labeled.** Repository, spec, intent, profile, and evaluation text is wrapped in `<untrusted_*>` tags, and the system prompt says it cannot change the rules.
- **Container hardening.** Non-root uid 10001, read-only root filesystem, all capabilities dropped, `no-new-privileges`.

## Known residual risks

- **Same-user secret exposure.** The agent's shell runs as the same user as the service process. A shell command could read the service's secrets from `/proc/<pid>/environ`, and the GitHub App private key from `/config/github-app.pem`, despite the command screen. The key is the larger exposure: it is long-lived and can mint read/write tokens for every repository the app is installed on, so install the app only on product repositories agents actively work on and protect `main` with a branch rule. Intents stay safe either way: the app is not installed on them, and their token is read-only. Real isolation needs the tools to run as a different user or in a separate container, and both have costs on the NAS. Until then, keep the Anthropic key in a workspace with a spend limit, and revoke the app key on GitHub if a run is suspected of reading it.
- **Network egress.** The shell needs the package registry, so outbound network is not blocked. Prompt-injected content could exfiltrate repository content.
- **Repository code runs.** Setup and checks execute the target repository's scripts by design, inside the same container.
