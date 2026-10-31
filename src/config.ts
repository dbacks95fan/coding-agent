// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Reads runtime configuration from the environment; secrets are never logged or passed to children.
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubAppSettings } from "./githubApp.js";

export interface Prices {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

export interface AgentLimits {
  maxTurns: number;
  maxCostUsd: number;
  maxRuntimeMs: number;
  bashTimeoutMs: number;
  checkTimeoutMs: number;
  setupTimeoutMs: number;
  maxToolOutputChars: number;
}

export interface RuntimeConfig {
  anthropicApiKey?: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  serverSideFallback: boolean;
  prices: Prices;
  limits: AgentLimits;
  /** Absent when no remote needs credentials, as with local test repositories. */
  githubApp?: GitHubAppSettings;
  gitIdentity: { name: string; email: string };
  apiToken?: string;
  manifestPath: string;
  workRoot: string;
  shell: string;
  port: number;
  /** Extra variables passed to agent/setup/check commands, e.g. shared cache locations. */
  commandEnv: Record<string, string>;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function number(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

/** Variables with this prefix are forwarded to commands with the prefix removed. */
const COMMAND_ENV_PREFIX = "CODING_AGENT_COMMAND_ENV_";

const GITHUB_APP_SETTINGS = [
  "CODING_AGENT_GITHUB_APP_ID",
  "CODING_AGENT_GITHUB_APP_INSTALLATION_ID",
  "CODING_AGENT_GITHUB_APP_PRIVATE_KEY_FILE",
] as const;

/** All three settings or none; error messages name the file and settings, never the key. */
function githubAppSettings(env: NodeJS.ProcessEnv): GitHubAppSettings | undefined {
  const missing = GITHUB_APP_SETTINGS.filter((name) => !env[name]);
  if (missing.length === GITHUB_APP_SETTINGS.length) return undefined;
  if (missing.length) throw new Error(`GitHub App settings are incomplete; also set ${missing.join(", ")}.`);

  const appId = env.CODING_AGENT_GITHUB_APP_ID as string;
  const installationId = env.CODING_AGENT_GITHUB_APP_INSTALLATION_ID as string;
  const keyFile = env.CODING_AGENT_GITHUB_APP_PRIVATE_KEY_FILE as string;
  if (!/^\d+$/.test(appId)) throw new Error("CODING_AGENT_GITHUB_APP_ID must be the app's numeric App ID.");
  if (!/^\d+$/.test(installationId)) {
    throw new Error("CODING_AGENT_GITHUB_APP_INSTALLATION_ID must be the numeric installation ID.");
  }

  let privateKey: string;
  try {
    privateKey = readFileSync(keyFile, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read the GitHub App private key file ${keyFile} (${(err as NodeJS.ErrnoException).code}).`,
      {
        cause: err,
      },
    );
  }
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new Error(`The GitHub App private key file ${keyFile} does not hold a usable private key.`);
  }
  return { appId, installationId, privateKey, apiUrl: env.CODING_AGENT_GITHUB_API_URL || "https://api.github.com" };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const effort = (env.CODING_AGENT_EFFORT ?? "high") as RuntimeConfig["effort"];
  if (!EFFORTS.includes(effort)) throw new Error(`CODING_AGENT_EFFORT must be one of ${EFFORTS.join(", ")}.`);
  if (env.CODING_AGENT_GIT_TOKEN) {
    throw new Error(
      "CODING_AGENT_GIT_TOKEN is no longer used; remove it and set the CODING_AGENT_GITHUB_APP_* settings instead.",
    );
  }

  const commandEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(COMMAND_ENV_PREFIX) && value !== undefined) {
      commandEnv[name.slice(COMMAND_ENV_PREFIX.length)] = value;
    }
  }

  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    model: env.CODING_AGENT_MODEL ?? "claude-opus-5-5",
    effort,
    serverSideFallback: (env.CODING_AGENT_SERVER_SIDE_FALLBACK ?? "on") !== "off",
    // Defaults are Claude Opus 5.5 list prices (USD per million tokens). They only
    // drive the run's cost ceiling; set them when CODING_AGENT_MODEL changes.
    prices: {
      inputPerMTok: number(env, "CODING_AGENT_PRICE_INPUT", 4),
      outputPerMTok: number(env, "CODING_AGENT_PRICE_OUTPUT", 20),
      cacheWritePerMTok: number(env, "CODING_AGENT_PRICE_CACHE_WRITE", 5),
      cacheReadPerMTok: number(env, "CODING_AGENT_PRICE_CACHE_READ", 0.2),
    },
    limits: {
      maxTurns: number(env, "CODING_AGENT_MAX_TURNS", 60),
      maxCostUsd: number(env, "CODING_AGENT_MAX_COST_USD", 5),
      maxRuntimeMs: number(env, "CODING_AGENT_MAX_RUNTIME_MIN", 30) * 60_000,
      bashTimeoutMs: number(env, "CODING_AGENT_BASH_TIMEOUT_MIN", 10) * 60_000,
      checkTimeoutMs: number(env, "CODING_AGENT_CHECK_TIMEOUT_MIN", 15) * 60_000,
      setupTimeoutMs: number(env, "CODING_AGENT_SETUP_TIMEOUT_MIN", 20) * 60_000,
      maxToolOutputChars: number(env, "CODING_AGENT_MAX_TOOL_OUTPUT_CHARS", 30_000),
    },
    githubApp: githubAppSettings(env),
    gitIdentity: {
      name: env.CODING_AGENT_GIT_NAME ?? "coding-agent",
      email: env.CODING_AGENT_GIT_EMAIL ?? "coding-agent@users.noreply.github.com",
    },
    apiToken: env.CODING_AGENT_API_TOKEN || undefined,
    manifestPath: env.CODING_AGENT_MANIFEST ?? "/etc/coding-agent/manifest.json",
    workRoot: env.CODING_AGENT_WORK_ROOT ?? join(tmpdir(), "coding-agent"),
    shell: env.CODING_AGENT_SHELL ?? "bash",
    port: number(env, "PORT", 8080),
    commandEnv,
  };
}

/** Values that must be scrubbed from any text this process emits. */
export function secretValues(config: RuntimeConfig): string[] {
  return [config.anthropicApiKey, config.githubApp?.privateKey, config.apiToken].filter((v): v is string => Boolean(v));
}
