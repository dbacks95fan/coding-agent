// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Mints short-lived GitHub App installation tokens, each limited to one repository and one access level.
// ABOUTME: The app's private key never leaves this process; Git only ever sees a minted token.
import { sign } from "node:crypto";
import type { GitAccess, GitCredentials } from "./git.js";

export interface GitHubAppSettings {
  appId: string;
  installationId: string;
  privateKey: string;
  apiUrl: string;
}

interface MintedToken {
  token: string;
  expiresAt: number;
}

/**
 * Tokens live one hour. Re-mint when less than this remains so a clone or push
 * that starts on a cached token cannot outlive it.
 */
const REFRESH_MARGIN_MS = 10 * 60_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** The app's own short-lived JWT, used only to ask GitHub for installation tokens. */
export function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  // GitHub accepts at most ten minutes; backdating iat absorbs clock drift between the NAS and GitHub.
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** owner and name of a github.com HTTPS remote; null for anything else, such as local test remotes. */
export function githubRepository(url: string): { owner: string; name: string } | null {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? { owner: match[1], name: match[2] } : null;
}

export class GitHubAppCredentials implements GitCredentials {
  private readonly cache = new Map<string, MintedToken>();

  constructor(
    private readonly settings: GitHubAppSettings,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async tokenFor(url: string, access: GitAccess): Promise<string | undefined> {
    const repo = githubRepository(url);
    if (!repo) return undefined;
    const fullName = `${repo.owner}/${repo.name}`.toLowerCase();
    const key = `${access}:${fullName}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.now() > REFRESH_MARGIN_MS) return cached.token;
    const minted = await this.mint(repo.name, fullName, access);
    this.cache.set(key, minted);
    return minted.token;
  }

  private async mint(name: string, fullName: string, access: GitAccess): Promise<MintedToken> {
    const { appId, installationId, privateKey, apiUrl } = this.settings;
    const response = await this.fetchImpl(
      `${apiUrl.replace(/\/+$/, "")}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${appJwt(appId, privateKey, this.now())}`,
          "content-type": "application/json",
          "user-agent": "coding-agent",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ repositories: [name], permissions: { contents: access } }),
      },
    );
    if (response.status !== 201) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`GitHub refused a ${access} token for ${fullName} (HTTP ${response.status}): ${detail}`);
    }

    const body = (await response.json()) as {
      token?: string;
      expires_at?: string;
      permissions?: { contents?: string };
      repositories?: { full_name?: string }[];
    };
    const expiresAt = Date.parse(body.expires_at ?? "");
    if (!body.token || Number.isNaN(expiresAt)) {
      throw new Error(`GitHub's token response for ${fullName} had no token or expiry.`);
    }
    // Use nothing broader than requested, whatever GitHub returned.
    const granted = (body.repositories ?? []).map((r) => (r.full_name ?? "").toLowerCase());
    if (body.permissions?.contents !== access || granted.length !== 1 || granted[0] !== fullName) {
      throw new Error(
        `GitHub issued a token for ${fullName} with contents=${body.permissions?.contents} on ` +
          `[${granted.join(", ")}], not ${access} on that repository alone; it was not used.`,
      );
    }
    return { token: body.token, expiresAt };
  }
}
