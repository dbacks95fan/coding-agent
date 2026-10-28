// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Validates records against the canonical agentic-sdlc lifecycle schema (JSON Schema 2020-12).
// ABOUTME: Formats (uri, date-time) are enforced, as the SDLC contract requires.
import { createRequire } from "node:module";
import lifecycleSchema from "../schemas/lifecycle-contracts.schema.json" with { type: "json" };

/** The schema version this worker was built against; checked by tests so drift is deliberate. */
export const LIFECYCLE_SCHEMA_ID = "urn:agentic-sdlc:lifecycle-contracts:1.2.0";

export type LifecycleDefinition =
  | "StageInvocation"
  | "StageResult"
  | "FreezeActivationEvent"
  | "WorkContract"
  | "EvidencePackage"
  | "EvaluationPackage"
  | "ArtifactRef"
  | "CommitRef"
  | "WorkItem";

interface AjvError {
  instancePath: string;
  message?: string;
}

interface ValidateFunction {
  (data: unknown): boolean;
  errors?: AjvError[] | null;
}

interface AjvInstance {
  addSchema(schema: object): AjvInstance;
  compile(schema: object): ValidateFunction;
}

// ajv ships CommonJS; its default-export typing does not resolve under NodeNext,
// so it is loaded through createRequire and typed to the small surface used here.
const require = createRequire(import.meta.url);
const ajvModule = require("ajv/dist/2020") as { default: new (options: object) => AjvInstance };
const formatsModule = require("ajv-formats") as { default: (ajv: AjvInstance) => AjvInstance };

// strictTypes is an Ajv authoring lint, not validation: the canonical schema
// legitimately narrows typed properties inside if/then branches without restating
// "type", which that lint rejects. Every other strict-mode check stays on.
const ajv = new ajvModule.default({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
formatsModule.default(ajv);
ajv.addSchema(lifecycleSchema);

const compiled = new Map<LifecycleDefinition, ValidateFunction>();

export interface ValidationOutcome {
  valid: boolean;
  errors: string[];
}

/** Validates data against one `$defs` entry of the canonical schema. */
export function validateRecord(definition: LifecycleDefinition, data: unknown): ValidationOutcome {
  let validate = compiled.get(definition);
  if (!validate) {
    validate = ajv.compile({ $ref: `${LIFECYCLE_SCHEMA_ID}#/$defs/${definition}` });
    compiled.set(definition, validate);
  }
  if (validate(data)) return { valid: true, errors: [] };
  const errors = (validate.errors ?? []).map(
    (e) => `${definition}${e.instancePath || ""} ${e.message ?? "is invalid"}`,
  );
  return { valid: false, errors };
}

/** Compiles a standalone schema (e.g. a tool input schema) with the same strict, format-enforcing settings. */
export function compileValidator(name: string, schema: object): (data: unknown) => ValidationOutcome {
  const validate = ajv.compile(schema);
  return (data) => {
    if (validate(data)) return { valid: true, errors: [] };
    return {
      valid: false,
      errors: (validate.errors ?? []).map((e) => `${name}${e.instancePath || ""} ${e.message ?? "is invalid"}`),
    };
  };
}

export function schemaId(): string {
  return (lifecycleSchema as { $id: string }).$id;
}
