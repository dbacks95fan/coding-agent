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

test("redacts explicitly supplied secret values", () => {
  assert.equal(redact("value=supersecretvalue!", ["supersecretvalue"]), "value=[REDACTED]!");
});

test("leaves ordinary text alone", () => {
  assert.equal(redact("npm run build passed"), "npm run build passed");
});
