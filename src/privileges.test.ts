// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Unit tests for dropping root after secrets load, using a stand-in for the process identity calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dropPrivileges, SERVICE_GID, SERVICE_UID, type ProcessIdentity } from "./privileges.js";

function fakeIdentity(startUid: number, options: { ignoreSetuid?: boolean } = {}) {
  let uid = startUid;
  const calls: string[] = [];
  const identity: ProcessIdentity = {
    getuid: () => uid,
    setgroups: (groups) => calls.push(`setgroups(${groups.join(",")})`),
    setgid: (id) => calls.push(`setgid(${id})`),
    setuid: (id) => {
      calls.push(`setuid(${id})`);
      if (!options.ignoreSetuid) uid = id;
    },
  };
  return { identity, calls };
}

test("root drops supplementary groups, then group, then user, to the service account", () => {
  const { identity, calls } = fakeIdentity(0);
  assert.equal(dropPrivileges(identity), "dropped");
  // The group must change before the user: once non-root, the process may no longer change its group.
  assert.deepEqual(calls, ["setgroups()", `setgid(${SERVICE_GID})`, `setuid(${SERVICE_UID})`]);
  assert.equal(identity.getuid(), 10001);
});

test("a non-root process changes nothing", () => {
  const { identity, calls } = fakeIdentity(10001);
  assert.equal(dropPrivileges(identity), "not-root");
  assert.deepEqual(calls, []);
});

test("refuses to continue as root if the switch did not take effect", () => {
  const { identity } = fakeIdentity(0, { ignoreSetuid: true });
  assert.throws(() => dropPrivileges(identity), /refusing to run as root/);
});
