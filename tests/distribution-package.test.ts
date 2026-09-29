import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundleCollector, COLLECTOR_FILES, writeDmgInstaller } from "../script/prepare-distribution";

function write(root: string, path: string, value = path) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quotapie-distribution-"));
  const app = join(root, "build", "QuotaPie.app");
  write(app, "Contents/Info.plist", "fixture");
  for (const path of [...COLLECTOR_FILES, "src/cli.ts", "src/dashboard.html", "src/providers/codex.ts", "packages/quota-core/src/index.ts"]) write(root, path);
  return { root, app };
}

test("distribution includes runtime inputs without local data and replaces old payloads without nesting", () => {
  const { root, app } = fixture();
  try {
    for (const path of [".git/config", "auth.json", "config.json", "node_modules/private.ts", "src/cache.sqlite", "src/.env", "src/node_modules/private.ts", "script/verify-macos.ts", "scripts/probe-codex-compaction.py", "packages/quota-core/dist/index.js", "packages/quota-core/auth.json"]) write(root, path, "private");
    const collector = bundleCollector(root, app);
    for (const path of [...COLLECTOR_FILES, "src/cli.ts", "src/dashboard.html", "src/providers/codex.ts", "packages/quota-core/src/index.ts"]) {
      expect(readFileSync(join(collector, path), "utf8")).toBe(path);
    }
    for (const path of [".git", "auth.json", "config.json", "node_modules", "src/cache.sqlite", "src/.env", "src/node_modules", "script/verify-macos.ts", "scripts/probe-codex-compaction.py", "build", "packages/quota-core/dist", "packages/quota-core/auth.json"]) {
      expect(existsSync(join(collector, path))).toBe(false);
    }
    write(collector, "stale.ts");
    write(root, "src/cli.ts", "updated");
    bundleCollector(root, app);
    expect(readFileSync(join(collector, "src/cli.ts"), "utf8")).toBe("updated");
    expect(existsSync(join(collector, "stale.ts"))).toBe(false);
    expect(existsSync(join(collector, "Collector"))).toBe(false);
    expect(statSync(join(collector, "script/install.sh")).mode & 0o777).toBe(0o755);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("distribution rejects symlinked source paths before changing a valid payload", () => {
  const { root, app } = fixture();
  try {
    const collector = bundleCollector(root, app);
    symlinkSync(join(root, "package.json"), join(root, "src/linked.ts"));
    expect(() => bundleCollector(root, app)).toThrow("symlink");
    expect(readFileSync(join(collector, "src/cli.ts"), "utf8")).toBe("src/cli.ts");
    rmSync(join(root, "src/linked.ts"));
    rmSync(join(root, "script"), { recursive: true });
    symlinkSync(join(collector, "script"), join(root, "script"));
    expect(() => bundleCollector(root, app)).toThrow("symlink");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("DMG installer invokes the bundled installer with the prebuilt app and preserves spaces and arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "QuotaPie DMG's "));
  try {
    const appName = "QuotaPie Preview's.app";
    const app = join(root, appName);
    const output = join(root, "installer arguments");
    write(app, "Contents/Resources/Collector/script/install.sh", '#!/bin/bash\nprintf "%s\\0" "$@" > "$INSTALLER_TEST_OUTPUT"\n');
    const command = writeDmgInstaller(root, appName);
    const result = Bun.spawnSync(["/bin/bash", command, "--config", "a path with 'quotes'"], {
      env: { ...process.env, INSTALLER_TEST_OUTPUT: output },
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(output, "utf8").split("\0")).toEqual(["--app", app, "--config", "a path with 'quotes'", ""]);
    expect(result.stdout.toString()).toContain("Bun is required");
    expect(statSync(command).mode & 0o777).toBe(0o755);
    expect(() => writeDmgInstaller(root, "../Other.app")).toThrow("without directories");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
