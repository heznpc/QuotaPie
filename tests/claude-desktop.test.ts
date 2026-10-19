import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../src/config";
import { saveClaudeDesktopConnection } from "../src/claude-desktop-connection";
import { ClaudeDesktopError, mapClaudeDesktopUsage, readClaudeDesktop } from "../src/providers/claude-desktop";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import { resumeProfileKey } from "../src/resume-gate";
import { jobProfile } from "../src/jobs/runner";
import { inspectWorkTarget } from "../src/work/runtime";
import { planTriggers } from "../src/triggers";
import { ACCOUNT_PLAN_KINDS } from "../src/types";

const identity = { accountId: "11111111-1111-4111-8111-111111111111", organizationId: "22222222-2222-4222-8222-222222222222" };
const otherIdentity = { ...identity, accountId: "33333333-3333-4333-8333-333333333333" };
const usage = { five_hour: { utilization: 23, resets_at: "2030-01-01T00:00:00Z" } };
const success = (body: unknown = usage, who = identity) => ({ ok: true, ...who, usage: body });

function fixture(read: (connect: boolean) => Promise<unknown>) {
  const root = mkdtempSync(join(tmpdir(), "qp-desktop-")), path = join(root, "config.json");
  const initial = structuredClone(DEFAULT_CONFIG);
  initial.collection.codexEnabled = false;
  initial.collection.claudeOAuthEnabled = false;
  initial.alerts.enabled = false;
  writeFileSync(path, JSON.stringify({ ...initial, custom: "keep-this" }));
  const config = loadConfig(path);
  const databasePath = join(root, "quota.db");
  const service = new QuotaPieService(config, new QuotaDatabase(databasePath), { quota: null, workState: null }, { read });
  return { root, path, config, service, databasePath, async close() { await service.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("Claude desktop adapter", () => {
  test("plan metadata is allowlisted and absent numeric limits never imply a Free plan", async () => {
    for (const plan of ACCOUNT_PLAN_KINDS) {
      const result = await readClaudeDesktop(false, { read: async () => ({ ...success({ limits: [] }), plan }) });
      expect(result.plan).toBe(plan);
      expect(mapClaudeDesktopUsage(result.usage, "bound")).toEqual([]);
    }
    for (const plan of [undefined, null, "secret-provider-value", "Free", { kind: "free" }]) {
      const result = await readClaudeDesktop(false, { read: async () => ({ ...success({ limits: [] }), plan }) });
      expect(result.plan).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("secret-provider-value");
    }
  });

  test("legacy and scoped desktop limits retain observed periods without invented windows", () => {
    const mapped = mapClaudeDesktopUsage({ seven_day: { utilization: 51, resets_at: null }, limits: [
      { kind: "weekly_all", group: "weekly", percent: 90 },
      { kind: "weekly_scoped", group: "weekly", percent: 12, scope: { surface: { display_name: "Cowork" } } },
    ] }, "bound", 100);
    expect(mapped.map(item => item.bucket)).toEqual(["seven_day", "seven_day_cowork"]);
    expect(mapped[0]!.usedPercent).toBe(51);
    expect(mapped.every(item => item.source === "claude-desktop" && item.quality === "authoritative")).toBe(true);
    expect(mapClaudeDesktopUsage({ limits: [] }, "bound")).toEqual([]);
    expect(mapClaudeDesktopUsage({ five_hour: null, seven_day: null }, "bound")).toEqual([]);
    expect(mapClaudeDesktopUsage({}, "bound")).toEqual([]);
  });

  test("malformed and changed schemas are failures rather than zero or unlimited usage", () => {
    for (const payload of [null, [], "html", { unexpected: 42 }, { limits: "changed" },
      { five_hour: { utilization: "23" } }, { five_hour: { utilization: 1, resets_at: "garbage" } },
      { five_hour: {} }, { five_hour: { utilization: 101 } },
      { limits: [{ kind: "session", group: "session", percent: Infinity }] },
      { limits: [{ kind: "future_period", group: "future", percent: 12 }] },
      { limits: [{ kind: "weekly_scoped", group: "weekly", percent: 12, scope: { model: { display_name: "bad\nname" } } }] }])
      expect(() => mapClaudeDesktopUsage(payload, "bound")).toThrow(ClaudeDesktopError);
  });

  test("helper errors preserve safe categories, never provider text or secret output", async () => {
    for (const category of ["auth-required", "auth-expired", "access-denied", "rate-limited", "network", "claude-desktop-unavailable", "claude-desktop-keychain", "account-mismatch"] as const) {
      try {
        await readClaudeDesktop(false, { read: async () => ({ ok: false, category, error: "secret-session-cookie" }) });
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ClaudeDesktopError);
        expect((error as ClaudeDesktopError).category).toBe(category);
        expect(String(error)).not.toContain("secret-session-cookie");
      }
    }
    await expect(readClaudeDesktop(false, { read: async () => success(usage, { ...identity, accountId: "bad" }) })).rejects.toThrow(ClaudeDesktopError);
    await expect(readClaudeDesktop(false, { read: async () => { throw new Error("secret-session-cookie"); } })).rejects.toThrow("connection is unavailable");
  });

  test("background helper has no interactive argument and timeout/output bounds remain asynchronous", async () => {
    const root = mkdtempSync(join(tmpdir(), "qp-desktop-helper-")), helper = join(root, "helper");
    try {
      writeFileSync(helper, `#!${process.execPath}\nconsole.log(JSON.stringify({ok:true,accountId:${JSON.stringify(identity.accountId)},organizationId:${JSON.stringify(identity.organizationId)},usage:process.argv.includes('--connect')?{seven_day:{utilization:30}}:{five_hour:{utilization:20}}}));\n`);
      chmodSync(helper, 0o700);
      expect((await readClaudeDesktop(false, { helperPath: helper })).usage).toHaveProperty("five_hour");
      expect((await readClaudeDesktop(true, { helperPath: helper })).usage).toHaveProperty("seven_day");
      writeFileSync(helper, `#!${process.execPath}\nwhile(true) {}\n`);
      let timerRan = false;
      setTimeout(() => { timerRan = true; }, 5);
      await expect(readClaudeDesktop(false, { helperPath: helper, timeoutMs: 50 })).rejects.toThrow(ClaudeDesktopError);
      expect(timerRan).toBe(true);
      writeFileSync(helper, `#!${process.execPath}\nconsole.log('x'.repeat(300000));\n`);
      await expect(readClaudeDesktop(false, { helperPath: helper })).rejects.toThrow(ClaudeDesktopError);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Claude desktop binding and collection", () => {
  test("verified Free plan survives no-windows and restart, but expires without fresh collection", async () => {
    const f = fixture(async () => ({ ...success({ five_hour: null, seven_day: null, limits: [] }), plan: "free" }));
    try {
      const result = await f.service.connectClaudeDesktop(f.path);
      expect(result.quotaAvailable).toBe(false);
      expect(result.account.plan?.kind).toBe("free");
      expect(result.account.windows).toEqual([]);
      expect(result.account.collection.errorCategory).toBe("no-windows");
      expect(f.service.analyses()).toEqual([]);
      expect(f.service.quotaAccounts().find(account => account.account === "default")?.plan).toBeUndefined();
      expect(readFileSync(f.path, "utf8")).not.toContain('"plan"');
      const observedAtMs = result.account.plan!.observedAtMs;
      const restarted = new QuotaPieService(loadConfig(f.path), new QuotaDatabase(f.databasePath), { quota: null, workState: null });
      try {
        const current = (now: number) => restarted.quotaAccounts(now).find(account => account.account === result.account.account)!;
        expect(current(observedAtMs + 1).plan).toEqual(result.account.plan);
        expect(current(observedAtMs + f.config.collection.staleAfterSeconds * 1_000 + 1).plan).toBeUndefined();
        expect(current(observedAtMs - 1).plan).toBeUndefined();
        restarted.config.accounts.claude.find(account => account.id === result.account.account)!.desktopBinding = otherIdentity;
        expect(current(observedAtMs + 1).plan).toBeUndefined();
      } finally { await restarted.close(); }
    } finally { await f.close(); }
  });

  test("a failed or mismatched desktop collection clears the old plan until another verified read", async () => {
    let response: unknown = { ...success(usage), plan: "max" };
    const f = fixture(async () => response);
    try {
      const result = await f.service.connectClaudeDesktop(f.path), account = result.account.account;
      expect(result.account.plan?.kind).toBe("max");
      let pollAt = Date.now();
      const poll = async () => { pollAt += 300_001; await f.service.pollClaudeDesktop(pollAt); };
      const state = () => f.service.quotaAccounts().find(item => item.account === account)!;
      for (const category of ["network", "rate-limited", "auth-expired", "access-denied", "account-mismatch"] as const) {
        response = { ok: false, category, error: "not-safe-to-display" };
        await poll();
        expect(state().plan).toBeUndefined();
        expect(f.service.collection.sourceStates().find(row => row.account === account)?.accountPlan).toBeUndefined();
        response = { ...success({ limits: [] }), plan: "free" };
        await poll();
        expect(state().plan?.kind).toBe("free");
        expect(state().windows).toEqual([]);
      }
      response = { ...success({ limits: [] }, otherIdentity), plan: "pro" };
      await poll();
      expect(state().collection.errorCategory).toBe("account-mismatch");
      expect(state().plan).toBeUndefined();
      response = success({ limits: [] });
      await poll();
      expect(state().plan?.kind).toBe("unknown");
      expect(state().windows).toEqual([]);
    } finally { await f.close(); }
  });

  test("connection is explicit, distinct from Code, atomic and idempotent", async () => {
    let reads = 0;
    const f = fixture(async connect => { reads++; expect(connect).toBe(true); return success(); });
    try {
      await f.service.pollClaudeDesktop();
      expect(reads).toBe(0);
      const codeBefore = structuredClone(f.config.accounts.claude[0]);
      const connected = await f.service.connectClaudeDesktop(f.path);
      expect(connected.connected).toBe(true);
      expect(connected.quotaAvailable).toBe(true);
      expect(connected.account.connection).toBe("claude-desktop");
      expect(connected.account.account).toMatch(/^desktop-/);
      expect(f.config.accounts.claude[0]).toEqual(codeBefore);
      const again = saveClaudeDesktopConnection(f.config, identity, f.path);
      expect(again.id).toBe(connected.account.account);
      expect(f.config.accounts.claude).toHaveLength(2);
      expect(JSON.parse(readFileSync(f.path, "utf8")).custom).toBe("keep-this");
      expect(readFileSync(f.path, "utf8")).not.toContain("utilization");
      const changed = JSON.parse(readFileSync(f.path, "utf8")); changed.accounts.claude[0].label = "New label";
      writeFileSync(f.path, JSON.stringify(changed));
      expect(() => saveClaudeDesktopConnection(f.config, otherIdentity, f.path)).toThrow("settings_changed");
      expect(loadConfig(f.path).accounts.claude[0]!.label).toBe("New label");
    } finally { await f.close(); }
  });

  test("empty, changed identity and denied access hide saved limits across restart without touching Code history", async () => {
    let response: unknown = success();
    const f = fixture(async () => response);
    try {
      f.service.db.ingestFullSnapshot("claude", "default", [{ provider: "claude", account: "default", bucket: "seven_day_opus",
        label: "Opus", source: "claude-oauth", quality: "authoritative", usedPercent: 88,
        observedAtMs: Date.now(), resetsAtMs: null, windowSeconds: 604800 }], f.config);
      const first = await f.service.connectClaudeDesktop(f.path), account = first.account.account;
      response = success({ limits: [] });
      await f.service.pollClaudeDesktop(Date.now() + 300_001);
      let state = f.service.quotaAccounts().find(item => item.account === account)!;
      expect(state.collection.errorCategory).toBe("no-windows");
      expect(state.windows).toEqual([]);
      expect(f.service.analyses().filter(item => item.account === account)).toEqual([]);
      expect(f.service.db.latest("claude", "default", "seven_day_opus")?.usedPercent).toBe(88);
      const restarted = new QuotaPieService(loadConfig(f.path), new QuotaDatabase(f.databasePath), { quota: null, workState: null }, { read: async () => response });
      try { expect(restarted.quotaAccounts().find(item => item.account === account)!.windows).toEqual([]); }
      finally { await restarted.close(); }
      for (const category of ["network", "rate-limited"] as const) {
        response = { ok: false, category, error: "must-not-restore-history" };
        await f.service.pollClaudeDesktop(Date.now() + (category === "network" ? 600_002 : 900_003));
        expect(f.service.quotaAccounts().find(item => item.account === account)!.windows).toEqual([]);
        expect(f.service.analyses().filter(item => item.account === account)).toEqual([]);
      }
      response = success(usage, otherIdentity);
      await f.service.pollClaudeDesktop(Date.now() + 1200_004);
      state = f.service.quotaAccounts().find(item => item.account === account)!;
      expect(state.collection.errorCategory).toBe("account-mismatch");
      expect(state.windows).toEqual([]);
      response = { ok: false, category: "access-denied", error: "raw-secret" };
      await f.service.pollClaudeDesktop(Date.now() + 1500_005);
      expect(f.service.quotaAccounts().find(item => item.account === account)!.windows).toEqual([]);
      expect(JSON.stringify(f.service.collection.sourceStates())).not.toContain("raw-secret");
      response = success({ seven_day: { utilization: 12 } });
      await f.service.pollClaudeDesktop(Date.now() + 1800_006);
      expect(f.service.quotaAccounts().find(item => item.account === account)!.windows.map(item => item.bucket)).toEqual(["seven_day"]);
    } finally { await f.close(); }
  });

  test("five-minute minimum survives manual refresh/restart and background errors do not open UI", async () => {
    let reads = 0, connectReads = 0;
    const read = async (connect: boolean) => { reads++; connectReads += Number(connect); return success(); };
    const f = fixture(read);
    try {
      await f.service.connectClaudeDesktop(f.path);
      const now = Date.now();
      await f.service.pollClaudeDesktop(now);
      await f.service.pollClaudeDesktop(now + 299_000);
      expect(reads).toBe(1);
      const restarted = new QuotaPieService(loadConfig(f.path), new QuotaDatabase(f.databasePath), { quota: null, workState: null }, { read });
      try {
        await restarted.pollClaudeDesktop(now + 10);
        expect(reads).toBe(1);
        await restarted.pollClaudeDesktop(now + 300_001);
        expect(reads).toBe(2);
        expect(connectReads).toBe(1);
      } finally { await restarted.close(); }
    } finally { await f.close(); }
  });

  test("retained desktop history cannot feed forecasts or alerts after empty data or a changed binding", async () => {
    let response: unknown = success({ five_hour: { utilization: 99, resets_at: "2030-01-01T00:00:00Z" } });
    const f = fixture(async () => response);
    try {
      f.config.alerts.enabled = true;
      const account = (await f.service.connectClaudeDesktop(f.path)).account.account;
      const before = f.service.analyses().filter(window => window.account === account);
      expect(planTriggers(before, [], f.config, 0).length).toBeGreaterThan(0);
      let deliveries = 0;
      (f.service as any).deliverDecision = async () => { deliveries++; return { complete: true }; };
      response = success({ limits: [] });
      await f.service.pollClaudeDesktop(Date.now() + 300_001);
      expect(f.service.analyses().filter(window => window.account === account)).toEqual([]);
      expect(await f.service.evaluateTriggers(Date.now(), before)).toEqual([]);
      expect(deliveries).toBe(0);
      expect(f.service.db.latest("claude", account, "five_hour")?.usedPercent).toBe(99);
      response = success(usage);
      await f.service.pollClaudeDesktop(Date.now() + 600_002);
      expect(f.service.analyses().find(window => window.account === account)?.usedPercent).toBe(23);
      f.config.accounts.claude.find(profile => profile.id === account)!.desktopBinding = otherIdentity;
      expect(f.service.analyses().filter(window => window.account === account)).toEqual([]);
      expect(f.service.quotaAccounts().find(item => item.account === account)!.windows).toEqual([]);
    } finally { await f.close(); }
  });

  test("desktop quota grants no Code OAuth, status line or execution authority", async () => {
    const f = fixture(async () => success());
    try {
      const connected = await f.service.connectClaudeDesktop(f.path), account = connected.account.account;
      f.config.accounts.claude = f.config.accounts.claude.filter(profile => profile.id === account);
      f.config.collection.claudeOAuthEnabled = true;
      let oauthRequests = 0;
      await f.service.pollClaudeOAuth(Date.now(), true, (async () => { oauthRequests++; throw new Error("must not run"); }) as unknown as typeof fetch);
      expect(oauthRequests).toBe(0);
      expect(f.service.collection.sourceStates().every(row => row.source === "claude-desktop")).toBe(true);
      const sample = { ...connected.account.windows[0]!, source: "claude-statusline", usedPercent: 99, metadata: { sessionHash: "fixture" } };
      expect(f.service.ingestClaudeSessions([sample])).toEqual([]);
      expect(f.service.quotaAccounts().find(item => item.account === account)!.windows[0]!.usedPercent).toBe(23);
      expect(resumeProfileKey(f.config, "claude", account)).toBeNull();
      expect(() => jobProfile(f.config, { provider: "claude", account })).toThrow("desktop-connection-read-only");
      expect(() => f.service.registerResumeTask({ provider: "claude", account, nativeId: identity.accountId })).toThrow("desktop-connection-read-only");
      await expect(inspectWorkTarget(f.config, { provider: "claude", account, nativeSessionId: identity.accountId })).rejects.toThrow("desktop-connection-read-only");
    } finally { await f.close(); }
  });

  test("a pending desktop event retries after a newer verified reading without changing outbox semantics", async () => {
    const f = fixture(async () => success());
    try {
      f.config.alerts.enabled = true;
      const account = (await f.service.connectClaudeDesktop(f.path)).account.account;
      f.service.db.insertEvent({ provider: "claude", account, bucket: "five_hour", kind: "scheduled_reset", severity: "info",
        occurredAtMs: Date.now(), confidence: "high", displayText: "Observed reset", details: { label: "Claude 5h" } });
      const pending = f.service.alerts.pendingEvents().find(event => event.account === account)!;
      expect(pending).toBeDefined();
      let attempts = 0;
      (f.service as any).deliverDecision = async () => ({ complete: ++attempts > 1 });
      expect(await f.service.evaluateTriggers()).toEqual([]);
      expect(attempts).toBe(1);
      expect(f.service.alerts.pendingEvents().some(event => event.id === pending.id)).toBe(true);
      await Bun.sleep(2);
      await f.service.pollClaudeDesktop(Date.now() + 300_001);
      expect(f.service.analyses().find(window => window.account === account)!.observedAtMs).toBeGreaterThan(pending.occurredAtMs);
      const delivered = await f.service.evaluateTriggers();
      expect(delivered.some(decision => decision.eventId === pending.id)).toBe(true);
      expect(attempts).toBe(2);
      expect(f.service.alerts.pendingEvents().some(event => event.id === pending.id)).toBe(false);
    } finally { await f.close(); }
  });

  test("protected API rejects foreign origins and identity overrides; connect remains single flight", async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; await Bun.sleep(20); return { ...success({ limits: [] }), plan: "free" }; });
    f.config.dashboard.port = 0;
    const server = startDashboard(f.service, f.config, { preferencesPath: f.path, compactionRoot: f.root,
      poolDatabasePath: join(f.root, "pool.db"), poolPolicyPath: join(f.root, "pool.json") });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const token = (await (await fetch(origin + "/api/quota")).json() as any).actionToken;
      const post = (body = "{}", extra = {}) => fetch(origin + "/api/claude/desktop/connect", {
        method: "POST", headers: { "x-quotapie-action-token": token, ...extra }, body });
      expect((await post("{}", { "x-quotapie-action-token": "wrong" })).status).toBe(403);
      expect((await post("{}", { origin: "https://example.invalid" })).status).toBe(403);
      expect((await post('{"accountId":"override"}')).status).toBe(400);
      expect(calls).toBe(0);
      const responses = await Promise.all([post(), post()]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect(calls).toBe(1);
      const payload = await responses[0]!.json() as any;
      expect(payload.connected).toBe(true);
      expect(payload.quotaAvailable).toBe(false);
      expect(payload.account.collection.errorCategory).toBe("no-windows");
      expect(payload.account.plan.kind).toBe("free");
      expect(typeof payload.account.plan.observedAtMs).toBe("number");
      const quota = await (await fetch(origin + "/api/quota")).json() as any;
      expect(quota.accounts.find((account: any) => account.account === payload.account.account).plan).toEqual(payload.account.plan);
      expect(f.config.accounts.claude).toHaveLength(2);
    } finally { server.stop(true); await f.close(); }
  });

  test("interactive connect survives Bun's default idle timeout while ordinary quota reads remain responsive", async () => {
    const f = fixture(async () => { await Bun.sleep(11_500); return success({ limits: [] }); });
    f.config.dashboard.port = 0;
    const server = startDashboard(f.service, f.config, { preferencesPath: f.path, compactionRoot: f.root,
      poolDatabasePath: join(f.root, "pool.db"), poolPolicyPath: join(f.root, "pool.json") });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const token = (await (await fetch(origin + "/api/quota")).json() as any).actionToken;
      const connecting = fetch(origin + "/api/claude/desktop/connect", { method: "POST", body: "{}",
        headers: { "x-quotapie-action-token": token }, signal: AbortSignal.timeout(18_000) });
      await Bun.sleep(100);
      const quota = await fetch(origin + "/api/quota", { signal: AbortSignal.timeout(2_000) });
      expect(quota.status).toBe(200);
      const result = await connecting;
      expect(result.status).toBe(200);
      expect((await result.json() as any).connected).toBe(true);
    } finally { server.stop(true); await f.close(); }
  }, 20_000);
});
