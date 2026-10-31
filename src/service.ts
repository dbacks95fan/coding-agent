// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Authenticated HTTP boundary for the Conductor: submit an invocation, poll for its StageResult, check health.
// ABOUTME: One run at a time; results are held in memory because the worker is stateless between runs.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { identityOf } from "./invocation.js";
import type { Logger } from "./log.js";
import { redact } from "./redact.js";
import type { RunOutcome } from "./run.js";
import type { SelfTestResult } from "./selfTest.js";

export interface ServiceDeps {
  apiToken: string;
  secrets: string[];
  log: Logger;
  execute: (raw: unknown) => Promise<RunOutcome>;
  selfTest: () => Promise<SelfTestResult[]>;
  maxBodyBytes?: number;
  maxRecords?: number;
}

interface RunRecord {
  bodyHash: string;
  state: "running" | "done";
  startedAt: string;
  finishedAt?: string;
  outcome?: RunOutcome;
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(supplied), digest(token));
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createService(deps: ServiceDeps): Server {
  const records = new Map<string, RunRecord>();
  const maxBody = deps.maxBodyBytes ?? 2 * 1024 * 1024;
  const maxRecords = deps.maxRecords ?? 100;
  let running: string | null = null;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = redact(JSON.stringify(body), deps.secrets);
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(text);
  };

  const view = (id: string, record: RunRecord) => ({
    invocation_id: id,
    state: record.state,
    started_at: record.startedAt,
    ...(record.finishedAt ? { finished_at: record.finishedAt } : {}),
    ...(record.outcome
      ? {
          stage_result: record.outcome.stageResult,
          evidence_package: record.outcome.evidencePackage,
          diagnostics: record.outcome.diagnostics,
        }
      : {}),
  });

  const start = (id: string, raw: unknown, bodyHash: string) => {
    const record: RunRecord = { bodyHash, state: "running", startedAt: new Date().toISOString() };
    records.set(id, record);
    running = id;
    while (records.size > maxRecords) {
      const oldest = [...records.entries()].find(([, r]) => r.state === "done");
      if (!oldest) break;
      records.delete(oldest[0]);
    }
    deps
      .execute(raw)
      .then((outcome) => {
        record.outcome = outcome;
      })
      .catch((err: unknown) => {
        deps.log("run_crashed", { invocationId: id, message: err instanceof Error ? err.message : String(err) });
        record.outcome = {
          stageResult: null,
          evidencePackage: null,
          diagnostics: { reasons: ["The worker crashed; see service logs."], changedPaths: [], validation: [] },
        };
      })
      .finally(() => {
        record.state = "done";
        record.finishedAt = new Date().toISOString();
        running = null;
      });
  };

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { status: "ok", busy: running !== null });
        return;
      }
      if (!authorized(req, deps.apiToken)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/invocations") {
        let text: string;
        try {
          text = await readBody(req, maxBody);
        } catch {
          send(res, 413, { error: "request body too large" });
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          send(res, 400, { error: "body is not JSON" });
          return;
        }
        const identity = identityOf(raw);
        if (!identity) {
          send(res, 400, { error: "body is not a StageInvocation with a usable invocation_id and work_item" });
          return;
        }
        const id = identity.invocationId;
        const bodyHash = digest(JSON.stringify(raw)).toString("hex");
        const existing = records.get(id);
        if (existing) {
          if (existing.bodyHash !== bodyHash) {
            send(res, 409, { error: "this invocation_id was already submitted with different content" });
          } else {
            send(res, existing.state === "done" ? 200 : 202, view(id, existing));
          }
          return;
        }
        if (running) {
          send(res, 409, { error: "busy", running_invocation_id: running });
          return;
        }
        start(id, raw, bodyHash);
        deps.log("invocation_accepted", { invocationId: id });
        send(res, 202, view(id, records.get(id)!));
        return;
      }

      const match = /^\/invocations\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && match) {
        const id = decodeURIComponent(match[1]);
        const record = records.get(id);
        if (!record) send(res, 404, { error: "unknown invocation_id" });
        else send(res, 200, view(id, record));
        return;
      }

      if (req.method === "POST" && url.pathname === "/self-test") {
        const results = await deps.selfTest();
        send(res, results.every((r) => r.outcome === "pass") ? 200 : 503, { results });
        return;
      }

      send(res, 404, { error: "not found" });
    })().catch((err: unknown) => {
      deps.log("request_error", { message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  });
}
