import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Hash executable inputs, not the repository revision: documentation-only commits
// do not invalidate an installed service. The server captures this once at start.
export const RUNTIME_HASH_VERSION = 3;
export type RuntimeHashVersion = 1 | 2 | typeof RUNTIME_HASH_VERSION;
export function runtimeSourceHash(root = resolve(import.meta.dir, ".."), version: RuntimeHashVersion = RUNTIME_HASH_VERSION): string {
  if (version !== 1 && version !== 2 && version !== RUNTIME_HASH_VERSION) throw new Error("Unsupported runtime hash version");
  const hash = createHash("sha256");
  function add(relative: string) {
    const bytes = readFileSync(join(root, relative));
    hash.update(`${relative}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  function walk(relative: string) {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isSymbolicLink()) throw new Error("Runtime source symlinks cannot be verified");
      else if (entry.isFile() && /\.(ts|html)$/.test(entry.name)) add(path);
    }
  }
  walk("src");
  walk("packages/quota-core/src");
  add("packages/quota-core/package.json");
  add("bin/quotapie");
  add("script/awake_hook.py");
  // Version 1 is the fixed input set used by collectors predating host wake.
  // It is retained only to verify an existing installation during migration.
  if (version === 2 || version === 3) {
    add("script/codex-host-wake.py");
    add("scripts/codex-compaction-local.py");
  }
  // Version 2's input set remains fixed for verifying existing installations.
  if (version === 3) add("script/codex-session-consolidation.py");
  return hash.digest("hex");
}

export function captureRuntimeIdentity() {
  let sourceHash: string | null = null;
  // A bundled executable may not have a source tree. Identity remains explicitly
  // unverified without making quota collection itself unavailable.
  try { sourceHash = runtimeSourceHash(); } catch { /* unavailable provenance */ }
  return { schemaVersion: 1, hashVersion: RUNTIME_HASH_VERSION, sourceHash, pid: process.pid, startedAt: new Date().toISOString() };
}
