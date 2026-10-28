// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for path scope normalization and workspace confinement.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { confineToWorkspace, isCovered, normalizeScope } from "./paths.js";

test("normalizeScope accepts repository-relative scopes and the root", () => {
  assert.equal(normalizeScope("."), ".");
  assert.equal(normalizeScope("server/src"), "server/src");
  assert.equal(normalizeScope("server/src/"), "server/src");
});

test("normalizeScope rejects absolute, escaping, and unnormalized scopes", () => {
  for (const bad of ["", "/etc", "C:/x", "..", "a/../b", "a//b", "./a", "a\\b", ".git", ".git/hooks"]) {
    assert.throws(() => normalizeScope(bad), Error, bad);
  }
});

test("isCovered matches the scope itself and its descendants only", () => {
  assert.equal(isCovered("server/src/a.ts", ["server/src"]), true);
  assert.equal(isCovered("server/src", ["server/src"]), true);
  assert.equal(isCovered("server/srcx/a.ts", ["server/src"]), false);
  assert.equal(isCovered("anything", ["."]), true);
});

test("confineToWorkspace resolves relative and absolute paths inside the workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "paths-"));
  try {
    mkdirSync(join(root, "src"));
    assert.equal(confineToWorkspace(root, "src/new.ts"), "src/new.ts");
    assert.equal(confineToWorkspace(root, join(root, "src", "a.ts")), "src/a.ts");
    assert.equal(confineToWorkspace(root, root), ".");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("confineToWorkspace rejects traversal and encoded separators", () => {
  const root = mkdtempSync(join(tmpdir(), "paths-"));
  try {
    assert.throws(() => confineToWorkspace(root, "../outside.txt"), /outside the assigned workspace/);
    assert.throws(() => confineToWorkspace(root, "src/%2e%2e/x"), /Encoded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("confineToWorkspace follows symlinks before deciding", () => {
  const root = mkdtempSync(join(tmpdir(), "paths-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "x");
    // "junction" needs no elevation on Windows and is ignored elsewhere.
    symlinkSync(outside, join(root, "link"), "junction");
    assert.throws(() => confineToWorkspace(root, "link/secret.txt"), /outside the assigned workspace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
