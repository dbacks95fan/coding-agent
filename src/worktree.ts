import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Worktree {
  path: string;
  branch: string;
  baseBranch: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Creates an isolated git worktree on a new branch for one work item. */
export function createWorktree(repoRoot: string, workItem: string, baseBranch: string): Worktree {
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  if (current === baseBranch) {
    // fine — worktree is created FROM baseBranch regardless of what's currently checked out
  }

  const parent = mkdtempSync(join(tmpdir(), "coding-agent-"));
  const path = join(parent, workItem).replace(/\\/g, "/");
  const branch = `agent/${workItem}`;

  // A prior aborted/crashed run may have left this branch attached to another
  // worktree (e.g. if the process exited before cleanup ran) — remove that
  // worktree first, then the branch, before creating a fresh one.
  try {
    const list = git(["worktree", "list", "--porcelain"], repoRoot);
    const entries = list.split("\n\n").filter(Boolean);
    for (const entry of entries) {
      const pathLine = entry.split("\n").find((l) => l.startsWith("worktree "));
      const branchLine = entry.split("\n").find((l) => l.startsWith("branch "));
      if (pathLine && branchLine?.endsWith(`/${branch}`)) {
        const stalePath = pathLine.replace("worktree ", "").trim();
        try {
          git(["worktree", "remove", "--force", stalePath], repoRoot);
        } catch {
          // best effort
        }
      }
    }
  } catch {
    // worktree list failed — nothing to clean up
  }

  try {
    git(["branch", "-D", branch], repoRoot);
  } catch {
    // no such branch — fine
  }

  git(["worktree", "add", path, "-b", branch, baseBranch], repoRoot);
  return { path, branch, baseBranch };
}

export function removeWorktree(repoRoot: string, wt: Worktree): void {
  try {
    git(["worktree", "remove", "--force", wt.path], repoRoot);
  } catch {
    // best effort
  }
  try {
    rmSync(wt.path, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
