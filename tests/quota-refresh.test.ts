import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import type { QuotaObservation } from "../src/types";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quotapie-refresh-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts = { codex: [], claude: [] };
  config.collection.codexEnabled = true;
  config.collection.claudeOAuthEnabled = false;
  config.alerts.enabled = false;
  config.resetSignals.enabled = false;
  config.dashboard.port = 0;
  for (const id of ["a", "b"]) {
    const home = join(root, id); mkdirSync(home);
    writeFileSync(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    config.accounts.codex.push({ id, enabled: true, label: id, codexHome: home });
  }
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  return { config, service, close: async () => { await service.close(); rmSync(root, { recursive: true, force: true }); } };
}
function sample(account: string, atMs: number): QuotaObservation {
  return { provider: "codex", account, bucket: "codex:primary:300", label: "Codex 5h",
    windowSeconds: 18000, observedAtMs: atMs, usedPercent: 42, resetsAtMs: atMs + 3600000,
    source: "codex-app-server", quality: "authoritative" };
}

test("fresh provider measurements are readable by queued clients before historical analysis", async () => {
  const f = fixture();
  let release!: () => void;
  const provider = new Promise<void>(resolve => { release = resolve; });
  let readBeforeAnalysis = false;
  let received: ReturnType<QuotaPieService["quotaAccounts"]> = [];
  const poll = spyOn(f.service, "pollCodex").mockImplementation(async () => {
    await provider;
    f.service.ingestCodexSnapshot([sample("a", Date.now())]);
    return [];
  });
  const claude = spyOn(f.service, "pollClaudeOAuth").mockResolvedValue([]);
  const reset = spyOn(f.service, "refreshResetTiming").mockImplementation(() => {
    expect(readBeforeAnalysis).toBe(true);
  });
  const boundary = spyOn(f.service, "publishBoundary").mockResolvedValue(undefined);
  const pending = f.service.tick();
  const client = new Promise<void>(resolve => setTimeout(() => {
    received = f.service.quotaAccounts();
    readBeforeAnalysis = !f.service.collectionStatus().refreshing;
    resolve();
  }, 0));
  try {
    release();
    await Promise.all([pending, client]);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(received[0]?.windows[0]).toMatchObject({ remainingPercent: 58, freshness: "fresh" });
  } finally {
    release(); await pending;
    poll.mockRestore(); claude.mockRestore(); reset.mockRestore(); boundary.mockRestore(); await f.close();
  }
});

test("closing during the post-collection yield never analyses a closed database", async () => {
  const f = fixture();
  const poll = spyOn(f.service, "pollCodex").mockResolvedValue([]);
  const claude = spyOn(f.service, "pollClaudeOAuth").mockResolvedValue([]);
  const reset = spyOn(f.service, "refreshResetTiming");
  let closing: Promise<void> | undefined;
  setTimeout(() => { closing = f.close(); }, 0);
  try {
    const result = await f.service.tick();
    await closing;
    expect(result).toMatchObject({ collected: false, windows: [], triggers: [] });
    expect(reset).not.toHaveBeenCalled();
  } finally {
    poll.mockRestore(); claude.mockRestore(); reset.mockRestore();
    if (closing) await closing; else await f.close();
  }
});

test("quota HTTP returns persisted measurements and task readiness without historical or forecast scans", async () => {
  const f = fixture(), now = Date.now();
  f.service.ingestCodexSnapshot([sample("a", now - 601000)]);
  const heavy = [spyOn(f.service, "analyses"), spyOn(f.service, "resetPlanning"),
    spyOn(f.service, "recentWorkStatus"), spyOn(f.service.db, "analysisHistory")];
  const tasks = spyOn(f.service.resumeTasks, "active").mockReturnValue([{ id: "fixture-task", provider: "claude",
    account: "default", state: "ready", projectLabel: "fixture", registeredAtMs: now } as any]);
  heavy.forEach(spy => spy.mockImplementation(() => { throw new Error("heavy path reached"); }));
  const server = startDashboard(f.service, f.config), base = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(base + "/api/quota");
    expect(response.status).toBe(200);
    const data: any = await response.json();
    expect(data.accounts[0].windows[0]).toMatchObject({ remainingPercent: 58, freshness: "stale", observedAtMs: now - 601000 });
    expect(data.collection.refreshing).toBe(false);
    expect(data.autoResume.accounts.every((account: any) => account.enabled === false)).toBe(true);
    expect(data.autoResume.incidents).toEqual([]);
    expect(data.compaction.active).toEqual([]);
    expect(typeof data.compaction.checkedAtMs).toBe("number");
    expect(data.resumeTasks[0]).toMatchObject({ id: "fixture-task", state: "waiting" });
    expect(typeof data.actionToken).toBe("string");
    expect(data).not.toHaveProperty("recentWork");
    expect(data).not.toHaveProperty("resetTiming");
    expect(JSON.stringify(data).length).toBeLessThan(15000);
    for (const spy of heavy) expect(spy).not.toHaveBeenCalled();
  } finally { server.stop(true); tasks.mockRestore(); heavy.forEach(spy => spy.mockRestore()); await f.close(); }
});

test("refresh HTTP authenticates and accepts asynchronously without dispatching inference", async () => {
  const f = fixture(), request = spyOn(f.service, "requestCollection");
  const poll = spyOn(f.service, "pollCodex").mockImplementation(() => new Promise(() => {}));
  const server = startDashboard(f.service, f.config), base = `http://127.0.0.1:${server.port}`;
  try {
    const { actionToken }: any = await (await fetch(base + "/api/quota")).json();
    const headers = { "x-quotapie-action-token": actionToken };
    expect((await fetch(base + "/api/collection/refresh", { method: "POST" })).status).toBe(403);
    expect((await fetch(base + "/api/collection/refresh", { method: "POST", headers: { ...headers, origin: "https://other.example" } })).status).toBe(403);
    expect((await fetch(base + "/api/collection/refresh", { method: "POST", headers, body: '{"reason":"send"}' })).status).toBe(400);
    expect((await fetch(base + "/api/collection/refresh", { headers })).status).toBe(405);
    expect(request).not.toHaveBeenCalled();
    const response = await fetch(base + "/api/collection/refresh", { method: "POST", headers, body: '{"reason":"wake"}', signal: AbortSignal.timeout(1000) });
    expect(response.status).toBe(202);
    expect((await response.json() as any).collection.requestedAtMs).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
    expect(f.service.work.store.executions()).toHaveLength(0);
    expect((await fetch(base + "/api/collection/refresh", { method: "POST", headers, body: '{"reason":"visible"}' })).status).toBe(202);
  } finally { server.stop(true); request.mockRestore(); poll.mockRestore(); await f.close(); }
});

test("a healthy account or old success cannot mask failed-account retries; early polls skip it", async () => {
  const f = fixture(); let now = 2000000000000, fails = true, calls = { a: 0, b: 0 };
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const factory = spyOn(f.service as any, "createCodexClient").mockImplementation((profile: any) => ({
    readRateLimits: async () => { calls[profile.id as "a" | "b"]++; if (profile.id === "a" && fails) throw new Error("offline"); return [sample(profile.id, now)]; },
    close: async () => {},
  }));
  try {
    f.service.collection.recordAttempt("codex", "a", "codex-appserver", now - 100, null);
    await f.service.pollCodex(true);
    expect(f.service.nextCollectionDelayMs(60000, now)).toBe(5000);
    now += 1000; await f.service.pollCodex(true);
    expect(calls).toEqual({ a: 1, b: 1 });
    now += 4000; await expect(f.service.pollCodex(true)).rejects.toThrow("all attempted Codex accounts failed (a)");
    expect(f.service.nextCollectionDelayMs(60000, now)).toBe(15000);
    now += 15000; await expect(f.service.pollCodex(true)).rejects.toThrow("all attempted Codex accounts failed (a)");
    expect(f.service.nextCollectionDelayMs(60000, now)).toBe(30000);
    expect(calls).toEqual({ a: 3, b: 1 });
    f.config.accounts.codex[0]!.enabled = false;
    expect(f.service.nextCollectionDelayMs(60000, now)).toBe(40000);
    f.config.accounts.codex[0]!.enabled = true;
    fails = false; await f.service.pollCodex(); // Explicit refresh bypasses the retry timer.
    expect(f.service.nextCollectionDelayMs(60000, now)).toBe(60000);
    f.config.collection.codexEnabled = false;
    expect(f.service.nextCollectionDelayMs(60000, now)).toBe(60000);
  } finally { clock.mockRestore(); factory.mockRestore(); await f.close(); }
});

test("wake merges into a coalesced request and in-flight collection reports its lifecycle", async () => {
  const f = fixture(); let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const codex = spyOn(f.service, "pollCodex").mockImplementation(async () => { await wait; return []; });
  const claude = spyOn(f.service, "pollClaudeOAuth").mockResolvedValue([]);
  const boundary = spyOn(f.service, "publishBoundary").mockResolvedValue(undefined);
  try {
    f.service.requestCollection(); f.service.requestCollection(true);
    expect(f.service.collectionStatus().refreshing).toBe(true);
    const pending = f.service.tick();
    expect(f.service.collectionStatus().refreshing).toBe(true);
    expect(codex).toHaveBeenCalledWith(false);
    release(); await pending;
    expect(f.service.collectionStatus().refreshing).toBe(false);
    expect(f.service.collectionStatus().lastFinishedAtMs).toBeGreaterThanOrEqual(f.service.collectionStatus().lastStartedAtMs!);
    expect(claude.mock.calls[0]).toHaveLength(1); // Keep Claude's minimum polling interval.
  } finally { release(); codex.mockRestore(); claude.mockRestore(); boundary.mockRestore(); await f.close(); }
});

test("multiple requests during a running watch cause one follow-up, never a parallel loop", async () => {
  const f = fixture(); f.config.accounts.codex = [];
  let release!: () => void, started!: () => void, count = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const tick = spyOn(f.service, "tick").mockImplementation(async () => {
    count++;
    if (count === 1) { started(); await waiting; }
    else f.service.stop();
    return { events: [], windows: [], triggers: [], collected: false };
  });
  try {
    const watching = f.service.watch(); await entered;
    f.service.requestCollection(true); f.service.requestCollection(true); f.service.requestCollection(true);
    expect(count).toBe(1); release(); await watching;
    expect(count).toBe(2);
    expect(f.service.nextCollectionDelayMs(60000)).toBe(60000);
  } finally { release(); f.service.stop(); tick.mockRestore(); await f.close(); }
});

test("wake refreshes immediately while repeated visible/network requests are bounded between completed polls", async () => {
  const f = fixture(); f.config.accounts.codex = [];
  let now = 2_000_000_000_000, count = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const tick = spyOn(f.service, "tick").mockImplementation(async () => {
    count++;
    return { events: [], windows: [], triggers: [], collected: false };
  });
  const waitFor = async (expected: number) => {
    for (let attempt = 0; attempt < 50 && count < expected; attempt++) await Bun.sleep(1);
    expect(count).toBe(expected);
  };
  const watching = f.service.watch();
  try {
    await waitFor(1); await Bun.sleep(1);
    f.service.requestCollection(true); await waitFor(2); await Bun.sleep(1);
    const firstRequest = f.service.collectionStatus().requestedAtMs;
    for (let i = 0; i < 5; i++) { now += 1_000; f.service.requestCollection(true); }
    await Bun.sleep(5);
    expect(count).toBe(2);
    expect(f.service.collectionStatus().requestedAtMs).toBe(firstRequest);
    now = firstRequest! + QuotaPieService.FORCED_COLLECTION_MIN_INTERVAL_MS;
    f.service.requestCollection(true); await waitFor(3);
    expect(f.service.collectionStatus().requestedAtMs).toBe(now);
  } finally { f.service.stop(); await watching; clock.mockRestore(); tick.mockRestore(); await f.close(); }
});

test("a failed account still retries in five seconds even when another wake request is coalesced", async () => {
  const f = fixture(); let now = 2_000_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const calls = { a: 0, b: 0 };
  const factory = spyOn(f.service as any, "createCodexClient").mockImplementation((profile: any) => ({
    readRateLimits: async () => {
      calls[profile.id as "a" | "b"]++;
      if (profile.id === "a") throw new Error("offline");
      return [sample(profile.id, now)];
    }, close: async () => {},
  }));
  try {
    f.service.requestCollection(true); await f.service.pollCodex();
    now += 1_000; f.service.requestCollection(true);
    expect(f.service.nextCollectionDelayMs(60_000, now)).toBe(4_000);
    now += 4_000; await expect(f.service.pollCodex(true)).rejects.toThrow("all attempted Codex accounts failed (a)");
    expect(calls).toEqual({ a: 2, b: 1 });
    expect(f.service.nextCollectionDelayMs(60_000, now)).toBe(15_000);
  } finally { clock.mockRestore(); factory.mockRestore(); await f.close(); }
});

test("healthy-account deadlines remain scheduled independently of another account's retry", async () => {
  const f = fixture(); let now = 2_000_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now), calls = { a: 0, b: 0 };
  const factory = spyOn(f.service as any, "createCodexClient").mockImplementation((profile: any) => ({
    readRateLimits: async () => {
      calls[profile.id as "a" | "b"]++;
      if (profile.id === "a") throw new Error("offline");
      return [sample(profile.id, now)];
    }, close: async () => {},
  }));
  try {
    await f.service.pollCodex(true);
    for (const delay of [5_000, 15_000, 30_000]) {
      now += delay; await expect(f.service.pollCodex(true)).rejects.toThrow("all attempted Codex accounts failed (a)");
    }
    expect(calls).toEqual({ a: 4, b: 1 });
    expect(f.service.nextCollectionDelayMs(60_000, now)).toBe(10_000);
    now += 10_000; await f.service.pollCodex(true);
    expect(calls).toEqual({ a: 4, b: 2 });
    expect(f.service.nextCollectionDelayMs(60_000, now)).toBe(20_000);
  } finally { clock.mockRestore(); factory.mockRestore(); await f.close(); }
});

test("healthy-account scheduling preserves reset and freshness wake deadlines", async () => {
  const f = fixture(); let now = 2_000_000_000_000;
  f.config.collection.pollSeconds = 300;
  f.config.collection.staleAfterSeconds = 60;
  const clock = spyOn(Date, "now").mockImplementation(() => now), calls = { a: 0, b: 0 };
  const factory = spyOn(f.service as any, "createCodexClient").mockImplementation((profile: any) => ({
    readRateLimits: async () => {
      calls[profile.id as "a" | "b"]++;
      return [{ ...sample(profile.id, now), resetsAtMs: now + (profile.id === "a" ? 10_000 : 3600000) }];
    }, close: async () => {},
  }));
  try {
    await f.service.pollCodex(true);
    expect(f.service.nextCollectionDelayMs(300_000, now)).toBe(11_000);
    now += 11_000; await f.service.pollCodex(true);
    expect(calls).toEqual({ a: 2, b: 1 });
    now += 50_000; await f.service.pollCodex(true);
    expect(calls).toEqual({ a: 3, b: 2 });
  } finally { clock.mockRestore(); factory.mockRestore(); await f.close(); }
});

test("switching a previously healthy profile to keychain keeps isolation closed without a one-second wake loop", async () => {
  const f = fixture(); let now = 2_000_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now), calls = { a: 0, b: 0 };
  const factory = spyOn(f.service as any, "createCodexClient").mockImplementation((profile: any) => ({
    readRateLimits: async () => { calls[profile.id as "a" | "b"]++; return [sample(profile.id, now)]; },
    close: async () => {},
  }));
  const profileConfig = join(f.config.accounts.codex[0]!.codexHome!, "config.toml");
  try {
    await f.service.pollCodex(true);
    writeFileSync(profileConfig, 'cli_auth_credentials_store = "keychain"\n');
    now += 60_000; await f.service.pollCodex(true);
    expect(calls).toEqual({ a: 1, b: 2 });
    expect(f.service.codexPollResults().find(result => result.account === "a")?.error).toContain("multi-account Codex requires");
    expect(f.service.nextCollectionDelayMs(60_000, now)).toBe(60_000);
    now += 1_000; await f.service.pollCodex(true);
    expect(calls).toEqual({ a: 1, b: 2 });
    expect(f.service.nextCollectionDelayMs(60_000, now)).toBe(59_000);
    writeFileSync(profileConfig, 'cli_auth_credentials_store = "file"\n');
    await f.service.pollCodex(); // An explicit refresh can immediately verify the repair.
    expect(calls).toEqual({ a: 2, b: 3 });
    expect(f.service.codexPollResults().find(result => result.account === "a")?.error).toBeNull();
    expect(f.service.nextCollectionDelayMs(60_000, now)).toBe(60_000);
  } finally { clock.mockRestore(); factory.mockRestore(); await f.close(); }
});
