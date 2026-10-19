import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Stored inside the signed app. A collector hash cannot prove which Swift UI
// or bundled helper was built; include their resources and build inputs too.
export function macOSSourceHash(root: string): string {
  const hash = createHash("sha256");
  function add(relative: string) {
    const path = join(root, relative), info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("App source symlinks cannot be verified");
    if (info.isDirectory()) {
      for (const name of readdirSync(path).filter(n => !n.startsWith(".")).sort()) add(`${relative}/${name}`);
    } else if (info.isFile()) {
      const bytes = readFileSync(path);
      hash.update(`${relative}\0${bytes.length}\0`).update(bytes);
    }
  }
  for (const relative of ["Package.swift", "macos/QuotaPie", "macos/PowerCore", "macos/QuotaPiePowerHelper", "macos/ClaudeDesktopCore", "macos/QuotaPieClaudeSessionHelper",
    "script/build_and_run.sh", "script/install_power_helper.sh", "script/macos-source-identity.ts", "script/sign-macos.ts"]) add(relative);
  return hash.digest("hex");
}
if (import.meta.main) {
  const root = resolve(import.meta.dir, ".."), sourceHash = macOSSourceHash(root);
  if (process.argv[2]) {
    if (sourceHash !== process.argv[3]) throw new Error("App inputs changed during build; rebuild before installation");
    writeFileSync(process.argv[2], JSON.stringify({ schemaVersion: 1, sourceHash }) + "\n");
  } else console.log(sourceHash);
}
