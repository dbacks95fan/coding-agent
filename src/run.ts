// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Executes one Execution-stage invocation end to end and returns a correlated StageResult.
// ABOUTME: admit -> fetch and verify -> setup -> agent loop -> scope check -> candidate -> independent checks -> evidence -> push.
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runAgentLoop, type LoopOutcome, type ModelClient } from "./agentLoop.js";
import { runCommand, sandboxEnv, truncateMiddle } from "./commands.js";
import type { RuntimeConfig } from "./config.js";
import { secretValues } from "./config.js";
import {
  buildEvidencePackage,
  buildStageResult,
  evidenceSummary,
  policyEvidence,
  postValidationVerdict,
  preValidationVerdict,
  scopeViolations,
  type Verdict,
} from "./evidence.js";
import { DriverGit } from "./git.js";
import { admitInvocation, BlockedError, identityOf, type AdmittedInvocation } from "./invocation.js";
import { validateRecord } from "./lifecycle.js";
import type { Logger } from "./log.js";
import type { CheckManifest } from "./manifest.js";
import { prepareWorkspace, type VerifiedInputs } from "./preflight.js";
import { buildRunMessage, SYSTEM_PROMPT } from "./prompt.js";
import { redact } from "./redact.js";
import type { ArtifactRef, CommitRef, EvidencePackage, StageResult, ValidationResult } from "./types.js";

export interface RunDependencies {
  config: RuntimeConfig;
  manifest: CheckManifest;
  model: ModelClient;
  log: Logger;
}

/** Diagnostic detail for people and logs. Not a lifecycle record; the StageResult is authoritative. */
export interface RunDiagnostics {
  reasons: string[];
  changedPaths: string[];
  validation: ValidationResult[];
  agent?: Pick<LoopOutcome, "turns" | "costUsd" | "models" | "limitHit" | "refused" | "report" | "durationMs">;
}

export interface RunOutcome {
  /** Null only when the input was too malformed to correlate to an invocation. */
  stageResult: StageResult | null;
  evidencePackage: EvidencePackage | null;
  diagnostics: RunDiagnostics;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function executeInvocation(raw: unknown, deps: RunDependencies): Promise<RunOutcome> {
  const identity = identityOf(raw);
  const diagnostics: RunDiagnostics = { reasons: [], changedPaths: [], validation: [] };
  const secrets = secretValues(deps.config);
  if (!identity) {
    diagnostics.reasons.push("The request is not a StageInvocation with a usable invocation_id and work_item.");
    return { stageResult: null, evidencePackage: null, diagnostics };
  }

  const runDir = join(
    deps.config.workRoot,
    `${identity.invocationId.replace(/[^A-Za-z0-9._-]/g, "_")}-${randomUUID().slice(0, 8)}`,
  );
  const result = (
    status: StageResult["status"],
    summary: string,
    extra: Partial<Parameters<typeof buildStageResult>[0]> = {},
  ) =>
    buildStageResult({
      invocationId: identity.invocationId,
      stage: identity.stage,
      workItem: identity.workItem,
      status,
      summary: redact(summary, secrets),
      findings: diagnostics.reasons.map((r) => redact(r, secrets)),
      ...extra,
    });

  let outcome: RunOutcome;
  try {
    mkdirSync(runDir, { recursive: true });
    deps.log("run_started", { invocationId: identity.invocationId, intentId: identity.workItem.intent_id });
    outcome = await execute(raw, deps, runDir, diagnostics, result);
  } catch (err) {
    if (err instanceof BlockedError) {
      diagnostics.reasons.push(...err.reasons);
      outcome = {
        stageResult: result("blocked", "The invocation could not proceed; see findings."),
        evidencePackage: null,
        diagnostics,
      };
    } else {
      const message = redact(err instanceof Error ? err.message : String(err), secrets);
      diagnostics.reasons.push(`Unexpected worker failure: ${message}`);
      deps.log("run_error", { invocationId: identity.invocationId, message });
      outcome = {
        stageResult: result("failed", "The worker failed unexpectedly; see findings."),
        evidencePackage: null,
        diagnostics,
      };
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  // The result itself must satisfy the canonical contract before anyone sees it.
  const check = validateRecord("StageResult", outcome.stageResult);
  if (!check.valid) {
    diagnostics.reasons.push(`Internal error: the produced StageResult was invalid: ${check.errors.join("; ")}`);
    outcome = {
      stageResult: result("failed", "The worker produced an invalid result."),
      evidencePackage: null,
      diagnostics,
    };
  }
  deps.log("run_finished", { invocationId: identity.invocationId, status: outcome.stageResult?.status });
  return outcome;
}

type ResultBuilder = (
  status: StageResult["status"],
  summary: string,
  extra?: Partial<Parameters<typeof buildStageResult>[0]>,
) => StageResult;

async function execute(
  raw: unknown,
  deps: RunDependencies,
  runDir: string,
  diagnostics: RunDiagnostics,
  result: ResultBuilder,
): Promise<RunOutcome> {
  const { config, log } = deps;
  const admitted = admitInvocation(raw, deps.manifest);
  const git = new DriverGit(join(runDir, "git-home"), config.gitIdentity, config.gitToken);
  const verified = await prepareWorkspace(admitted, git, runDir);
  log("preflight_passed", { invocationId: admitted.invocation.invocation_id, handoff: verified.handoff });

  const home = join(runDir, "home");
  mkdirSync(home, { recursive: true });
  const env = sandboxEnv(home, config.commandEnv);
  await runSetup(admitted, verified, git, env, deps);

  const loop = await runAgentLoop({
    client: deps.model,
    system: SYSTEM_PROMPT,
    firstMessage: buildRunMessage({
      workspace: verified.workspace,
      workContract: verified.workContract,
      specText: verified.specText,
      intentText: verified.intentText,
      profileText: verified.profileText,
      evaluation: verified.evaluation,
      readPaths: admitted.readPaths,
      writePaths: admitted.writePaths,
      protectedPaths: admitted.protectedPaths,
    }),
    tools: {
      workspace: verified.workspace,
      readPaths: admitted.readPaths,
      writePaths: admitted.writePaths,
      protectedPaths: admitted.protectedPaths,
      protectedPrefixes: admitted.protectedPrefixes,
      shell: config.shell,
      env,
      bashTimeoutMs: config.limits.bashTimeoutMs,
      maxOutputChars: config.limits.maxToolOutputChars,
    },
    limits: config.limits,
    prices: config.prices,
    onEvent: (event, data) => log(event, { invocationId: admitted.invocation.invocation_id, ...data }),
  });
  diagnostics.agent = {
    turns: loop.turns,
    costUsd: loop.costUsd,
    models: loop.models,
    limitHit: loop.limitHit,
    refused: loop.refused,
    report: loop.report,
    durationMs: loop.durationMs,
  };

  // Undo anything the agent's shell did to Git config before the driver commits.
  git.restoreConfig(verified.workspace, verified.configSnapshot);
  const { invocation, intentId } = admitted;
  const candidateSha = await git.commitCandidate(
    verified.workspace,
    verified.handoff,
    `feat(${intentId}): candidate for invocation ${invocation.invocation_id}`,
  );
  diagnostics.changedPaths = await git.changedPaths(verified.workspace, verified.handoff, candidateSha);
  const violations = scopeViolations(diagnostics.changedPaths, admitted);

  let verdict: Verdict = preValidationVerdict(loop, verified.workContract, diagnostics.changedPaths, violations);
  if (verdict.validate) {
    diagnostics.validation = await runChecks(verified, admitted, env, deps);
    verdict = postValidationVerdict(verified.workContract, diagnostics.validation);
    const dirtied = await git.trackedChanges(verified.workspace);
    if (dirtied.length) {
      diagnostics.reasons.push(
        `Note: the checks modified tracked files (${dirtied.join(", ")}); the candidate commit was not changed.`,
      );
    }
  }
  diagnostics.reasons.unshift(...verdict.reasons);

  if (verdict.status !== "candidate_complete" || !loop.report) {
    return {
      stageResult: result(verdict.status, summaryFor(verdict.status, loop)),
      evidencePackage: null,
      diagnostics,
    };
  }

  const target = invocation.target.repository;
  const candidate: CommitRef = { repository: target, commit_sha: candidateSha };
  const evidencePackage = buildEvidencePackage({
    workItem: invocation.work_item,
    inputArtifacts: verified.inputArtifacts,
    candidate,
    changedPaths: diagnostics.changedPaths,
    validation: diagnostics.validation,
    policyControlEvidence: policyEvidence(verified.workContract, loop.report),
    status: "candidate_complete",
    summary: redact(evidenceSummary(loop.report, loop), secretValues(config)),
  });
  const evidenceCheck = validateRecord("EvidencePackage", evidencePackage);
  if (!evidenceCheck.valid) throw new Error(`The Evidence Package is invalid: ${evidenceCheck.errors.join("; ")}`);

  const evidenceRef = await publish(admitted, verified, git, evidencePackage, candidateSha);
  log("candidate_published", {
    invocationId: invocation.invocation_id,
    candidate: candidateSha,
    evidence: evidenceRef.commit_sha,
  });
  return {
    stageResult: result("candidate_complete", evidencePackage.summary ?? "Candidate complete.", {
      outputArtifacts: [evidenceRef],
      candidate,
    }),
    evidencePackage,
    diagnostics,
  };
}

function summaryFor(status: StageResult["status"], loop: LoopOutcome): string {
  const agent = loop.report ? ` Agent summary: ${loop.report.summary}` : "";
  switch (status) {
    case "needs_decision":
      return `A decision is needed before this work can continue; see findings.${agent}`;
    case "blocked":
      return `The run could not complete; see findings.${agent}`;
    default:
      return `No valid candidate was produced; see findings.${agent}`;
  }
}

/** Repository-declared setup (e.g. dependency install). It must not change tracked files. */
async function runSetup(
  admitted: AdmittedInvocation,
  verified: VerifiedInputs,
  git: DriverGit,
  env: NodeJS.ProcessEnv,
  deps: RunDependencies,
): Promise<void> {
  for (const command of admitted.repository.setup) {
    const outcome = await runCommand({
      command,
      cwd: verified.workspace,
      shell: deps.config.shell,
      env,
      timeoutMs: deps.config.limits.setupTimeoutMs,
      maxOutputChars: 4000,
    });
    deps.log("setup_command", { command, exitCode: outcome.exitCode, durationMs: outcome.durationMs });
    if (outcome.exitCode !== 0) {
      const why = outcome.timedOut ? "timed out" : `exited with ${outcome.exitCode}`;
      throw new BlockedError([`Setup command "${command}" ${why}: ${truncateMiddle(outcome.output, 1500)}`]);
    }
  }
  const changed = await git.trackedChanges(verified.workspace);
  if (changed.length) throw new BlockedError([`Setup modified tracked files: ${changed.join(", ")}.`]);
}

/** Runs each required check exactly as the trusted manifest defines it, against the committed candidate. */
async function runChecks(
  verified: VerifiedInputs,
  admitted: AdmittedInvocation,
  env: NodeJS.ProcessEnv,
  deps: RunDependencies,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const required of verified.workContract.required_validation) {
    const command = admitted.repository.checks[required.name];
    const outcome = await runCommand({
      command,
      cwd: verified.workspace,
      shell: deps.config.shell,
      env,
      timeoutMs: deps.config.limits.checkTimeoutMs,
      maxOutputChars: 1500,
    });
    const passed = outcome.exitCode === 0;
    const status = outcome.timedOut ? "timed out" : `exit ${outcome.exitCode}`;
    const tail = outcome.output.trim() ? ` Output: ${outcome.output.trim()}` : "";
    results.push({
      name: required.name,
      outcome: passed ? "passed" : "failed",
      observed_at: new Date().toISOString(),
      summary: redact(
        `Ran "${command}": ${status} after ${(outcome.durationMs / 1000).toFixed(1)}s.${tail}`,
        secretValues(deps.config),
      ),
    });
    deps.log("check_result", { name: required.name, exitCode: outcome.exitCode, durationMs: outcome.durationMs });
  }
  return results;
}

/** Commits the Evidence Package after the candidate and pushes both, fast-forward only. */
async function publish(
  admitted: AdmittedInvocation,
  verified: VerifiedInputs,
  git: DriverGit,
  evidencePackage: EvidencePackage,
  candidateSha: string,
): Promise<ArtifactRef> {
  const { invocation, branch, evidencePath, intentId } = admitted;
  const text = `${JSON.stringify(evidencePackage, null, 2)}\n`;
  const full = join(verified.workspace, evidencePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, "utf8");

  // Checks run repository code; restore Git config again before the driver writes.
  git.restoreConfig(verified.workspace, verified.configSnapshot);
  const evidenceSha = await git.commitSinglePath(
    verified.workspace,
    evidencePath,
    `chore(${intentId}): evidence package for candidate ${candidateSha.slice(0, 12)}`,
  );

  const tip = await git.remoteTip(invocation.target.repository, branch, verified.workspace);
  if (tip !== verified.handoff) {
    throw new BlockedError([`The work branch moved to ${tip} during the run; the candidate was not pushed.`]);
  }
  try {
    await git.pushFastForward(verified.workspace, invocation.target.repository, evidenceSha, branch);
  } catch (err) {
    throw new BlockedError([`Pushing the candidate to ${branch} failed: ${(err as Error).message}`]);
  }
  return {
    repository: invocation.target.repository,
    commit_sha: evidenceSha,
    path: evidencePath,
    sha256: sha256(text),
  };
}
