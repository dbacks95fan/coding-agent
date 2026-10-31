// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for GitHub App token minting: the app JWT, per-repository scoping, caching, and refusals.
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { appJwt, GitHubAppCredentials, githubRepository, type GitHubAppSettings } from "./githubApp.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const settings: GitHubAppSettings = {
  appId: "5555873",
  installationId: "177232772",
  privateKey,
  apiUrl: "https://api.example.test/",
};

const MEALFLOW = "https://github.com/dbacks95fan/mealflow.git";
const NOW = Date.parse("2026-10-31T12:00:00Z");

interface Call {
  url: string;
  init: RequestInit;
  body: { repositories: string[]; permissions: { contents: string } };
}

/** A stand-in for GitHub that grants exactly what was asked, unless told otherwise. */
function fakeGitHub(
  overrides: { status?: number; contents?: string; repos?: string[]; expiresAt?: string; text?: string } = {},
) {
  const calls: Call[] = [];
  let serial = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Call["body"];
    calls.push({ url: String(input), init: init ?? {}, body });
    if (overrides.status && overrides.status !== 201) {
      return new Response(overrides.text ?? '{"message":"Bad credentials"}', { status: overrides.status });
    }
    serial += 1;
    return new Response(
      JSON.stringify({
        token: `ghs_5555873_eyJtoken${serial}`,
        expires_at: overrides.expiresAt ?? new Date(NOW + 60 * 60_000).toISOString(),
        permissions: { contents: overrides.contents ?? body.permissions.contents, metadata: "read" },
        repositories: (overrides.repos ?? body.repositories).map((name) => ({ full_name: `dbacks95fan/${name}` })),
      }),
      { status: 201 },
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("appJwt is an RS256 JWT for the app, backdated and valid for under ten minutes", () => {
  const token = appJwt("5555873", privateKey, NOW);
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
  assert.equal(claims.iss, "5555873");
  assert.equal(claims.iat, NOW / 1000 - 60);
  assert.equal((claims.exp as number) - (claims.iat as number), 600);
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")));
});

test("githubRepository recognizes github.com HTTPS remotes only", () => {
  assert.deepEqual(githubRepository(MEALFLOW), { owner: "dbacks95fan", name: "mealflow" });
  assert.deepEqual(githubRepository("https://github.com/dbacks95fan/intent-backlog"), {
    owner: "dbacks95fan",
    name: "intent-backlog",
  });
  assert.equal(githubRepository("file:///C:/tmp/product.git"), null);
  assert.equal(githubRepository("https://gitlab.com/a/b.git"), null);
  assert.equal(githubRepository("https://github.com/a/b/c"), null);
});

test("asks the installation for a token limited to one repository and the requested access", async () => {
  const github = fakeGitHub();
  const credentials = new GitHubAppCredentials(settings, github.fetchImpl, () => NOW);
  assert.equal(await credentials.tokenFor(MEALFLOW, "write"), "ghs_5555873_eyJtoken1");

  assert.equal(github.calls.length, 1);
  const [call] = github.calls;
  assert.equal(call.url, "https://api.example.test/app/installations/177232772/access_tokens");
  assert.equal(call.init.method, "POST");
  const headers = call.init.headers as Record<string, string>;
  assert.match(headers.authorization, /^Bearer eyJ/);
  assert.equal(headers["x-github-api-version"], "2022-11-28");
  assert.deepEqual(call.body, { repositories: ["mealflow"], permissions: { contents: "write" } });
});

test("keeps read and write tokens separate and reuses each until it nears expiry", async () => {
  const github = fakeGitHub();
  let now = NOW;
  const credentials = new GitHubAppCredentials(settings, github.fetchImpl, () => now);

  const write = await credentials.tokenFor(MEALFLOW, "write");
  const read = await credentials.tokenFor(MEALFLOW, "read");
  assert.notEqual(write, read);
  assert.equal(await credentials.tokenFor("https://github.com/DBACKS95FAN/mealflow", "write"), write);
  assert.equal(github.calls.length, 2);

  now = NOW + 49 * 60_000; // 11 minutes of life left: still reused
  assert.equal(await credentials.tokenFor(MEALFLOW, "write"), write);
  assert.equal(github.calls.length, 2);

  now = NOW + 51 * 60_000; // 9 minutes left: re-minted
  assert.notEqual(await credentials.tokenFor(MEALFLOW, "write"), write);
  assert.equal(github.calls.length, 3);
});

test("needs no token for remotes that are not on GitHub", async () => {
  const github = fakeGitHub();
  const credentials = new GitHubAppCredentials(settings, github.fetchImpl, () => NOW);
  assert.equal(await credentials.tokenFor("file:///C:/tmp/product.git", "write"), undefined);
  assert.equal(github.calls.length, 0);
});

test("reports GitHub's refusal with the status and without the app JWT", async () => {
  const github = fakeGitHub({ status: 401 });
  const credentials = new GitHubAppCredentials(settings, github.fetchImpl, () => NOW);
  await assert.rejects(credentials.tokenFor(MEALFLOW, "read"), (err: Error) => {
    assert.match(err.message, /refused a read token for dbacks95fan\/mealflow \(HTTP 401\): .*Bad credentials/);
    assert.ok(!err.message.includes("eyJ"));
    return true;
  });
});

test("refuses a token broader than requested", async () => {
  const broader = new GitHubAppCredentials(settings, fakeGitHub({ contents: "write" }).fetchImpl, () => NOW);
  await assert.rejects(broader.tokenFor(MEALFLOW, "read"), /contents=write .*not read on that repository alone/);

  const extraRepo = new GitHubAppCredentials(
    settings,
    fakeGitHub({ repos: ["mealflow", "intent-backlog"] }).fetchImpl,
    () => NOW,
  );
  await assert.rejects(extraRepo.tokenFor(MEALFLOW, "write"), /it was not used/);
});

test("refuses a response without a usable expiry", async () => {
  const credentials = new GitHubAppCredentials(settings, fakeGitHub({ expiresAt: "soon" }).fetchImpl, () => NOW);
  await assert.rejects(credentials.tokenFor(MEALFLOW, "read"), /no token or expiry/);
});
