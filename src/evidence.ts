import { execFileSync } from "node:child_process";
import type { AgentRunOutcome } from "./agentRunner.js";
import type { EvidencePackage, IndependentValidationResult, ValidationGate, WorkContract } from "./types.js";
import type { Worktree } from "./worktree.js";

/**
 * Committed AND uncommitted changes, tracked AND untracked — the agent is
 * instructed to commit before finishing, but this must not silently under-report
 * if it doesn't (a bare `base...HEAD` diff would miss uncommitted work entirely,
 * which is exactly what happened in early testing: real changes existed on disk,
 * HEAD was untouched, and the diff came back empty).
 */
function gitChangedFiles(worktreePath: string, baseBranch: string): string[] {
  const run = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: worktreePath, encoding: "utf8" });
    } catch {
      return "";
    }
  };

  const trackedSinceBase = run(["diff", "--name-only", baseBranch]);
  const untracked = run(["ls-files", "--others", "--exclude-standard"]);

  const all = new Set(
    [...trackedSinceBase.split("\n"), ...untracked.split("\n")].map((l) => l.trim()).filter(Boolean),
  );
  return [...all];
}

export function assembleEvidence(
  contract: WorkContract,
  contractHash: string,
  runId: string,
  worktree: Worktree,
  outcome: AgentRunOutcome,
  validation: Record<string, IndependentValidationResult>,
): EvidencePackage {
  const discrepancies: string[] = [];
  const report = outcome.report;

  const acceptanceCriteria: EvidencePackage["acceptanceCriteria"] = {};
  for (const acId of Object.keys(contract.acceptance_criteria)) {
    const reported = report?.acceptanceCriteria?.[acId];
    acceptanceCriteria[acId] = reported ?? { status: "not_satisfied", evidence: [] };
  }

  if (report?.selfReportedValidation) {
    for (const [gate, self] of Object.entries(report.selfReportedValidation)) {
      const real = validation[gate];
      if (real && self.status !== real.status && !(self.status === "not_run" && real.status !== "pass")) {
        discrepancies.push(
          `Agent self-reported "${gate}" as ${self.status}, independent execution observed ${real.status}.`,
        );
      }
    }
  }

  const filesChanged = gitChangedFiles(worktree.path, worktree.baseBranch);
  if (report?.filesChanged) {
    for (const f of report.filesChanged) {
      if (!filesChanged.includes(f)) {
        discrepancies.push(`Agent claimed it changed "${f}" but it does not appear in the actual git diff.`);
      }
    }
  }

  const allGatesPass = (contract.required_validation as ValidationGate[]).every(
    (g) => validation[g]?.status === "pass",
  );
  const allAcSatisfied = Object.values(acceptanceCriteria).every((ac) => ac.status === "satisfied");

  let status: EvidencePackage["status"];
  if (report?.status === "needs_decision" && report.escalations?.length) {
    status = "needs_decision";
  } else if (outcome.limitHit) {
    status = "blocked";
  } else if (!report || !outcome.reportSchemaValid) {
    status = "failed";
  } else if (allGatesPass && allAcSatisfied) {
    status = "candidate_complete";
  } else if (report.status === "blocked") {
    status = "blocked";
  } else {
    status = "failed";
  }

  return {
    workItem: contract.work_item,
    status,
    summary: report?.summary ?? "Agent did not produce a valid structured report.",
    contractHash,
    runId,
    acceptanceCriteria,
    validation,
    filesChanged,
    assumptions: report?.assumptions ?? [],
    risks: report?.risks ?? [],
    escalations: report?.escalations ?? [],
    discrepancies,
    execution: {
      numTurns: outcome.numTurns,
      totalCostUsd: outcome.totalCostUsd,
      durationMs: outcome.durationMs,
      limitHit: outcome.limitHit,
    },
    worktree: { path: worktree.path, branch: worktree.branch, baseBranch: worktree.baseBranch },
  };
}
