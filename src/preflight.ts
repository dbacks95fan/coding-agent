import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkContract } from "./types.js";

export interface PreflightResult {
  ok: boolean;
  reasons: string[];
}

/**
 * The Work Contract's `intent` block already carries its own acceptance metadata
 * (status/acceptedBy/acceptedAt) and is schema-validated at load time — a contract
 * with intent.status !== "Accepted", or missing acceptedBy/acceptedAt, never even
 * reaches this point (loadContract's Ajv validation rejects it first).
 *
 * What schema validation CANNOT verify is whether `intent.sha256` actually matches
 * the real content of the document at `intent.path` — i.e. whether the accepted
 * intent has since been edited, or the contract points at the wrong file entirely.
 * That's a runtime check against the actual repository, done here, before any
 * worktree is created or any SDK call is made.
 *
 * `intent.path` is resolved relative to the target repository root.
 */
export function verifyIntentIntegrity(contract: WorkContract, repoRoot: string): PreflightResult {
  const reasons: string[] = [];
  const intentFile = join(repoRoot, contract.intent.path);

  if (!existsSync(intentFile)) {
    reasons.push(
      `Work Contract references intent.path "${contract.intent.path}" but no such file exists at ${intentFile}.`,
    );
    return { ok: false, reasons };
  }

  const actualSha256 = createHash("sha256").update(readFileSync(intentFile)).digest("hex");
  if (actualSha256 !== contract.intent.sha256) {
    reasons.push(
      `Work Contract records intent.sha256 "${contract.intent.sha256}" but ${contract.intent.path} currently hashes to "${actualSha256}" — the accepted intent has changed since this contract was approved, or this contract points at the wrong document.`,
    );
  }

  return { ok: reasons.length === 0, reasons };
}
