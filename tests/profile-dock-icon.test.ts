import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { profileDockIcon, readDockIcon } from "../src/profile-dock-icon";
import { CodexAppServerClient } from "../src/providers/codex-appserver";

test("Dock preferences keep default, legacy Codex and explicit Space distinct", () => {
  const root = mkdtempSync(join(tmpdir(), "qp-icon-"));
  try {
    expect(readDockIcon(root)).toBe("app-default");
    writeFileSync(join(root,"config.toml"),'[desktop]\ndock-icon-preference = "codex-dark"\n');
    expect(readDockIcon(root)).toBe("codex-system");
    writeFileSync(join(root,"config.toml"),'[desktop]\ndock-icon-preference = "space-system"\n');
    expect(readDockIcon(root)).toBe("space-system");
    writeFileSync(join(root,"config.toml"),'[desktop]\ndock-icon-preference = "unknown"\n');
    expect(() => readDockIcon(root)).toThrow("unsupported_icon");
    writeFileSync(join(root,"config.toml"),'[desktop]\ndock-icon-preference = 42\n');
    expect(() => readDockIcon(root)).toThrow();
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("icon actions resolve registered accounts, verify persistence and close the writer", async () => {
  const root = mkdtempSync(join(tmpdir(),"qp-icon-action-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex[0]!.codexHome = root;
  let closed = 0, writes = 0;
  const factory = (home: string) => ({
    async writeDockIcon(icon: string) {
      expect(home).toBe(root); writes++;
      writeFileSync(join(home,"config.toml"),`[desktop]\ndock-icon-preference = "${icon}"\n`);
    }, async close() { closed++; },
  }) as unknown as CodexAppServerClient;
  try {
    expect(await profileDockIcon(config,{account:"default"},factory)).toEqual({icon:"app-default",changed:false});
    expect(await profileDockIcon(config,{account:"default",icon:"codex-system"},factory)).toEqual({icon:"codex-system",changed:true});
    expect(closed).toBe(1);
    await profileDockIcon(config,{account:"default",icon:"codex-system"},factory);
    expect(writes).toBe(1);
    await expect(profileDockIcon(config,{account:"/tmp/foreign",icon:"app-default"},factory)).rejects.toThrow();
    await expect(profileDockIcon(config,{account:"default",icon:"../icon"},factory)).rejects.toThrow();
    config.accounts.codex[0]!.enabled = false;
    await expect(profileDockIcon(config,{account:"default",icon:"app-default"},factory)).rejects.toThrow();
    config.accounts.codex[0]!.enabled = true;
    const noWrite = () => ({async writeDockIcon(){},async close(){closed++;}}) as unknown as CodexAppServerClient;
    await expect(profileDockIcon(config,{account:"default",icon:"space-system"},noWrite)).rejects.toThrow("icon_write_unverified");
    expect(readFileSync(join(root,"config.toml"),"utf8")).toContain('"codex-system"');
    expect(closed).toBe(2);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
test("Dock icon API requires a local action token and rejects unknown accounts", async () => {
  const root = mkdtempSync(join(tmpdir(),"qp-icon-api-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.dashboard.port = 0;
  config.accounts.codex[0]!.codexHome = root;
  const service = new QuotaPieService(config,new QuotaDatabase(":memory:"));
  const server = startDashboard(service,config);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const status = await (await fetch(base + "/api/status")).json() as any;
    const post = (body: unknown, headers: Record<string,string> = {}) => fetch(base + "/api/profiles/dock-icon", {
      method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body),
    });
    expect((await post({account:"default"})).status).toBe(403);
    const token = {"x-quotapie-action-token":status.actionToken};
    expect((await post({account:"default"},{...token,origin:"https://example.invalid"})).status).toBe(403);
    expect((await post({account:"missing"},token)).status).toBe(409);
    expect((await post({account:"default",icon:"custom-script"},token)).status).toBe(409);
    expect(await (await post({account:"default"},token)).json()).toEqual({icon:"app-default",changed:false});
  } finally { server.stop(true); await service.close(); rmSync(root,{recursive:true,force:true}); }
});
