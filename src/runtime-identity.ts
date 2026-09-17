import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Hash executable inputs, not the repository revision: documentation-only commits
// do not invalidate an installed service. The server captures this once at start.
export function runtimeSourceHash(root = resolve(import.meta.dir, "..")): string {
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
  add("bin/quotapie");
  add("script/awake_hook.py");
  return hash.digest("hex");
}

export function captureRuntimeIdentity() {
  let sourceHash: string | null = null;
  // A bundled executable may not have a source tree. Identity remains explicitly
  // unverified without making quota collection itself unavailable.
  try { sourceHash = runtimeSourceHash(); } catch { /* unavailable provenance */ }
  return { schemaVersion: 1, sourceHash, pid: process.pid, startedAt: new Date().toISOString() };
}
