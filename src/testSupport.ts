// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Test helpers: a POSIX shell location and real Git repositories that stand in for GitHub remotes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { stringify as stringifyYaml } from "yaml";
import type { ModelClient, TurnRequest } from "./agentLoop.js";
import type { CheckManifest } from "./manifest.js";
import type { AgentReport } from "./report.js";
import type { StageInvocation } from "./types.js";

/** The shell the tests drive. Windows' own bash.exe is WSL, so Git Bash is used there. */
export function testShell(): string {
  if (process.env.CODING_AGENT_SHELL) return process.env.CODING_AGENT_SHELL;
  if (process.platform === "win32") {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    if (existsSync(gitBash)) return gitBash;
  }
  return "bash";
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    // Capture stderr so Git's progress chatter does not pollute test output; failures still throw with it.
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** Writes exact bytes, creating parent directories. */
export function writeBytes(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, Buffer.from(content, "utf8"));
}

export interface ScenarioOptions {
  /** Trusted check commands written into the manifest. */
  checks?: Record<string, string>;
  /** required_validation in the Work Contract; defaults to every manifest check. */
  requiredValidation?: { name: string; command: string }[];
  setup?: string[];
  productFiles?: Record<string, string>;
  policyControls?: { control_id: string; required_action: string; evidence_expected: string }[];
}

export interface Scenario {
  root: string;
  product: TestRemote;
  intents: TestRemote;
  base: string;
  handoff: string;
  invocation: StageInvocation;
  manifest: CheckManifest;
  intentText: string;
  profileText: string;
}

const INTENT_ID = "INT-T-0001";

/**
 * Builds the state the SDLC hands to Execution: an intent-backlog commit holding the
 * frozen intent and profile, and a product work branch whose head carries the
 * frozen copies plus the accepted spec and Work Contract v3.
 */
export function buildScenario(options: ScenarioOptions = {}): Scenario {
  const root = tempDir("scenario-");
  const intents = new TestRemote(root, "intent-backlog");
  const product = new TestRemote(root, "product");
  const intentText = "# Intent\r\n\r\nShow a greeting on the home page.\r\n";
  const profileText = "# Policy & Compliance Profile\n\nProfile ID: `T-DEFAULT`\n\nVersion: `1`\n";
  const intentCommit = intents.commit(
    {
      "products/t/intents/INT-T-0001/intent.md": intentText,
      "products/t/policy-profiles/T-DEFAULT.md": profileText,
    },
    "intent v1",
  );

  const base = product.commit(
    options.productFiles ?? {
      "README.md": "# Product\n",
      "src/greeting.txt": "hello\n",
      "CLAUDE.md": "Product instructions for agents.\n",
    },
    "base",
  );
  product.branchFrom(base, `work/${INTENT_ID}`);

  const checks = options.checks ?? { build: "test -f src/greeting.txt" };
  const requiredValidation =
    options.requiredValidation ?? Object.entries(checks).map(([name, command]) => ({ name, command }));
  const work = `.agent/work/${INTENT_ID}`;
  const workItem = { product_id: "T", intent_id: INTENT_ID, intent_version: 1, trello_card_id: "card-t" };
  const intentRef = {
    repository: intents.url,
    commit_sha: intentCommit,
    path: "products/t/intents/INT-T-0001/intent.md",
    sha256: sha256(intentText),
  };
  const profileRef = {
    repository: intents.url,
    commit_sha: intentCommit,
    path: "products/t/policy-profiles/T-DEFAULT.md",
    sha256: sha256(profileText),
  };
  const contract = {
    schema_version: 3,
    work_item: workItem,
    intent: intentRef,
    policy_profile_id: "T-DEFAULT",
    policy_profile_version: "1",
    policy_profile: profileRef,
    target: { repository: product.url, commit_sha: base },
    acceptance_criteria: ["The greeting reads 'hello, world'."],
    permitted_scope: { included: ["Greeting text"], excluded: ["Anything else"] },
    required_validation: requiredValidation,
    policy_controls: options.policyControls ?? [
      { control_id: "SEC-BASE-001", required_action: "Do not hardcode secrets.", evidence_expected: "Review note." },
    ],
    release_requirements: [],
    observation_requirements: [],
  };
  const specText = "# Spec\n\n## Outcome and scope\n\nChange the greeting to 'hello, world'.\n";
  const contractText = stringifyYaml(contract);
  const handoff = product.commit(
    {
      [`${work}/intent.md`]: intentText,
      [`${work}/policy-profile.md`]: profileText,
      [`${work}/spec.md`]: specText,
      [`${work}/work-contract.yaml`]: contractText,
    },
    "spec and contract accepted",
    `work/${INTENT_ID}`,
  );

  const invocation: StageInvocation = {
    schema_version: "1.1",
    invocation_id: "inv-t-1",
    trigger_event_id: "evt-t-1",
    stage: "execution",
    work_item: workItem,
    freeze_activation: {
      schema_version: "1.0",
      event_id: "freeze-t-1",
      event_type: "activated",
      work_item: workItem,
      intent: intentRef,
      policy_profile_id: "T-DEFAULT",
      policy_profile_version: "1",
      policy_profile: profileRef,
      authorized_by: "owner-t",
      recorded_at: "2026-10-27T10:00:00Z",
    },
    input_artifacts: [
      { repository: product.url, commit_sha: handoff, path: `${work}/spec.md`, sha256: sha256(specText) },
      {
        repository: product.url,
        commit_sha: handoff,
        path: `${work}/work-contract.yaml`,
        sha256: sha256(contractText),
      },
    ],
    target: { repository: product.url, commit_sha: handoff },
    workspace_ref: `work/${INTENT_ID}`,
    read_paths: ["."],
    write_paths: ["src", `${work}/evidence-package`],
  };
  const manifest: CheckManifest = {
    repositories: [{ url: product.url, setup: options.setup ?? [], checks }],
    intent_repositories: [intents.url],
  };
  return { root, product, intents, base, handoff, invocation, manifest, intentText, profileText };
}

/**
 * A bare repository acting as the remote, plus a scratch clone used to author commits.
 * `uploadpack.allowAnySHA1InWant` mirrors GitHub, which serves any reachable commit by SHA.
 */
export class TestRemote {
  readonly bare: string;
  readonly author: string;
  readonly url: string;

  constructor(
    readonly root: string,
    name: string,
  ) {
    this.bare = join(root, `${name}.git`);
    this.author = join(root, `${name}-author`);
    mkdirSync(this.bare, { recursive: true });
    git(this.bare, ["init", "--bare", "--initial-branch=main"]);
    git(this.bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    mkdirSync(this.author, { recursive: true });
    git(this.author, ["init", "--quiet", "--initial-branch=main"]);
    git(this.author, ["remote", "add", "origin", this.bare]);
    this.url = fileUrl(this.bare);
  }

  commit(files: Record<string, string>, message: string, branch = "main"): string {
    git(this.author, ["checkout", "-B", branch]);
    for (const [path, content] of Object.entries(files)) writeBytes(this.author, path, content);
    git(this.author, ["add", "-A"]);
    git(this.author, ["commit", "--allow-empty", "-m", message]);
    git(this.author, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
    return git(this.author, ["rev-parse", "HEAD"]);
  }

  branchFrom(base: string, branch: string): void {
    git(this.author, ["checkout", "-B", branch, base]);
    git(this.author, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  }

  tip(branch: string): string {
    return git(this.bare, ["rev-parse", `refs/heads/${branch}`]);
  }

  show(commit: string, path: string): string {
    return git(this.bare, ["show", `${commit}:${path}`]);
  }
}

type Message = Anthropic.Beta.BetaMessage;

export function toolUse(id: string, name: string, input: unknown): Anthropic.Beta.BetaContentBlock {
  return { type: "tool_use", id, name, input } as Anthropic.Beta.BetaContentBlock;
}

export function message(content: Anthropic.Beta.BetaContentBlock[], stop_reason: string = "tool_use"): Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Message;
}

export const completeReport: AgentReport = {
  status: "candidate_complete",
  summary: "Changed the greeting.",
  acceptance_criteria: [{ index: 0, status: "satisfied", evidence: "src/greeting.txt now reads hello, world." }],
  policy_controls: [{ control_id: "SEC-BASE-001", outcome: "addressed", summary: "No secrets added." }],
  decisions_needed: [],
  risks: [],
  checks_run: [{ name: "build", outcome: "passed", summary: "ok" }],
};

/** Replays fixed responses and records what it was sent. */
export class ScriptedClient implements ModelClient {
  readonly requests: TurnRequest[] = [];
  constructor(private readonly script: (Message | ((signal: AbortSignal) => Promise<Message>))[]) {}
  async send(request: TurnRequest, signal: AbortSignal): Promise<Message> {
    this.requests.push(structuredClone(request));
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return typeof next === "function" ? next(signal) : next;
  }
}
