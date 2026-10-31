// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Operator-controlled allowlist of target repositories, their setup steps, and trusted check commands.
// ABOUTME: A Work Contract may only name checks whose exact command appears here; nothing else is executed.
import { readFileSync } from "node:fs";
import type { RequiredValidation } from "./types.js";

export interface RepositoryEntry {
  url: string;
  setup: string[];
  checks: Record<string, string>;
}

export interface CheckManifest {
  repositories: RepositoryEntry[];
  intent_repositories: string[];
}

/** Compares repository URLs ignoring case, a trailing slash, and a trailing ".git". */
export function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && v.length > 0);
}

export function parseManifest(raw: unknown): CheckManifest {
  const problems: string[] = [];
  const data = raw as Partial<CheckManifest> | null;
  if (!data || typeof data !== "object") throw new Error("Check manifest must be a JSON object.");
  if (!Array.isArray(data.repositories) || data.repositories.length === 0) {
    problems.push("repositories must be a non-empty array");
  }
  if (!isStringArray(data.intent_repositories)) problems.push("intent_repositories must be an array of URLs");
  for (const [i, entry] of (data.repositories ?? []).entries()) {
    if (typeof entry?.url !== "string" || !entry.url) problems.push(`repositories[${i}].url is required`);
    if (!isStringArray(entry?.setup)) problems.push(`repositories[${i}].setup must be an array of commands`);
    const checks = entry?.checks;
    if (!checks || typeof checks !== "object" || Object.keys(checks).length === 0) {
      problems.push(`repositories[${i}].checks must map check names to commands`);
    } else if (!Object.values(checks).every((c) => typeof c === "string" && c.length > 0)) {
      problems.push(`repositories[${i}].checks values must be non-empty commands`);
    }
  }
  if (problems.length) throw new Error(`Invalid check manifest: ${problems.join("; ")}.`);
  return data as CheckManifest;
}

export function loadManifest(path: string): CheckManifest {
  return parseManifest(JSON.parse(readFileSync(path, "utf8")));
}

export function findRepository(manifest: CheckManifest, url: string): RepositoryEntry | undefined {
  const wanted = normalizeRepoUrl(url);
  return manifest.repositories.find((entry) => normalizeRepoUrl(entry.url) === wanted);
}

export function isAllowedIntentRepository(manifest: CheckManifest, url: string): boolean {
  const wanted = normalizeRepoUrl(url);
  return manifest.intent_repositories.some((allowed) => normalizeRepoUrl(allowed) === wanted);
}

/**
 * Returns one problem per required check that the manifest does not trust exactly.
 * The command text must match character for character; a contract cannot
 * substitute, extend, or reinterpret a trusted command.
 */
export function untrustedChecks(entry: RepositoryEntry, required: RequiredValidation[]): string[] {
  const problems: string[] = [];
  for (const check of required) {
    const trusted = entry.checks[check.name];
    if (trusted === undefined) {
      problems.push(`Required check "${check.name}" is not in the trusted check manifest for this repository.`);
    } else if (trusted !== check.command) {
      problems.push(
        `Required check "${check.name}" asks for "${check.command}", but the trusted command is "${trusted}".`,
      );
    }
  }
  return problems;
}
