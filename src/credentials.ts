// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Chooses the credential for each remote: a read-only token for intent repositories, the GitHub App otherwise.
// ABOUTME: Intent repositories are never written, so a write request for one is refused before any Git call.
import type { GitAccess, GitCredentials } from "./git.js";
import { githubRepository } from "./githubApp.js";
import { isAllowedIntentRepository, type CheckManifest } from "./manifest.js";

export class RoutedCredentials implements GitCredentials {
  constructor(
    private readonly manifest: CheckManifest,
    private readonly intentToken: string | undefined,
    private readonly productCredentials: GitCredentials | undefined,
  ) {}

  async tokenFor(url: string, access: GitAccess): Promise<string | undefined> {
    // Local remotes, as in tests, need no credential.
    const onGitHub = githubRepository(url) !== null;
    if (isAllowedIntentRepository(this.manifest, url)) {
      if (access === "write") throw new Error(`Intent repository ${url} is read-only for this agent.`);
      if (onGitHub && !this.intentToken) {
        throw new Error(`CODING_AGENT_INTENT_TOKEN is not set; it is needed to read ${url}.`);
      }
      return this.intentToken;
    }
    if (onGitHub && !this.productCredentials) {
      throw new Error(`No GitHub App is configured; set the CODING_AGENT_GITHUB_APP_* settings to reach ${url}.`);
    }
    return this.productCredentials?.tokenFor(url, access);
  }
}
