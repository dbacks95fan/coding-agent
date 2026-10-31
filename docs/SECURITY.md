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
- **Container hardening.** Read-only root filesystem, every capability dropped except SETUID and SETGID, `no-new-privileges`. The service starts as root only long enough to load its settings and the root-only GitHub App key, then switches to uid 10001 for good before any job runs; it refuses to continue if the switch fails.
- **Secrets hidden from job commands.** Job commands run as uid 10001, the same user as the service. Because the service changed user, the kernel marks it non-dumpable, so they cannot read its `/proc/<pid>/environ` or memory, and the key file is readable only by root. Verified on the NAS's 3.10 kernel.

## Known residual risks

- **Tokens in transit to Git.** Each driver Git call receives its one-repository token in that Git child's environment, which a job process still running at that moment could read. Such a token is limited to one repository and one access level and expires within an hour. Install the app only on product repositories agents actively work on, and protect `main` with a branch rule.
- **Brief root at startup.** The NAS's kernel has no user namespaces, so container root is host root until the service drops it, with only SETUID and SETGID, a read-only filesystem, and `no-new-privileges` during that window.
- **Network egress.** The shell needs the package registry, so outbound network is not blocked. Prompt-injected content could exfiltrate repository content.
- **Repository code runs.** Setup and checks execute the target repository's scripts by design, inside the same container.
