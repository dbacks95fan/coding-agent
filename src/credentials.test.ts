// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for choosing a credential per remote: read-only intent token versus the GitHub App.
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

test("reads intent repositories with the intent token, never the app", async () => {
  const app = recordingApp();
  const credentials = new RoutedCredentials(manifest, "github_pat_intent_read_only", app);
  assert.equal(await credentials.tokenFor(INTENTS, "read"), "github_pat_intent_read_only");
  assert.equal(
    await credentials.tokenFor("https://github.com/DBACKS95FAN/intent-backlog/", "read"),
    "github_pat_intent_read_only",
  );
  assert.deepEqual(app.requests, []);
});

test("refuses to write to an intent repository", async () => {
  const credentials = new RoutedCredentials(manifest, "github_pat_intent_read_only", recordingApp());
  await assert.rejects(credentials.tokenFor(INTENTS, "write"), /read-only for this agent/);
});

test("uses the GitHub App for product repositories at the requested access", async () => {
  const app = recordingApp();
  const credentials = new RoutedCredentials(manifest, "github_pat_intent_read_only", app);
  assert.equal(await credentials.tokenFor(PRODUCT, "write"), "app-write-token");
  assert.equal(await credentials.tokenFor(PRODUCT, "read"), "app-read-token");
  assert.deepEqual(app.requests, [
    [PRODUCT, "write"],
    [PRODUCT, "read"],
  ]);
});

test("names the missing setting instead of reaching GitHub without a credential", async () => {
  const noIntentToken = new RoutedCredentials(manifest, undefined, recordingApp());
  await assert.rejects(noIntentToken.tokenFor(INTENTS, "read"), /CODING_AGENT_INTENT_TOKEN is not set/);

  const noApp = new RoutedCredentials(manifest, "github_pat_intent_read_only", undefined);
  await assert.rejects(noApp.tokenFor(PRODUCT, "read"), /No GitHub App is configured/);
});

test("local remotes need no credential", async () => {
  const credentials = new RoutedCredentials(manifest, undefined, undefined);
  assert.equal(await credentials.tokenFor("file:///C:/local/intents.git", "read"), undefined);
  assert.equal(await credentials.tokenFor("file:///C:/local/product.git", "write"), undefined);
});
