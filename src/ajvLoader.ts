import { createRequire } from "node:module";

/**
 * ajv's type declarations resolve incorrectly under this project's
 * module/moduleResolution ("NodeNext") + esModuleInterop combination — a known
 * class of friction between ajv's CJS build and TS's ESM interop typing, not a
 * runtime problem (confirmed: `node -e "import('ajv')"` resolves `.default` to
 * the real constructor fine). Rather than fight tsconfig knobs, this module
 * loads ajv via createRequire (bypasses the broken default-import typing) and
 * exposes only the minimal shape this project actually uses.
 */

export interface AjvErrorObject {
  instancePath: string;
  message?: string;
}

export interface AjvValidateFunction {
  (data: unknown): boolean;
  errors?: AjvErrorObject[] | null;
}

export interface AjvInstance {
  compile(schema: object): AjvValidateFunction;
}

export interface AjvOptions {
  allErrors?: boolean;
  useDefaults?: boolean;
}

const require = createRequire(import.meta.url);
const AjvCtor = require("ajv") as new (options?: AjvOptions) => AjvInstance;

export function newAjv(options: AjvOptions = {}): AjvInstance {
  return new AjvCtor(options);
}
