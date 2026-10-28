// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: The driver's Git operations: fetch, byte-exact reads, candidate commits, and fast-forward-only push.
// ABOUTME: Runs without hooks or ambient config so files the agent's shell writes cannot steer these calls.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitIdentity {
  name: string;
  email: string;
}

export class GitError extends Error {}

/**
 * The credential helper reads the token from this process's environment at call
 * time, so the token never appears in argv, a URL, or a file in the workspace.
 */
const CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$CODING_AGENT_GIT_TOKEN"; }; f';

export class DriverGit {
  private readonly globalConfig: string;
  private readonly hooksDir: string;

  constructor(
    private readonly home: string,
    private readonly identity: GitIdentity,
    private readonly token?: string,
  ) {
    mkdirSync(home, { recursive: true });
    this.globalConfig = join(home, "driver.gitconfig");
    this.hooksDir = join(home, "no-hooks");
    mkdirSync(this.hooksDir, { recursive: true });
    writeFileSync(this.globalConfig, "");
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: this.globalConfig,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: this.identity.name,
      GIT_AUTHOR_EMAIL: this.identity.email,
      GIT_COMMITTER_NAME: this.identity.name,
      GIT_COMMITTER_EMAIL: this.identity.email,
    };
    for (const name of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    if (this.token) env.CODING_AGENT_GIT_TOKEN = this.token;
    return env;
  }

  private baseArgs(): string[] {
    const args = [
      "-c",
      `core.hooksPath=${this.hooksDir}`,
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "safe.directory=*",
    ];
    if (this.token) args.push("-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`);
    return args;
  }

  async run(args: string[], cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", [...this.baseArgs(), ...args], {
        cwd,
        env: this.env(),
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr;
      const detail = stderr && stderr.trim() ? stderr : err instanceof Error ? err.message : String(err);
      throw new GitError(`git ${args[0]} failed: ${String(detail).trim().slice(0, 2000)}`);
    }
  }

  /** Reads one file's exact bytes at a commit; null when the path does not exist there. */
  async readBlob(repoDir: string, commit: string, path: string): Promise<Buffer | null> {
    try {
      const { stdout } = await execFileAsync("git", [...this.baseArgs(), "cat-file", "blob", `${commit}:${path}`], {
        cwd: repoDir,
        env: this.env(),
        windowsHide: true,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
    }
  }

  /** The commit the remote branch points at, or null when the branch does not exist. */
  async remoteTip(url: string, branch: string, cwd: string): Promise<string | null> {
    const out = await this.run(["ls-remote", "--heads", url, `refs/heads/${branch}`], cwd);
    const line = out.split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`));
    return line ? line.split("\t")[0] : null;
  }

  async cloneBranch(url: string, branch: string, dir: string, cwd: string): Promise<void> {
    await this.run(["clone", "--quiet", "--no-tags", "--single-branch", "--branch", branch, url, dir], cwd);
  }

  /** Fetches a single commit by SHA into a scratch repository for byte-exact reads. */
  async fetchCommit(url: string, commit: string, dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    await this.run(["init", "--quiet", "--bare"], dir);
    await this.run(["fetch", "--quiet", "--depth", "1", url, commit], dir);
  }

  async head(repoDir: string): Promise<string> {
    return this.run(["rev-parse", "HEAD"], repoDir);
  }

  async isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.run(["merge-base", "--is-ancestor", ancestor, descendant], repoDir);
      return true;
    } catch {
      return false;
    }
  }

  async changedPaths(repoDir: string, from: string, to: string): Promise<string[]> {
    const out = await this.run(["diff", "--name-only", "--no-renames", "-z", from, to], repoDir);
    return out.split("\0").filter(Boolean);
  }

  /** Keeps the driver's view of `.git/config` so it can undo anything written there during the run. */
  snapshotConfig(repoDir: string): Buffer {
    return readFileSync(join(repoDir, ".git", "config"));
  }

  restoreConfig(repoDir: string, snapshot: Buffer): void {
    writeFileSync(join(repoDir, ".git", "config"), snapshot);
  }

  /**
   * Turns the working tree into one candidate commit on top of the handoff commit.
   * A soft reset folds in any commits the agent made despite instructions, so the
   * branch history stays linear: handoff -> candidate -> evidence.
   */
  async commitCandidate(repoDir: string, handoff: string, message: string): Promise<string> {
    await this.run(["reset", "--quiet", "--soft", handoff], repoDir);
    await this.run(["add", "--all"], repoDir);
    await this.run(["commit", "--quiet", "--allow-empty", "-m", message], repoDir);
    return this.head(repoDir);
  }

  /** Commits exactly one path, ignoring anything else in the index or working tree. */
  async commitSinglePath(repoDir: string, path: string, message: string): Promise<string> {
    await this.run(["add", "--force", "--", path], repoDir);
    await this.run(["commit", "--quiet", "-m", message, "--only", "--", path], repoDir);
    return this.head(repoDir);
  }

  async trackedChanges(repoDir: string): Promise<string[]> {
    const out = await this.run(["status", "--porcelain", "--untracked-files=no", "-z"], repoDir);
    return out
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.slice(3));
  }

  /** Pushes a commit to the branch without force; Git rejects it if the branch moved. */
  async pushFastForward(repoDir: string, url: string, commit: string, branch: string): Promise<void> {
    await this.run(["push", "--quiet", "--porcelain", url, `${commit}:refs/heads/${branch}`], repoDir);
  }
}
