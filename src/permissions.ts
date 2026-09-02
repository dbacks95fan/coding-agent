import { resolve, sep } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/** Base toolset offered to the Coding Agent. Nothing else is available at all. */
export const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];

/** Explicitly removed even if a preset would otherwise include them. */
export const DISALLOWED_TOOLS = ["WebFetch", "WebSearch", "Agent", "Artifact", "ExitPlanMode"];

const DENIED_BASH_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+merge\b/i, reason: "The Coding Agent must not merge branches." },
  { pattern: /\bgit\s+(checkout|switch)\s+(-b\s+)?(main|master)\b/i, reason: "The Coding Agent must stay on its assigned branch." },
  { pattern: /\bdocker\s+push\b/i, reason: "The Coding Agent must not push images (no deployment)." },
  { pattern: /\b(ssh|scp)\s/i, reason: "The Coding Agent must not access remote hosts (no deployment credentials)." },
  { pattern: /\b(curl|wget)\s/i, reason: "The Coding Agent must not fetch arbitrary external URLs." },
  { pattern: /trello\.com|api\.trello/i, reason: "The Coding Agent must not touch the requirement management system." },
  { pattern: /\brm\s+-rf\s+\/(?!$)/i, reason: "Destructive command targeting the filesystem root is denied." },
];

function deny(message: string): PermissionResult {
  return { behavior: "deny", message };
}

function allow(): PermissionResult {
  return { behavior: "allow" };
}

/**
 * `git push` is narrowly allowed — the agent may push its own work branch to
 * `origin` so the result survives a stateless/ephemeral run (e.g. a container
 * whose filesystem disappears on exit), but may never push `main`/`master` or
 * anything else. This is a text-pattern check on the literal Bash command, the
 * same limitation every other rule here has — it is not a full shell parser —
 * but the worktree itself never has `main`/`master` checked out and the agent
 * cannot switch to them (see DENIED_BASH_PATTERNS above), so by elimination
 * the only branch a push here could meaningfully affect is its own.
 */
function checkGitPush(command: string): PermissionResult | null {
  if (!/\bgit\s+push\b/i.test(command)) return null;

  if (/\b(main|master)\b/i.test(command)) {
    return deny("The Coding Agent must never push main/master.");
  }
  if (/--all\b|--mirror\b|--tags\b/i.test(command)) {
    return deny("Bulk-push flags (--all/--mirror/--tags) are denied — only the agent's own work branch may be pushed.");
  }
  // Anything naming a remote other than "origin" right after "push" (a second
  // remote, a raw URL, etc.) is denied — the only remote this worktree should
  // ever need is the one it was cloned/branched from.
  const remoteMatch = command.match(/\bgit\s+push\s+(?:(?:-\S+|--\S+)\s+)*(\S+)/i);
  const namedTarget = remoteMatch?.[1];
  if (namedTarget && namedTarget !== "origin" && !namedTarget.startsWith("-")) {
    return deny(`The Coding Agent may only push to "origin", not "${namedTarget}".`);
  }

  return allow();
}

/**
 * Builds the canUseTool callback for one run, scoped to a specific worktree and
 * contract file so writes cannot escape the sandbox or touch the contract itself.
 */
export function buildPermissionPolicy(worktreePath: string, contractPath: string): CanUseTool {
  const repoRootResolved = resolve(worktreePath) + sep;
  const contractResolved = resolve(contractPath);

  return async (toolName, input) => {
    if (toolName === "Bash") {
      const command = String((input as { command?: string }).command ?? "");

      const pushResult = checkGitPush(command);
      if (pushResult) return pushResult;

      for (const { pattern, reason } of DENIED_BASH_PATTERNS) {
        if (pattern.test(command)) {
          return deny(reason);
        }
      }
      return allow();
    }

    if (toolName === "Write" || toolName === "Edit") {
      const filePath = (input as { file_path?: string }).file_path;
      if (typeof filePath === "string") {
        const resolved = resolve(worktreePath, filePath);
        if (resolved === contractResolved) {
          return deny("The Work Contract is immutable from the Coding Agent's perspective.");
        }
        if (resolved.includes(`${sep}.claude${sep}settings`)) {
          return deny("The Coding Agent must not modify its own permission configuration.");
        }
        if (!resolved.startsWith(repoRootResolved) && resolved !== resolve(worktreePath)) {
          return deny("The Coding Agent may only modify files inside its assigned worktree.");
        }
      }
      return allow();
    }

    return allow();
  };
}
