import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runtimeSourceHash } from "../src/runtime-identity";

test("runtime identity detects changed and missing code but ignores notes and build products", () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-identity-"));
  try {
    for (const path of ["src", "bin", "script", "dist"]) mkdirSync(join(root, path));
    for (const file of ["src/cli.ts", "bin/quotapie", "script/awake_hook.py"]) writeFileSync(join(root, file), "initial");
    const initial = runtimeSourceHash(root);
    writeFileSync(join(root, "TODO.md"), "notes");
    writeFileSync(join(root, "dist/app"), "build");
    expect(runtimeSourceHash(root)).toBe(initial);
    writeFileSync(join(root, "src/cli.ts"), "changed");
    expect(runtimeSourceHash(root)).not.toBe(initial);
    writeFileSync(join(root, "src/provider.ts"), "provider");
    const withProvider = runtimeSourceHash(root);
    unlinkSync(join(root, "src/provider.ts"));
    expect(runtimeSourceHash(root)).not.toBe(withProvider);
    symlinkSync(join(root, "src/cli.ts"), join(root, "src/linked.ts"));
    expect(() => runtimeSourceHash(root)).toThrow();
    unlinkSync(join(root, "src/linked.ts"));
    unlinkSync(join(root, "script/awake_hook.py"));
    expect(() => runtimeSourceHash(root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
