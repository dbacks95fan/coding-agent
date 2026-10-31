// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Fetches the assigned work branch at the handoff commit and verifies every frozen and accepted input.
// ABOUTME: Runs before any model call; any mismatch blocks the run with the reason.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import type { DriverGit } from "./git.js";
import { BlockedError, type AdmittedInvocation } from "./invocation.js";
import { validateRecord } from "./lifecycle.js";
import { normalizeRepoUrl, untrustedChecks } from "./manifest.js";
import type { ArtifactRef, EvaluationPackage, WorkContract } from "./types.js";

export interface VerifiedInputs {
  workspace: string;
  handoff: string;
  configSnapshot: Buffer;
  workContract: WorkContract;
  intentText: string;
  profileText: string;
  specText: string;
  workContractText: string;
  evaluation?: EvaluationPackage;
  /** Every immutable input this run relied on, for the Evidence Package. */
  inputArtifacts: ArtifactRef[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function prepareWorkspace(
  admitted: AdmittedInvocation,
  git: DriverGit,
  runDir: string,
): Promise<VerifiedInputs> {
  const { invocation, branch } = admitted;
  const freeze = invocation.freeze_activation;
  const handoff = invocation.target.commit_sha;
  const url = invocation.target.repository;
  mkdirSync(runDir, { recursive: true });

  // Only one writer may use the branch; it must still point at the handoff we were given.
  const tip = await git.remoteTip(url, branch, runDir);
  if (tip === null) throw new BlockedError([`The assigned work branch ${branch} does not exist on ${url}.`]);
  if (tip !== handoff) {
    throw new BlockedError([
      `The work branch ${branch} is at ${tip}, not the handoff commit ${handoff}; another writer may have pushed.`,
    ]);
  }

  const workspace = join(runDir, "repo");
  await git.cloneBranch(url, branch, workspace, runDir);
  const head = await git.head(workspace);
  if (head !== handoff)
    throw new BlockedError([`The cloned branch head ${head} is not the handoff commit ${handoff}.`]);
  const configSnapshot = git.snapshotConfig(workspace);

  const reasons: string[] = [];
  const specBytes = await verifyAccepted(git, workspace, handoff, admitted.spec, reasons);
  const contractBytes = await verifyAccepted(git, workspace, handoff, admitted.workContract, reasons);

  const intentCopy = await git.readBlob(workspace, handoff, admitted.frozenIntentPath);
  const profileCopy = await git.readBlob(workspace, handoff, admitted.frozenProfilePath);
  checkFingerprint(intentCopy, freeze.intent.sha256, `the frozen intent copy ${admitted.frozenIntentPath}`, reasons);
  checkFingerprint(
    profileCopy,
    freeze.policy_profile.sha256,
    `the frozen policy profile copy ${admitted.frozenProfilePath}`,
    reasons,
  );

  await verifySources(git, runDir, [freeze.intent, freeze.policy_profile], reasons);

  let workContract: WorkContract | undefined;
  if (contractBytes) {
    workContract = await verifyWorkContract(contractBytes, admitted, git, workspace, handoff, reasons);
  }

  let evaluation: EvaluationPackage | undefined;
  if (admitted.evaluation) {
    const bytes = await verifyAccepted(git, workspace, handoff, admitted.evaluation, reasons);
    if (bytes) evaluation = await verifyEvaluation(bytes, admitted, git, workspace, handoff, reasons);
  }

  if (workContract) reasons.push(...untrustedChecks(admitted.repository, workContract.required_validation));

  if (reasons.length || !workContract || !specBytes || !contractBytes || !intentCopy || !profileCopy) {
    throw new BlockedError(reasons);
  }

  return {
    workspace,
    handoff,
    configSnapshot,
    workContract,
    intentText: intentCopy.toString("utf8"),
    profileText: profileCopy.toString("utf8"),
    specText: specBytes.toString("utf8"),
    workContractText: contractBytes.toString("utf8"),
    evaluation,
    inputArtifacts: [
      freeze.intent,
      freeze.policy_profile,
      admitted.spec,
      admitted.workContract,
      ...(admitted.evaluation ? [admitted.evaluation] : []),
    ],
  };
}

function checkFingerprint(bytes: Buffer | null, expected: string, label: string, reasons: string[]): void {
  if (!bytes) reasons.push(`${label} is missing at the handoff commit.`);
  else if (sha256(bytes) !== expected) reasons.push(`${label} does not match its recorded SHA-256 ${expected}.`);
}

/**
 * An accepted artifact must hash correctly at its recorded commit, that commit must
 * be in the branch history, and the bytes must be unchanged at the handoff.
 */
async function verifyAccepted(
  git: DriverGit,
  workspace: string,
  handoff: string,
  ref: ArtifactRef,
  reasons: string[],
): Promise<Buffer | null> {
  const atRecorded = await git.readBlob(workspace, ref.commit_sha, ref.path);
  if (!atRecorded) {
    reasons.push(`${ref.path} is not reachable at its recorded commit ${ref.commit_sha}.`);
    return null;
  }
  if (sha256(atRecorded) !== ref.sha256) {
    reasons.push(`${ref.path} at ${ref.commit_sha} does not match its recorded SHA-256.`);
    return null;
  }
  if (!(await git.isAncestor(workspace, ref.commit_sha, handoff))) {
    reasons.push(`${ref.path}'s recorded commit ${ref.commit_sha} is not in the work branch history.`);
    return null;
  }
  const atHandoff = await git.readBlob(workspace, handoff, ref.path);
  if (!atHandoff || !atHandoff.equals(atRecorded)) {
    reasons.push(`${ref.path} has changed since its accepted commit ${ref.commit_sha}.`);
    return null;
  }
  return atRecorded;
}

/** Confirms the frozen originals in the intent backlog, not just the copies on the work branch. */
async function verifySources(git: DriverGit, runDir: string, refs: ArtifactRef[], reasons: string[]): Promise<void> {
  const fetched = new Map<string, string>();
  for (const ref of refs) {
    const key = `${normalizeRepoUrl(ref.repository)}@${ref.commit_sha}`;
    let dir = fetched.get(key);
    if (!dir) {
      dir = join(runDir, "sources", String(fetched.size));
      try {
        await git.fetchCommit(ref.repository, ref.commit_sha, dir);
      } catch (err) {
        reasons.push(`Could not fetch frozen source ${ref.repository}@${ref.commit_sha}: ${(err as Error).message}`);
        continue;
      }
      fetched.set(key, dir);
    }
    const bytes = await git.readBlob(dir, ref.commit_sha, ref.path);
    checkFingerprint(bytes, ref.sha256, `the frozen source ${ref.path}@${ref.commit_sha}`, reasons);
  }
}

async function verifyWorkContract(
  bytes: Buffer,
  admitted: AdmittedInvocation,
  git: DriverGit,
  workspace: string,
  handoff: string,
  reasons: string[],
): Promise<WorkContract | undefined> {
  let parsed: unknown;
  try {
    parsed = parseYaml(bytes.toString("utf8"));
  } catch (err) {
    reasons.push(`work-contract.yaml is not valid YAML: ${(err as Error).message}`);
    return undefined;
  }
  const schema = validateRecord("WorkContract", parsed);
  if (!schema.valid) {
    reasons.push(`work-contract.yaml is not a valid Work Contract v3: ${schema.errors.join("; ")}.`);
    return undefined;
  }
  const contract = parsed as WorkContract;
  const freeze = admitted.invocation.freeze_activation;
  if (!isDeepStrictEqual(contract.work_item, admitted.invocation.work_item)) {
    reasons.push("The Work Contract work item does not match the invocation.");
  }
  if (!isDeepStrictEqual(contract.intent, freeze.intent)) {
    reasons.push("The Work Contract intent reference does not match the active freeze.");
  }
  if (
    !isDeepStrictEqual(contract.policy_profile, freeze.policy_profile) ||
    contract.policy_profile_id !== freeze.policy_profile_id ||
    contract.policy_profile_version !== freeze.policy_profile_version
  ) {
    reasons.push("The Work Contract policy profile does not match the active freeze.");
  }
  if (normalizeRepoUrl(contract.target.repository) !== normalizeRepoUrl(admitted.invocation.target.repository)) {
    reasons.push("The Work Contract targets a different repository than the invocation.");
  } else if (!(await git.isAncestor(workspace, contract.target.commit_sha, handoff))) {
    reasons.push(`The Work Contract base commit ${contract.target.commit_sha} is not in the work branch history.`);
  }
  return contract;
}

async function verifyEvaluation(
  bytes: Buffer,
  admitted: AdmittedInvocation,
  git: DriverGit,
  workspace: string,
  handoff: string,
  reasons: string[],
): Promise<EvaluationPackage | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    reasons.push("The Evaluation Package is not valid JSON.");
    return undefined;
  }
  const schema = validateRecord("EvaluationPackage", parsed);
  if (!schema.valid) {
    reasons.push(`The Evaluation Package is invalid: ${schema.errors.join("; ")}.`);
    return undefined;
  }
  const evaluation = parsed as EvaluationPackage;
  if (!isDeepStrictEqual(evaluation.work_item, admitted.invocation.work_item)) {
    reasons.push("The Evaluation Package work item does not match the invocation.");
  }
  if (evaluation.status !== "fail") {
    reasons.push(`Only a failed evaluation routes back to Execution; this one is "${evaluation.status}".`);
  }
  if (!(await git.isAncestor(workspace, evaluation.candidate.commit_sha, handoff))) {
    reasons.push("The evaluated candidate is not in the work branch history.");
  }
  return evaluation;
}
