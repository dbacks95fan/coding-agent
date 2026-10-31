// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Drops from container root to the service user once secrets are loaded. Job commands run as that same
// ABOUTME: user, but after the drop the kernel hides this process's environment and memory from them.

/** The image's `agent` user and group; the work and cache volumes are owned by them. */
export const SERVICE_UID = 10001;
export const SERVICE_GID = 999;

export interface ProcessIdentity {
  getuid(): number;
  setgroups(groups: number[]): void;
  setgid(id: number): void;
  setuid(id: number): void;
}

/**
 * When started as root (on the NAS, with only SETUID and SETGID), switch to the
 * service user for good. Changing user marks the process non-dumpable, so a job
 * running as the same user can no longer read /proc/<pid>/environ or memory, and
 * files left readable only by root, such as the GitHub App key, stay out of reach.
 * Started as any other user (development, tests), there is nothing to drop.
 */
export function dropPrivileges(identity: ProcessIdentity): "dropped" | "not-root" {
  if (identity.getuid() !== 0) return "not-root";
  identity.setgroups([]);
  identity.setgid(SERVICE_GID);
  identity.setuid(SERVICE_UID);
  if (identity.getuid() === 0) throw new Error("Could not drop root privileges; refusing to run as root.");
  return "dropped";
}

/** This process's identity calls, or null on platforms without them (Windows). */
export function currentProcessIdentity(): ProcessIdentity | null {
  const { getuid, setgroups, setgid, setuid } = process;
  if (!getuid || !setgroups || !setgid || !setuid) return null;
  return {
    getuid: () => getuid(),
    setgroups: (groups) => setgroups(groups),
    setgid: (id) => setgid(id),
    setuid: (id) => setuid(id),
  };
}
