import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("installed HTTP collector gets app scheduling without launching a service", async () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-launchd-config-"));
  try {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "launchd"], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, QUOTAPIE_HOME: join(root, "data"), QUOTAPIE_CONFIG: join(root, "config.json") },
      stdout: "pipe", stderr: "pipe",
    });
    const [xml, errors, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0); expect(errors).toBe("");
    const parsed = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", "--", "-"], { stdin: Buffer.from(xml) });
    expect(parsed.exitCode).toBe(0);
    const plist = JSON.parse(parsed.stdout.toString());
    expect(plist.Label).toBe("local.quotapie");
    expect(plist.ProcessType).toBe("Interactive");
    expect(plist.ProgramArguments.at(-1)).toBe("serve");
    expect(plist.EnvironmentVariables.QUOTAPIE_HOME).toBe(join(root, "data"));
    expect(plist.EnvironmentVariables.QUOTAPIE_CONFIG).toBe(join(root, "config.json"));
    expect(plist.KeepAlive).toBe(true);
    expect(plist.Umask).toBe(63);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
