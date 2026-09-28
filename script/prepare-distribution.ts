import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Explicit runtime inputs keep build products, credentials, local configuration,
// dependencies, and developer verification scripts out of the distribution.
export const COLLECTOR_FILES = [
  "bin/quotapie",
  "package.json",
  "LICENSE",
  "script/awake_hook.py",
  "script/install.sh",
  "script/install-macos.ts",
  "scripts/codex-compaction-local.py",
] as const;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  function walk(relative: string) {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Distribution source must not be a symlink: ${relative}`);
    if (!stat.isDirectory()) throw new Error(`Distribution source must be a directory: ${relative}`);
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Distribution source must not be a symlink: ${child}`);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && /\.(ts|html)$/.test(entry.name)) files.push(child);
    }
  }
  walk("src");
  if (!files.includes("src/cli.ts")) throw new Error("Distribution source is missing src/cli.ts");
  for (const relative of COLLECTOR_FILES) {
    // Check every path component: a symlinked script directory could otherwise
    // include files outside the checkout even when its leaf is a regular file.
    let path = root;
    for (const part of relative.split("/")) {
      path = join(path, part);
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Distribution source must not be a symlink: ${relative}`);
    }
    if (!lstatSync(path).isFile()) throw new Error(`Distribution source must be a file: ${relative}`);
    files.push(relative);
  }
  return files;
}

export function bundleCollector(sourceRoot: string, appPath: string): string {
  const root = resolve(sourceRoot);
  const resources = join(resolve(appPath), "Contents", "Resources");
  if (!existsSync(join(appPath, "Contents", "Info.plist"))) throw new Error(`Missing app bundle: ${appPath}`);
  // Resolve the entire manifest before changing an existing payload.
  const files = sourceFiles(root);
  mkdirSync(resources, { recursive: true });
  const destination = join(resources, "Collector");
  const staging = mkdtempSync(join(resources, ".Collector-"));
  try {
    for (const relative of files) {
      const target = join(staging, relative);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, relative), target);
      chmodSync(target, relative === "bin/quotapie" || relative === "script/install.sh" ? 0o755 : 0o644);
    }
    rmSync(destination, { recursive: true, force: true });
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return destination;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function writeDmgInstaller(stagePath: string, appName: string): string {
  if (basename(appName) !== appName || !appName.endsWith(".app")) throw new Error("Expected an app bundle name without directories");
  const installer = join(stagePath, appName, "Contents", "Resources", "Collector", "script", "install.sh");
  if (!existsSync(installer)) throw new Error(`Missing bundled collector installer: ${installer}`);
  const command = join(stagePath, "Install QuotaPie.command");
  writeFileSync(command, `#!/bin/bash
set -euo pipefail
DMG_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
APP_NAME=${shellQuote(appName)}
APP="$DMG_DIR/$APP_NAME"
printf '%s\\n' 'Installing the QuotaPie app and its background collector.' 'Bun is required (https://bun.sh). Xcode and Swift are not required for this packaged app.'
exec /bin/bash "$APP/Contents/Resources/Collector/script/install.sh" --app "$APP" "$@"
`, { mode: 0o755 });
  chmodSync(command, 0o755);
  return command;
}

if (import.meta.main) {
  const [action, first, second] = Bun.argv.slice(2);
  if (!first || !second || (action !== "bundle" && action !== "dmg")) {
    console.error("Usage: bun script/prepare-distribution.ts bundle <source-root> <app-path> | dmg <stage-path> <app-name>");
    process.exit(2);
  }
  console.log(action === "bundle" ? bundleCollector(first, second) : writeDmgInstaller(first, second));
}
