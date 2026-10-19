import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { macOSSourceHash } from "../script/macos-source-identity";

test("app provenance covers UI, helpers and resources independently of backend and notes", () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-app-identity-"));
  try {
    for (const dir of ["macos/QuotaPie/Resources/ko.lproj", "macos/PowerCore", "macos/QuotaPiePowerHelper", "macos/ClaudeDesktopCore", "macos/QuotaPieClaudeSessionHelper", "script", "src"])
      mkdirSync(join(root, dir), {recursive:true});
    const inputs = ["Package.swift", "macos/QuotaPie/App.swift", "macos/QuotaPie/Resources/ko.lproj/Localizable.strings",
      "macos/PowerCore/Power.swift", "macos/QuotaPiePowerHelper/main.swift", "script/build_and_run.sh",
      "macos/ClaudeDesktopCore/ClaudeDesktopSession.swift", "macos/QuotaPieClaudeSessionHelper/main.swift",
      "script/install_power_helper.sh", "script/macos-source-identity.ts", "script/sign-macos.ts"];
    for (const input of inputs) writeFileSync(join(root, input), "original");
    const initial = macOSSourceHash(root);
    writeFileSync(join(root, "TODO.md"), "private notes");
    writeFileSync(join(root, "src/cli.ts"), "separately verified backend");
    expect(macOSSourceHash(root)).toBe(initial);
    for (const input of inputs) {
      writeFileSync(join(root, input), "changed");
      expect(macOSSourceHash(root)).not.toBe(initial);
      writeFileSync(join(root, input), "original");
    }
    const linked = join(root, "macos/QuotaPie/linked.swift");
    symlinkSync(join(root, "src/cli.ts"), linked);
    expect(() => macOSSourceHash(root)).toThrow("symlinks");
    unlinkSync(linked);
    unlinkSync(join(root, "Package.swift"));
    expect(() => macOSSourceHash(root)).toThrow();
  } finally { rmSync(root, {recursive:true,force:true}); }
});
