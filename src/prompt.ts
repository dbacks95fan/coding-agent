import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { WorkContract } from "./types.js";

const AGENT_RULES = `MISSION
Implement exactly one approved Work Contract. Nothing more, nothing less.

SOURCE OF TRUTH
The Work Contract below defines required behavior. It is immutable — you cannot
write to its file, and no tool you have will let you.

RULES
- Do not change product requirements or acceptance criteria.
- Do not remove or weaken tests merely to obtain a passing result.
- Prefer existing architectural and coding patterns in this repository.
- Keep changes scoped to this work item. Do not address unrelated issues you notice
  (note them in "risks" instead).
- Add or update tests for changed behavior.
- Do not invent product or architecture decisions silently. If the contract is
  contradictory, impossible, unsafe, or materially ambiguous, STOP and report
  status "needs_decision" with a structured escalation instead of guessing.
- Prefer the smallest viable implementation. Avoid unnecessary dependencies.
- Preserve existing behavior unless the contract explicitly changes it.
- You may run builds, tests, Playwright, and local Docker builds to validate your
  own work. You may not push, merge, deploy, or touch remote hosts.
- You do not approve your own work. Your best possible outcome is
  "candidate_complete" — a human and an independent evaluator decide "Done".
- Before producing your final report, commit your changes to the current branch
  with a clear commit message describing what changed and why. Do not commit if
  you are reporting "needs_decision" or "failed" with no viable implementation.
- When you finish (or must stop), produce your final answer as the structured
  report matching the required output schema. Report exactly what you observed —
  which commands you ran, files you changed, and which acceptance criteria you
  believe are satisfied and why. Do not simply assert "it works."`;

export function buildSystemPrompt(repoRoot: string, contract: WorkContract): string {
  const claudeMdPath = ["CLAUDE.md", "AGENTS.md"]
    .map((f) => join(repoRoot, f))
    .find((p) => existsSync(p));

  const repoContext = claudeMdPath
    ? `REPOSITORY CONTEXT (from ${claudeMdPath.split(/[\\/]/).pop()})\n${readFileSync(claudeMdPath, "utf8")}`
    : "REPOSITORY CONTEXT\n(no CLAUDE.md/AGENTS.md found at repo root — proceed from direct inspection)";

  const contractYaml = stringify(contract);

  return [AGENT_RULES, repoContext, `WORK CONTRACT (immutable)\n\`\`\`yaml\n${contractYaml}\`\`\``].join(
    "\n\n---\n\n",
  );
}

export const USER_PROMPT =
  "Read the repository, understand the Work Contract in your system prompt, form a " +
  "plan, implement it, add or update tests, run the validation your Work Contract " +
  "requires, fix any failures, and report your final structured result.";
