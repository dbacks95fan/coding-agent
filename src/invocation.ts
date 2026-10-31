// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Admits a StageInvocation 1.1 for the Execution stage before any repository is touched.
// ABOUTME: Every failure is collected as a reason; any reason means the run is blocked.
import { isDeepStrictEqual } from "node:util";
import { validateRecord } from "./lifecycle.js";
import {
  findRepository,
  isAllowedIntentRepository,
  normalizeRepoUrl,
  type CheckManifest,
  type RepositoryEntry,
} from "./manifest.js";
import { isCovered, normalizeScope } from "./paths.js";
import type { ArtifactRef, StageInvocation, WorkItem } from "./types.js";

/** A run that cannot proceed for a reason the caller must resolve; maps to status `blocked`. */
export class BlockedError extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join(" "));
  }
}

export interface AdmittedInvocation {
  invocation: StageInvocation;
  repository: RepositoryEntry;
  intentId: string;
  branch: string;
  spec: ArtifactRef;
  workContract: ArtifactRef;
  evaluation?: ArtifactRef;
  readPaths: string[];
  writePaths: string[];
  frozenIntentPath: string;
  frozenProfilePath: string;
  evidencePath: string;
  /** Files the agent must leave byte-for-byte unchanged. */
  protectedPaths: string[];
  /** Directory whose existing contents are protected (earlier evidence and evaluations). */
  protectedPrefixes: string[];
}

export function workDir(intentId: string): string {
  return `.agent/work/${intentId}`;
}

/** Pulls the correlation identity from a record that may not be fully valid, so a blocked result can be returned. */
export function identityOf(
  raw: unknown,
): { invocationId: string; workItem: WorkItem; stage: StageInvocation["stage"] } | null {
  const record = raw as { invocation_id?: unknown; work_item?: unknown; stage?: unknown } | null;
  if (!record || typeof record !== "object" || typeof record.invocation_id !== "string" || !record.invocation_id) {
    return null;
  }
  if (!validateRecord("WorkItem", record.work_item).valid) return null;
  // Echo a recognized stage so the Conductor can correlate; anything else reports as execution.
  const stage = ["spec_design", "execution", "evaluation"].includes(String(record.stage))
    ? (record.stage as StageInvocation["stage"])
    : "execution";
  return { invocationId: record.invocation_id, workItem: record.work_item as WorkItem, stage };
}

export function admitInvocation(raw: unknown, manifest: CheckManifest): AdmittedInvocation {
  const schema = validateRecord("StageInvocation", raw);
  if (!schema.valid)
    throw new BlockedError([`The StageInvocation is not a valid 1.1 record: ${schema.errors.join("; ")}.`]);
  const invocation = raw as StageInvocation;
  const reasons: string[] = [];
  const freeze = invocation.freeze_activation;
  const intentId = invocation.work_item.intent_id;
  const work = workDir(intentId);

  if (invocation.stage !== "execution")
    reasons.push(`This worker handles the execution stage, not "${invocation.stage}".`);
  if (!isDeepStrictEqual(invocation.work_item, freeze.work_item)) {
    reasons.push("The invocation work item does not match the work item of its freeze activation.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(intentId)) reasons.push("The intent ID is not usable as a path segment.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(invocation.invocation_id)) {
    reasons.push("The invocation ID is not usable as a file name.");
  }

  const branch = `work/${intentId}`;
  if (invocation.workspace_ref !== branch) {
    reasons.push(`workspace_ref must be the assigned work branch "${branch}", not "${invocation.workspace_ref}".`);
  }

  const repository = findRepository(manifest, invocation.target.repository);
  if (!repository) reasons.push(`Target repository ${invocation.target.repository} is not in the trusted manifest.`);
  for (const ref of [freeze.intent, freeze.policy_profile]) {
    if (!isAllowedIntentRepository(manifest, ref.repository)) {
      reasons.push(`Frozen input repository ${ref.repository} is not an allowed intent repository.`);
    }
  }

  const target = normalizeRepoUrl(invocation.target.repository);
  let spec: ArtifactRef | undefined;
  let workContract: ArtifactRef | undefined;
  let evaluation: ArtifactRef | undefined;
  for (const ref of invocation.input_artifacts) {
    if (normalizeRepoUrl(ref.repository) !== target) {
      reasons.push(`Input ${ref.path} is not in the target repository.`);
      continue;
    }
    if (ref.path === `${work}/spec.md`) {
      if (spec) reasons.push("More than one spec.md input was supplied.");
      spec = ref;
    } else if (ref.path === `${work}/work-contract.yaml`) {
      if (workContract) reasons.push("More than one work-contract.yaml input was supplied.");
      workContract = ref;
    } else if (new RegExp(`^${escapeRegExp(work)}/evaluation-package/[A-Za-z0-9._-]+\\.json$`).test(ref.path)) {
      if (evaluation) reasons.push("More than one Evaluation Package input was supplied.");
      evaluation = ref;
    } else {
      reasons.push(`Input ${ref.path} is not a recognized Execution input.`);
    }
  }
  if (!spec) reasons.push(`The accepted ${work}/spec.md input is missing.`);
  if (!workContract) reasons.push(`The accepted ${work}/work-contract.yaml input is missing.`);

  const readPaths = normalizeAll(invocation.read_paths, "read_paths", reasons);
  const writePaths = normalizeAll(invocation.write_paths, "write_paths", reasons);
  const evidencePath = `${work}/evidence-package/${invocation.invocation_id}.json`;
  if (!isCovered(evidencePath, writePaths)) {
    reasons.push(`write_paths does not authorize the Evidence Package path ${evidencePath}.`);
  }

  if (reasons.length || !repository || !spec || !workContract) throw new BlockedError(reasons);

  const frozenIntentPath = `${work}/intent.md`;
  const frozenProfilePath = `${work}/policy-profile.md`;
  return {
    invocation,
    repository,
    intentId,
    branch,
    spec,
    workContract,
    evaluation,
    readPaths,
    writePaths,
    frozenIntentPath,
    frozenProfilePath,
    evidencePath,
    protectedPaths: [
      frozenIntentPath,
      frozenProfilePath,
      spec.path,
      workContract.path,
      ...(evaluation ? [evaluation.path] : []),
    ],
    protectedPrefixes: [`${work}/evidence-package/`, `${work}/evaluation-package/`],
  };
}

function normalizeAll(scopes: string[], field: string, reasons: string[]): string[] {
  const normalized: string[] = [];
  for (const scope of scopes) {
    try {
      normalized.push(normalizeScope(scope));
    } catch (err) {
      reasons.push(`${field}: ${(err as Error).message}`);
    }
  }
  return normalized;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
