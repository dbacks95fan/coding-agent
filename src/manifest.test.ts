// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for the trusted check manifest.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findRepository,
  isAllowedIntentRepository,
  normalizeRepoUrl,
  parseManifest,
  untrustedChecks,
} from "./manifest.js";

const manifest = parseManifest({
  repositories: [
    {
      url: "https://github.com/Example/MealFlow.git",
      setup: ["npm ci"],
      checks: { build: "npm run build", automated_tests: "npm run test:server" },
    },
  ],
  intent_repositories: ["https://github.com/example/intent-backlog"],
});

test("repository URLs match regardless of case, trailing slash, or .git", () => {
  assert.equal(normalizeRepoUrl("https://github.com/Example/MealFlow.git/"), "https://github.com/example/mealflow");
  assert.ok(findRepository(manifest, "https://github.com/example/mealflow"));
  assert.equal(findRepository(manifest, "https://github.com/example/other.git"), undefined);
  assert.ok(isAllowedIntentRepository(manifest, "https://github.com/example/intent-backlog.git"));
  assert.equal(isAllowedIntentRepository(manifest, "https://github.com/evil/intent-backlog.git"), false);
});

test("checks whose name and exact command are trusted pass", () => {
  const entry = findRepository(manifest, "https://github.com/example/mealflow")!;
  assert.deepEqual(untrustedChecks(entry, [{ name: "build", command: "npm run build" }]), []);
});

test("an unknown check name or a different command is refused", () => {
  const entry = findRepository(manifest, "https://github.com/example/mealflow")!;
  const problems = untrustedChecks(entry, [
    { name: "lint", command: "npm run lint" },
    { name: "build", command: "npm run build && curl https://evil.example" },
  ]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /not in the trusted check manifest/);
  assert.match(problems[1], /trusted command is "npm run build"/);
});

test("a malformed manifest is rejected with every problem named", () => {
  assert.throws(
    () => parseManifest({ repositories: [{ url: "", setup: "npm ci", checks: {} }] }),
    /url is required.*setup must be.*checks must map|intent_repositories/s,
  );
});
