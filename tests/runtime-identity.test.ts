import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { captureRuntimeIdentity, runtimeSourceHash } from "../src/runtime-identity";

test("legacy hash version retains exactly the original input set while current identities require the new helpers",()=>{
  const root=mkdtempSync(join(tmpdir(),"quotapie-legacy-identity-"));
  const legacyFiles=["src/cli.ts","packages/quota-core/src/index.ts","packages/quota-core/package.json","bin/quotapie","script/awake_hook.py"];
  const expected=createHash("sha256");
  try {
    for(const file of legacyFiles) {
      const text="fixture:"+file;mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),text);
      expected.update(`${file}\0${Buffer.byteLength(text)}\0`);expected.update(text);
    }
    const legacyHash=expected.copy().digest("hex");
    expect(runtimeSourceHash(root,1)).toBe(legacyHash);
    expect(()=>runtimeSourceHash(root)).toThrow();
    for(const file of ["script/codex-host-wake.py","scripts/codex-compaction-local.py"]) {
      mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),"new helper");
      expected.update(`${file}\0${Buffer.byteLength("new helper")}\0`);expected.update("new helper");
    }
    const versionTwoHash=expected.copy().digest("hex");
    expect(runtimeSourceHash(root,1)).toBe(legacyHash);
    expect(runtimeSourceHash(root,2)).toBe(versionTwoHash);
    expect(()=>runtimeSourceHash(root)).toThrow();
    const helper="script/codex-session-consolidation.py";
    writeFileSync(join(root,helper),"new consolidation helper");
    expected.update(`${helper}\0${Buffer.byteLength("new consolidation helper")}\0`);expected.update("new consolidation helper");
    expect(runtimeSourceHash(root)).toBe(expected.digest("hex"));
    expect(runtimeSourceHash(root,1)).toBe(legacyHash);
    expect(runtimeSourceHash(root,2)).toBe(versionTwoHash);
    writeFileSync(join(root,helper),"changed consolidation helper");
    expect(runtimeSourceHash(root,1)).toBe(legacyHash);
    expect(runtimeSourceHash(root,2)).toBe(versionTwoHash);
    expect(()=>runtimeSourceHash(root,4 as 1)).toThrow("Unsupported runtime hash version");
    expect(captureRuntimeIdentity().hashVersion).toBe(3);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("runtime identity detects changed and missing code but ignores notes and build products", () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-identity-"));
  try {
    for (const path of ["src", "bin", "script", "scripts", "dist"]) mkdirSync(join(root, path));
    for (const file of ["src/cli.ts", "bin/quotapie", "script/awake_hook.py", "script/codex-host-wake.py", "scripts/codex-compaction-local.py", "script/codex-session-consolidation.py"]) writeFileSync(join(root, file), "initial");
    mkdirSync(join(root, "packages/quota-core/src"), { recursive: true });
    writeFileSync(join(root, "packages/quota-core/package.json"), "{}");
    writeFileSync(join(root, "packages/quota-core/src/index.ts"), "initial");
    const initial = runtimeSourceHash(root);
    writeFileSync(join(root, "TODO.md"), "notes");
    writeFileSync(join(root, "dist/app"), "build");
    expect(runtimeSourceHash(root)).toBe(initial);
    writeFileSync(join(root, "script/codex-session-consolidation.py"), "changed consolidation helper");
    expect(runtimeSourceHash(root)).not.toBe(initial);
    unlinkSync(join(root, "script/codex-session-consolidation.py"));
    expect(() => runtimeSourceHash(root)).toThrow();
    writeFileSync(join(root, "script/codex-session-consolidation.py"), "initial");
    writeFileSync(join(root, "script/codex-host-wake.py"), "changed wake helper");
    expect(runtimeSourceHash(root)).not.toBe(initial);
    unlinkSync(join(root, "script/codex-host-wake.py"));
    expect(() => runtimeSourceHash(root)).toThrow();
    writeFileSync(join(root, "script/codex-host-wake.py"), "initial");
    writeFileSync(join(root, "scripts/codex-compaction-local.py"), "changed provider helper");
    expect(runtimeSourceHash(root)).not.toBe(initial);
    unlinkSync(join(root, "scripts/codex-compaction-local.py"));
    expect(() => runtimeSourceHash(root)).toThrow();
    writeFileSync(join(root, "scripts/codex-compaction-local.py"), "initial");
    writeFileSync(join(root, "packages/quota-core/src/index.ts"), "changed core");
    expect(runtimeSourceHash(root)).not.toBe(initial);
    writeFileSync(join(root, "packages/quota-core/src/index.ts"), "initial");
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
