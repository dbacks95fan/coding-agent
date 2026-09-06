# Security and Safety Requirements

- Preserve worktree isolation, path confinement, protected-branch denial, and the existing deny rules for pushes, merges, deployment, remote shell transfer, and external service access.
- Keep MCP servers and ambient outer-session permissions unavailable to the agent unless a separately reviewed capability is explicitly introduced.
- Validate contract paths against the target repository root and reject traversal, cross-work-item writes, mutable references, and unrecognized validation gates.
- Use least-privilege credentials and environment-injected secrets only. Never log, emit, commit, or return secret values.
- Enforce bounded model turns, spend, execution time, subprocess output, and disk usage. Surface limit exhaustion as a safe terminal result.
- Record sanitized audit events for preflight, permissions, worktree, model-run metadata, independent validation, commits, and final result.
- Treat code, contracts, repository instructions, tool output, and model output as untrusted until validated against this contract.
