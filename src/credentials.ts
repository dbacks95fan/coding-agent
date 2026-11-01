// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Chooses the credential for each remote: the GitHub App for product repositories.
// ABOUTME: Intent repositories are refused outright, before any Git call; this agent reads only the frozen copies.
import type { GitAccess, GitCredentials } from "./git.js";
import { githubRepository } from "./githubApp.js";
import { isAllowedIntentRepository, type CheckManifest } from "./manifest.js";

export class RoutedCredentials implements GitCredentials {
  constructor(
    private readonly manifest: CheckManifest,
    private readonly productCredentials: GitCredentials | undefined,
  ) {}

  async tokenFor(url: string, access: GitAccess): Promise<string | undefined> {
    if (isAllowedIntentRepository(this.manifest, url)) {
      throw new Error(`Intent repository ${url} is off limits to this agent (${access} refused).`);
    }
    // Local remotes, as in tests, need no credential.
    const onGitHub = githubRepository(url) !== null;
    if (onGitHub && !this.productCredentials) {
      throw new Error(`No GitHub App is configured; set the CODING_AGENT_GITHUB_APP_* settings to reach ${url}.`);
    }
    return this.productCredentials?.tokenFor(url, access);
  }
}
