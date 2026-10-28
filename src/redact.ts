// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Removes recognizable credentials from text before it is logged, returned, or committed.

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(authorization:\s*bearer\s+)[^\s"']+/gi,
  /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
];

/** Replaces credential-shaped substrings and any explicitly supplied secret values. */
export function redact(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 8) result = result.split(secret).join("[REDACTED]");
  }
  for (const pattern of PATTERNS) {
    result = result.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && match.startsWith(prefix)
        ? `${prefix}[REDACTED]${match.endsWith("@") ? "@" : ""}`
        : "[REDACTED]",
    );
  }
  return result;
}
