// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Structured, redacted JSON-line logging to stderr; stdout is reserved for CLI results.
import { redact } from "./redact.js";

export type Logger = (event: string, data?: Record<string, unknown>) => void;

export function createLogger(
  secrets: string[],
  write: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): Logger {
  return (event, data = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    write(redact(line, secrets));
  };
}

export const silentLogger: Logger = () => undefined;
