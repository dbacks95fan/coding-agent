import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { newAjv } from "./ajvLoader.js";
import workContractSchema from "../schemas/work-contract.schema.json" with { type: "json" };
import type { WorkContract } from "./types.js";

export interface LoadedContract {
  contract: WorkContract;
  hash: string;
  raw: string;
}

export class ContractValidationError extends Error {
  constructor(public errors: string[]) {
    super(`Work Contract failed schema validation:\n${errors.join("\n")}`);
  }
}

export function loadContract(path: string): LoadedContract {
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw);

  const ajv = newAjv({ allErrors: true, useDefaults: true });
  const validate = ajv.compile(workContractSchema);
  if (!validate(parsed)) {
    const errors = (validate.errors ?? []).map(
      (e: { instancePath: string; message?: string }) => `${e.instancePath || "(root)"} ${e.message}`,
    );
    throw new ContractValidationError(errors);
  }

  const hash = createHash("sha256").update(raw, "utf8").digest("hex");
  return { contract: parsed as WorkContract, hash, raw };
}
