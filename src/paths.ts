// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Normalizes repository-relative path scopes and confines model-supplied paths to the workspace.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";

/**
 * Validates one `read_paths`/`write_paths` entry. The SDLC contract requires
 * normalized, target-repository-relative paths; "." means the whole repository.
 * Anything absolute, escaping, or non-normalized is rejected rather than repaired.
 */
export function normalizeScope(scope: string): string {
  if (scope === ".") return ".";
  const problems: string[] = [];
  if (scope.length === 0) problems.push("is empty");
  if (scope.includes("\\")) problems.push("uses backslashes");
  if (scope.startsWith("/") || /^[A-Za-z]:/.test(scope)) problems.push("is absolute");
  const trimmed = scope.endsWith("/") ? scope.slice(0, -1) : scope;
  const segments = trimmed.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) problems.push("is not normalized");
  if (segments[0] === ".git") problems.push("targets git metadata");
  if (problems.length) throw new Error(`Path scope "${scope}" ${problems.join(", ")}.`);
  return posix.normalize(trimmed);
}

/** True when a repository-relative file path is inside one of the normalized scopes. */
export function isCovered(path: string, scopes: string[]): boolean {
  return scopes.some((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`));
}

/**
 * Resolves a model-supplied path (absolute inside the workspace, or relative to it)
 * to a repository-relative POSIX path. Symlinks are canonicalized through the
 * nearest existing ancestor so a link cannot point a write outside the workspace.
 */
export function confineToWorkspace(workspaceRoot: string, suppliedPath: string): string {
  if (suppliedPath.includes("\0")) throw new Error("Path contains a NUL byte.");
  if (/%2e|%2f|%5c/i.test(suppliedPath)) throw new Error("Encoded path separators are not accepted.");
  const root = realpathSync(workspaceRoot);
  const target = resolve(root, suppliedPath);

  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const canonicalExisting = realpathSync(existing);
  const canonical = resolve(canonicalExisting, relative(existing, target));

  const rel = relative(root, canonical);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path "${suppliedPath}" is outside the assigned workspace.`);
  }
  return rel.split(sep).join("/");
}
