// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for choosing a credential per remote: the GitHub App, and refusal for intent repositories.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RoutedCredentials } from "./credentials.js";
import type { GitAccess } from "./git.js";
import type { CheckManifest } from "./manifest.js";

const PRODUCT = "https://github.com/dbacks95fan/mealflow.git";
const INTENTS = "https://github.com/dbacks95fan/intent-backlog.git";
const manifest: CheckManifest = {
  repositories: [{ url: PRODUCT, setup: ["npm ci"], checks: { build: "npm run build" } }],
  intent_repositories: [INTENTS, "file:///C:/local/intents.git"],
};

function recordingApp() {
  const requests: [string, GitAccess][] = [];
  return {
    requests,
    tokenFor: async (url: string, access: GitAccess) => {
      requests.push([url, access]);
      return `app-${access}-token`;
    },
  };
}

test("refuses to read or write an intent repository, and never asks the app", async () => {
  const app = recordingApp();
  const credentials = new RoutedCredentials(manifest, app);
  await assert.rejects(credentials.tokenFor(INTENTS, "read"), /off limits to this agent \(read refused\)/);
  await assert.rejects(credentials.tokenFor(INTENTS, "write"), /off limits to this agent \(write refused\)/);
  await assert.rejects(credentials.tokenFor("https://github.com/DBACKS95FAN/intent-backlog/", "read"), /off limits/);
  await assert.rejects(credentials.tokenFor("file:///C:/local/intents.git", "read"), /off limits/);
  assert.deepEqual(app.requests, []);
});

test("uses the GitHub App for product repositories at the requested access", async () => {
  const app = recordingApp();
  const credentials = new RoutedCredentials(manifest, app);
  assert.equal(await credentials.tokenFor(PRODUCT, "write"), "app-write-token");
  assert.equal(await credentials.tokenFor(PRODUCT, "read"), "app-read-token");
  assert.deepEqual(app.requests, [
    [PRODUCT, "write"],
    [PRODUCT, "read"],
  ]);
});

test("names the missing setting instead of reaching GitHub without a credential", async () => {
  const noApp = new RoutedCredentials(manifest, undefined);
  await assert.rejects(noApp.tokenFor(PRODUCT, "read"), /No GitHub App is configured/);
});

test("local product remotes need no credential", async () => {
  const credentials = new RoutedCredentials(manifest, undefined);
  assert.equal(await credentials.tokenFor("file:///C:/local/product.git", "write"), undefined);
});
