// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for credential redaction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "./redact.js";

test("redacts Anthropic keys, GitHub tokens, bearer headers, and URL credentials", () => {
  const text = [
    "key sk-ant-api03-abcdefghijklmnop",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123",
    "pat github_pat_11ABCDEFGHIJKLMNOPQRSTUV_xyz",
    "Authorization: Bearer abc.def.ghi",
    "remote https://user:hunter22@github.com/x/y.git",
  ].join("\n");
  const out = redact(text);
  assert.ok(!out.includes("abcdefghijklmnop"));
  assert.ok(!out.includes("ghp_abc"));
  assert.ok(!out.includes("github_pat_11"));
  assert.ok(!out.includes("abc.def.ghi"));
  assert.ok(!out.includes("hunter22"));
  assert.ok(out.includes("Authorization: Bearer [REDACTED]"));
  assert.ok(out.includes("https://[REDACTED]@github.com/x/y.git"));
});

test("redacts GitHub App installation tokens, JWTs, and PEM private keys", () => {
  const text = [
    "classic ghs_16C7e42F292c6912E7710c838347Ae178B4a",
    "stateless ghs_5555873_eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiI1NTU1ODczIn0.c2lnbmF0dXJlLWJ5dGVz",
    "jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiI1NTU1ODczIn0.c2lnbmF0dXJlLWJ5dGVz",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nqwerty\n-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const out = redact(text);
  assert.ok(!out.includes("16C7e42F"));
  assert.ok(!out.includes("5555873_"));
  assert.ok(!out.includes("eyJ"));
  assert.ok(!out.includes("MIIEpAIBAAKCAQEA"));
  assert.equal(out.split("[REDACTED]").length - 1, 4);
});

test("redacts explicitly supplied secret values", () => {
  assert.equal(redact("value=supersecretvalue!", ["supersecretvalue"]), "value=[REDACTED]!");
});

test("leaves ordinary text alone", () => {
  assert.equal(redact("npm run build passed"), "npm run build passed");
});
