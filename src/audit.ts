import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class AuditLog {
  private path: string;

  constructor(repoRoot: string, workItem: string, runId: string) {
    this.path = `${repoRoot}/.agent/audit/${workItem}-${runId}.jsonl`;
    mkdirSync(dirname(this.path), { recursive: true });
  }

  write(event: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    appendFileSync(this.path, line + "\n", "utf8");
  }

  get filePath(): string {
    return this.path;
  }
}
