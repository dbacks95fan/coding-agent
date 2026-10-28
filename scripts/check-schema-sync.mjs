// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Confirms the vendored lifecycle schema is byte-identical to a sibling agentic-sdlc checkout.
// Usage: node scripts/check-schema-sync.mjs [path-to-agentic-sdlc]   (default ../agentic-sdlc)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const relative = "schemas/lifecycle-contracts.schema.json";
const sdlcRoot = resolve(process.argv[2] ?? "../agentic-sdlc");
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const vendored = hash(resolve(relative));
const canonical = hash(resolve(sdlcRoot, relative));
if (vendored !== canonical) {
  console.error(`Out of sync: ${relative} differs from ${sdlcRoot}. Re-copy it and review the contract change.`);
  process.exit(1);
}
console.log(`In sync with ${sdlcRoot} (sha256 ${vendored}).`);
