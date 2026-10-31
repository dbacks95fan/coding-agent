// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Integration tests for driver Git operations against real local repositories.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DriverGit, type GitAccess } from "./git.js";
import { git, removeDir, tempDir, TestRemote, writeBytes } from "./testSupport.js";

let root: string;
let remote: TestRemote;
let driver: DriverGit;
let base: string;

before(() => {
  root = tempDir("git-");
  remote = new TestRemote(root, "product");
  base = remote.commit({ "README.md": "hello\r\nworld\r\n" }, "base");
  remote.branchFrom(base, "work/INT-1");
  driver = new DriverGit(join(root, "driver-home"), { name: "coding-agent", email: "agent@example.com" });
});

after(() => removeDir(root));

test("remoteTip reports the branch head and null for a missing branch", async () => {
  assert.equal(await driver.remoteTip(remote.url, "work/INT-1", root), base);
  assert.equal(await driver.remoteTip(remote.url, "work/missing", root), null);
});

test("cloneBranch and readBlob preserve exact bytes, including CRLF", async () => {
  const dir = join(root, "clone-bytes");
  await driver.cloneBranch(remote.url, "work/INT-1", dir, root);
  const bytes = await driver.readBlob(dir, base, "README.md");
  assert.equal(bytes?.toString("utf8"), "hello\r\nworld\r\n");
  assert.equal(await driver.readBlob(dir, base, "missing.txt"), null);
});

test("fetchCommit retrieves a commit by SHA for byte-exact reads", async () => {
  const dir = join(root, "fetch-one");
  await driver.fetchCommit(remote.url, base, dir);
  assert.equal((await driver.readBlob(dir, base, "README.md"))?.toString("utf8"), "hello\r\nworld\r\n");
});

test("commitCandidate folds agent commits into one candidate on the handoff", async () => {
  const dir = join(root, "clone-candidate");
  await driver.cloneBranch(remote.url, "work/INT-1", dir, root);
  writeBytes(dir, "a.txt", "a");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-m", "agent commit"]);
  writeBytes(dir, "b.txt", "b");
  const candidate = await driver.commitCandidate(dir, base, "candidate");
  assert.equal(git(dir, ["rev-parse", `${candidate}^`]), base);
  assert.deepEqual((await driver.changedPaths(dir, base, candidate)).sort(), ["a.txt", "b.txt"]);
});

test("commitSinglePath commits only the named file", async () => {
  const dir = join(root, "clone-single");
  await driver.cloneBranch(remote.url, "work/INT-1", dir, root);
  writeBytes(dir, "evidence.json", "{}");
  writeBytes(dir, "stray.txt", "should stay uncommitted");
  const commit = await driver.commitSinglePath(dir, "evidence.json", "evidence");
  assert.deepEqual(await driver.changedPaths(dir, base, commit), ["evidence.json"]);
});

test("restoreConfig undoes changes the agent made to .git/config", async () => {
  const dir = join(root, "clone-config");
  await driver.cloneBranch(remote.url, "work/INT-1", dir, root);
  const snapshot = driver.snapshotConfig(dir);
  writeFileSync(join(dir, ".git", "config"), '[url "https://evil.example/"]\n\tinsteadOf = file://\n');
  driver.restoreConfig(dir, snapshot);
  assert.equal(await driver.remoteTip(remote.url, "work/INT-1", dir), base);
});

test("hooks planted in the workspace do not run during driver commits", async () => {
  const dir = join(root, "clone-hooks");
  await driver.cloneBranch(remote.url, "work/INT-1", dir, root);
  writeBytes(dir, ".git/hooks/pre-commit", "#!/bin/sh\necho ran > hook-ran.txt\nexit 1\n");
  writeBytes(dir, "c.txt", "c");
  await driver.commitCandidate(dir, base, "candidate");
  assert.equal(git(dir, ["status", "--porcelain"]), "");
});

test("asks for read access to fetch and clone, and write access only to push", async () => {
  const requests: [string, GitAccess][] = [];
  const recording = new DriverGit(
    join(root, "driver-home-creds"),
    { name: "coding-agent", email: "agent@example.com" },
    {
      tokenFor: async (url, access) => {
        requests.push([url, access]);
        // A token for a local remote is configured but never offered, so the calls still work.
        return "ghs_test_token_value_123456";
      },
    },
  );
  remote.branchFrom(base, "work/INT-3");
  const dir = join(root, "clone-creds");
  assert.equal(await recording.remoteTip(remote.url, "work/INT-3", root), base);
  await recording.cloneBranch(remote.url, "work/INT-3", dir, root);
  await recording.fetchCommit(remote.url, base, join(root, "fetch-creds"));
  assert.deepEqual(
    requests.map(([, access]) => access),
    ["read", "read", "read"],
  );

  writeBytes(dir, "f.txt", "f");
  const candidate = await recording.commitCandidate(dir, base, "candidate");
  assert.equal(requests.length, 3, "local operations ask for no token");
  await recording.pushFastForward(dir, remote.url, candidate, "work/INT-3");
  assert.deepEqual(requests.at(-1), [remote.url, "write"]);
  assert.equal(remote.tip("work/INT-3"), candidate);
});

test("a credential failure stops the Git call before it runs", async () => {
  const failing = new DriverGit(
    join(root, "driver-home-fail"),
    { name: "coding-agent", email: "agent@example.com" },
    {
      tokenFor: async () => {
        throw new Error("GitHub refused a read token");
      },
    },
  );
  await assert.rejects(failing.remoteTip(remote.url, "work/INT-1", root), /refused a read token/);
});

test("pushFastForward advances the branch and refuses a non-fast-forward", async () => {
  remote.branchFrom(base, "work/INT-2");
  const dir = join(root, "clone-push");
  await driver.cloneBranch(remote.url, "work/INT-2", dir, root);
  writeBytes(dir, "d.txt", "d");
  const candidate = await driver.commitCandidate(dir, base, "candidate");
  await driver.pushFastForward(dir, remote.url, candidate, "work/INT-2");
  assert.equal(remote.tip("work/INT-2"), candidate);

  const other = join(root, "clone-push-stale");
  await driver.cloneBranch(remote.url, "work/INT-2", other, root);
  git(other, ["reset", "--hard", base]);
  writeBytes(other, "e.txt", "e");
  const stale = await driver.commitCandidate(other, base, "stale");
  await assert.rejects(driver.pushFastForward(other, remote.url, stale, "work/INT-2"));
  assert.equal(remote.tip("work/INT-2"), candidate);
});
