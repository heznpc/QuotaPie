import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectProfileRelay, connectAccountSessionRelay } from "../src/profile-relay";
import { startCompactionProxy } from "../src/codex-compaction";
import { CompactionStatusReader } from "../src/compaction-status";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { ModelNotifications } from "../src/model-notifications";

test("quota-only installs do not enable routing; manager failures stay sanitized", async () => {
  const root=await mkdtemp(join(tmpdir(),"qp-profile-relay-"));
  let calls=0;
  try {
    const runner=async(home:string)=>{expect(home).toBe('/profile/two');calls++;return true;};
    expect(await connectProfileRelay('/profile/two',root,runner)).toBe(false);
    expect(calls).toBe(0);
    await writeFile(join(root,'current.json'),'{}');
    expect(await connectProfileRelay('/profile/two',root,runner)).toBe(true);
    expect(calls).toBe(1);
    await expect(connectProfileRelay('/profile/two',root,async()=>{throw new Error('secret URL');})).rejects.toThrow('profile_relay_failed');
  }finally{await rm(root,{recursive:true,force:true});}
});

async function consolidatedProfileFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qp-profile-session-relay-")));
  const primaryHome = join(root, "primary"), sourceHome = join(root, "source");
  const primaryAppData = join(root, "primary-app"), sourceData = join(root, "source-app");
  const support = join(root, "QuotaPie"), journal = join(support, "journal"), relayRoot = join(root, "relay");
  for (const path of [primaryHome, sourceHome, primaryAppData, sourceData, support, journal, relayRoot])
    await mkdir(path, { mode: 0o700 });
  const sourceConfig = 'cli_auth_credentials_store = "file"\nmodel = "existing-source-model"\n';
  await writeFile(join(sourceHome, "config.toml"), sourceConfig, { mode: 0o600 });
  const manifestPath = join(journal, "manifest.json"), markerPath = join(support, "session-consolidation.json");
  const manifest = JSON.stringify({ version: 1, sourceHome, primaryHome, threadIds: ["22222222-2222-4222-8222-222222222222"] });
  await writeFile(manifestPath, manifest, { mode: 0o600 });
  const marker = { version: 1, state: "complete", primary: { codexHome: primaryHome, appData: primaryAppData },
    sources: [{ codexHome: sourceHome, appData: sourceData, manifestPath,
      manifestSHA256: createHash("sha256").update(manifest).digest("hex") }], completedAtMs: 1000 };
  await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
  await writeFile(join(relayRoot, "current.json"), "{}", { mode: 0o600 });
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "a", label: "A", enabled: false, codexHome: primaryHome },
    { id: "b", label: "B", enabled: true, codexHome: sourceHome }];
  return { root, primaryHome, sourceHome, sourceConfig, relayRoot, markerPath, manifestPath, marker, config,
    sessionLocation: { markerPath, primaryHome, primaryAppData, nowMs: 2000 } };
}

test("connecting a consolidated B credential verifies only the primary work relay without relabeling or enabling accounts", async () => {
  const f = await consolidatedProfileFixture();
  try {
    const original = JSON.stringify(f.config), calls: string[] = [];
    const result = await connectAccountSessionRelay(f.config, "b", { root: f.relayRoot, sessionLocation: f.sessionLocation,
      runner: async home => { calls.push(home); return true; } });
    expect(result).toEqual({ relayConnected: true, sessionOwner: "a", sessionConsolidated: true });
    expect(calls).toEqual([f.primaryHome]);
    expect(JSON.stringify(f.config)).toBe(original);
    expect(await readFile(join(f.sourceHome, "config.toml"), "utf8")).toBe(f.sourceConfig);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("unverified completed ownership never configures the retired relay or falls back to it", async () => {
  for (const kind of ["digest", "missing", "disabled"]) {
    const f = await consolidatedProfileFixture();
    try {
      if (kind === "digest") await writeFile(f.manifestPath, "{}");
      if (kind === "missing") await rm(f.manifestPath);
      if (kind === "disabled") f.config.accounts.codex[1]!.enabled = false;
      let calls = 0;
      await expect(connectAccountSessionRelay(f.config, "b", { root: f.relayRoot, sessionLocation: f.sessionLocation,
        runner: async () => { calls++; return true; } })).rejects.toThrow("session_location_unavailable");
      expect(calls).toBe(0);
      expect(await readFile(join(f.sourceHome, "config.toml"), "utf8")).toBe(f.sourceConfig);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("quota-only consolidated installs remain quota-only and an unchanged original profile keeps its relay", async () => {
  const f = await consolidatedProfileFixture();
  try {
    await rm(join(f.relayRoot, "current.json"));
    expect(await connectAccountSessionRelay(f.config, "b", { root: f.relayRoot, sessionLocation: f.sessionLocation,
      runner: async () => { throw new Error("must not enable routing"); } }))
      .toEqual({ relayConnected: false, sessionOwner: "a", sessionConsolidated: true });
  } finally { await rm(f.root, { recursive: true, force: true }); }
  const original = await consolidatedProfileFixture();
  try {
    await rm(original.markerPath);
    const calls: string[] = [];
    expect(await connectAccountSessionRelay(original.config, "b", { root: original.relayRoot,
      sessionLocation: original.sessionLocation, runner: async home => { calls.push(home); return true; } }))
      .toEqual({ relayConnected: true, sessionOwner: "b", sessionConsolidated: false });
    expect(calls).toEqual([original.sourceHome]);
  } finally { await rm(original.root, { recursive: true, force: true }); }
});

test("changed consolidation evidence cannot report success after a primary relay check", async () => {
  const f = await consolidatedProfileFixture();
  try {
    const calls: string[] = [];
    await expect(connectAccountSessionRelay(f.config, "b", { root: f.relayRoot, sessionLocation: f.sessionLocation,
      runner: async home => { calls.push(home); await rm(f.markerPath); return true; } })).rejects.toThrow("session_location_unavailable");
    expect(calls).toEqual([f.primaryHome]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a failed primary relay check never retries a consolidated credential root", async () => {
  const f = await consolidatedProfileFixture();
  try {
    const calls: string[] = [];
    await expect(connectAccountSessionRelay(f.config, "b", { root: f.relayRoot, sessionLocation: f.sessionLocation,
      runner: async home => { calls.push(home); throw new Error("private endpoint"); } })).rejects.toThrow("profile_relay_failed");
    expect(calls).toEqual([f.primaryHome]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("profile relay registration preserves primary, retains old generations and disables every linked profile",async()=>{
 const process=Bun.spawn(['python3','-B','tests/profile_relay_registration.py'],{stdout:'pipe',stderr:'pipe'});
 expect(await new Response(process.stderr).text()).toBe('');
 expect(await process.exited).toBe(0);
});

test("compaction through both profile relays reaches the native notification outbox independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "qp-profile-notices-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.collection.codexEnabled = false;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const relays: ReturnType<typeof startCompactionProxy>[] = [];
  try {
    const paths: string[] = [];
    for (let index = 1; index <= 2; index++) {
      const directory = join(root, "releases", String(index));
      await mkdir(directory, { recursive: true });
      const token = String(index).repeat(48);
      const relay = startCompactionProxy({ token, fetchUpstream: async (_url, init) => {
        expect(JSON.parse(String(init?.body)).model).toBe("gpt-5.6-sol");
        return new Response('data: {"type":"response.completed","response":{"model":"gpt-5.6-sol"}}\n\n',
          { headers: { "content-type": "text/event-stream" } });
      } });
      relays.push(relay);
      const path = join(directory, "settings.json");
      paths.push(path);
      await writeFile(path, JSON.stringify({ port: Number(new URL(relay.baseUrl).port), token }));
      const response = await fetch(relay.baseUrl + "/responses/compact", { method: "POST",
        body: JSON.stringify({ model: "gpt-6-astra", reasoning: { effort: "xhigh" } }) });
      expect(response.ok).toBe(true);
      await response.text();
    }
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: paths[0], profile_settings: { second: paths[1] } }));
    const reader = new CompactionStatusReader(root);
    expect((await reader.status()).recent).toHaveLength(2);
    expect(new Set(reader.notificationEvents().map(event=>event.notificationScope)).size).toBe(2);
    const observer = new ModelNotifications(service.storage, service.alerts);
    observer.observe(reader.notificationEvents(), config, "ko");
    const notifications = service.alerts.pendingAppNotifications(Date.now());
    expect(notifications).toHaveLength(2);
    expect(notifications.every(item => item.title === "Codex 압축 모델 전환")).toBe(true);
    observer.observe(reader.notificationEvents(), config, "ko");
    expect(service.alerts.pendingAppNotifications(Date.now())).toHaveLength(2);
  } finally {
    for (const relay of relays) relay.stop();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
