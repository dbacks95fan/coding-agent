#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { runCodingAgent } from "./agentRunner.js";
import { AuditLog } from "./audit.js";
import { ContractValidationError, loadContract } from "./contract.js";
import { assembleEvidence } from "./evidence.js";
import type { ValidationGate } from "./types.js";
import { runIndependentValidation } from "./validators.js";
import { createWorktree, removeWorktree } from "./worktree.js";

interface Args {
  contract: string;
  repo: string;
  baseBranch: string;
  maxTurns: number;
  maxBudgetUsd: number;
  maxRuntimeMin: number;
  keepWorktree: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback?: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const has = (flag: string) => argv.includes(flag);

  const contract = get("--contract");
  const repo = get("--repo");
  if (!contract || !repo) {
    console.error("Usage: coding-agent run --contract <path> --repo <path> [options]");
    process.exit(1);
  }

  return {
    contract: resolve(contract),
    repo: resolve(repo),
    baseBranch: get("--base-branch", "main")!,
    maxTurns: Number(get("--max-turns", "40")),
    maxBudgetUsd: Number(get("--max-budget-usd", "2")),
    maxRuntimeMin: Number(get("--max-runtime-min", "20")),
    keepWorktree: !has("--discard-worktree"),
  };
}

const STATUS_EXIT_CODES: Record<string, number> = {
  candidate_complete: 0,
  failed: 1,
  blocked: 2,
  needs_decision: 3,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = randomUUID().slice(0, 8);

  let loaded;
  try {
    loaded = loadContract(args.contract);
  } catch (err) {
    if (err instanceof ContractValidationError) {
      console.log(
        JSON.stringify(
          { status: "failed", summary: "Work Contract failed schema validation.", errors: err.errors },
          null,
          2,
        ),
      );
      process.exit(1);
    }
    throw err;
  }

  const { contract, hash } = loaded;
  const audit = new AuditLog(args.repo, contract.work_item, runId);
  audit.write("contract_loaded", { workItem: contract.work_item, contractHash: hash, path: args.contract });

  // Verify the repo is a git repo with the expected base branch.
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: args.repo, encoding: "utf8" });
  } catch {
    console.log(
      JSON.stringify({ status: "failed", summary: `${args.repo} is not a git repository.` }, null, 2),
    );
    process.exit(1);
  }

  const worktree = createWorktree(args.repo, contract.work_item, args.baseBranch);
  audit.write("worktree_created", { path: worktree.path, branch: worktree.branch });

  let exitCode = 1;
  try {
    const outcome = await runCodingAgent(
      contract,
      args.contract,
      args.repo,
      worktree,
      { maxTurns: args.maxTurns, maxBudgetUsd: args.maxBudgetUsd, maxRuntimeMs: args.maxRuntimeMin * 60_000 },
      audit,
    );

    audit.write("independent_validation_started", { gates: contract.required_validation });
    const validation = await runIndependentValidation(
      worktree.path,
      contract.required_validation as ValidationGate[],
      10 * 60_000,
    );
    for (const [gate, result] of Object.entries(validation)) {
      audit.write("validation_gate_result", { gate, status: result.status, exitCode: result.exitCode });
    }

    const evidence = assembleEvidence(contract, hash, runId, worktree, outcome, validation);
    audit.write("final_status", { status: evidence.status });

    const evidencePath = `${args.repo}/.agent/evidence/${contract.work_item}-${runId}.json`;
    mkdirSync(`${args.repo}/.agent/evidence`, { recursive: true });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");

    console.log(JSON.stringify(evidence, null, 2));
    exitCode = STATUS_EXIT_CODES[evidence.status] ?? 1;
  } finally {
    if (!args.keepWorktree) {
      removeWorktree(args.repo, worktree);
    } else {
      audit.write("worktree_kept", { path: worktree.path, branch: worktree.branch });
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
