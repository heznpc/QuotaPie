import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { nextWakeDelayMs } from "../src/scheduler";
import { TimeQuotaService } from "../src/service";
import type { QuotaObservation, WindowAnalysis } from "../src/types";

function observation(at: number, used: number): QuotaObservation {
  return {
    provider: "codex",
    account: "default",
    bucket: "codex:primary:300",
    label: "Codex 5h",
    windowSeconds: 18_000,
    usedPercent: used,
    resetsAtMs: 10_000,
    observedAtMs: at,
    source: "test",
    quality: "authoritative",
  };
}

describe("state persistence and scheduler", () => {
  test("ignores an out-of-order response", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new TimeQuotaService(structuredClone(DEFAULT_CONFIG), db);
    service.ingest([observation(2_000, 20)]);
    const events = service.ingest([observation(1_000, 10)]);
    expect(events[0]?.kind).toBe("out_of_order");
    expect(db.history("codex", "default", "codex:primary:300")).toHaveLength(1);
    db.close();
  });

  test("is idempotent for the same provider snapshot", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new TimeQuotaService(structuredClone(DEFAULT_CONFIG), db);
    const value = observation(2_000, 20);
    service.ingest([value]);
    service.ingest([value]);
    expect(db.history("codex", "default", "codex:primary:300")).toHaveLength(1);
    db.close();
  });

  test("retires a Codex bucket only after two complete responses omit it", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new TimeQuotaService(structuredClone(DEFAULT_CONFIG), db);
    const primary = observation(1_000, 20);
    const promo = {
      ...observation(1_000, 5),
      bucket: "codex_promo:primary:300",
      label: "Codex promo 5h",
    };
    service.ingestCodexSnapshot([primary, promo]);
    service.ingestCodexSnapshot([{ ...primary, observedAtMs: 2_000 }]);
    expect(service.analyses(2_000).map((item) => item.bucket)).toContain(promo.bucket);
    const events = service.ingestCodexSnapshot([{ ...primary, observedAtMs: 3_000 }]);
    expect(events.map((event) => event.kind)).toContain("bucket_retired");
    expect(service.analyses(3_000).map((item) => item.bucket)).not.toContain(promo.bucket);
    service.ingestCodexSnapshot([
      { ...primary, observedAtMs: 2_500 },
      { ...promo, observedAtMs: 2_500 },
    ]);
    expect(service.analyses(3_000).map((item) => item.bucket)).not.toContain(promo.bucket);
    db.close();
  });

  test("does not retire buckets from delayed older complete Codex reads", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new TimeQuotaService(structuredClone(DEFAULT_CONFIG), db);
    const primary = observation(3_000, 20);
    const promo = { ...observation(3_000, 5), bucket: "promo", label: "Promo" };
    const oldPromo = { ...observation(2_000, 7), bucket: "old-promo", label: "Old promo" };
    service.ingestCodexSnapshot([primary, promo]);
    service.ingestCodexSnapshot([{ ...primary, observedAtMs: 2_000 }, oldPromo]);
    service.ingestCodexSnapshot([{ ...primary, observedAtMs: 2_000 }, oldPromo]);
    expect(service.analyses(3_000).map((item) => item.bucket)).toContain("promo");
    expect(service.analyses(3_000).map((item) => item.bucket)).not.toContain("old-promo");
    db.close();
  });

  test("merges concurrent Claude sessions without a fake usage regression", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new TimeQuotaService(structuredClone(DEFAULT_CONFIG), db);
    const claude = (sessionHash: string, at: number, used: number, reset = 10_000_000): QuotaObservation => ({
      provider: "claude",
      account: "default",
      bucket: "five_hour",
      label: "Claude 5h",
      windowSeconds: 18_000,
      usedPercent: used,
      resetsAtMs: reset,
      observedAtMs: at,
      source: "claude-statusline",
      quality: "authoritative",
      metadata: { sessionHash },
    });
    service.ingestClaudeSessions([claude("session-b-hash", 1_000, 30)]);
    service.ingestClaudeSessions([claude("session-a-hash", 2_000, 15)]);
    expect(db.latest("claude", "default", "five_hour")?.usedPercent).toBe(30);
    const missing = claude("missing-session", 2_600, 0, 10_000_000);
    missing.usedPercent = null;
    missing.resetsAtMs = null;
    service.ingestClaudeSessions([missing]);
    expect(db.latest("claude", "default", "five_hour")?.resetsAtMs).toBe(10_000_000);
    expect(db.latest("claude", "default", "five_hour")?.usedPercent).toBe(30);
    service.ingestClaudeSessions([claude("session-a-hash", 3_000, 0, 20_000_000)]);
    expect(db.latest("claude", "default", "five_hour")?.usedPercent).toBe(0);
    expect(db.latest("claude", "default", "five_hour")?.resetsAtMs).toBe(20_000_000);
    db.close();
  });

  test("uses the most recently changed Claude reset clock, including backward re-bases", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new TimeQuotaService(structuredClone(DEFAULT_CONFIG), db);
    const claude = (sessionHash: string, at: number, used: number, reset: number): QuotaObservation => ({
      provider: "claude",
      account: "default",
      bucket: "five_hour",
      label: "Claude 5h",
      windowSeconds: 18_000,
      usedPercent: used,
      resetsAtMs: reset,
      observedAtMs: at,
      source: "claude-statusline",
      quality: "authoritative",
      metadata: { sessionHash },
    });
    service.ingestClaudeSessions([claude("old-session", 1_000, 30, 12_000_000)]);
    service.ingestClaudeSessions([claude("new-session", 2_000, 20, 11_000_000)]);
    expect(db.latest("claude", "default", "five_hour")?.resetsAtMs).toBe(11_000_000);
    expect(db.latest("claude", "default", "five_hour")?.quality).toBe("derived");
    service.ingestClaudeSessions([claude("old-session", 3_000, 31, 12_000_000)]);
    expect(db.latest("claude", "default", "five_hour")?.resetsAtMs).toBe(11_000_000);
    db.close();
  });

  test("isolates equal Codex buckets and hides a disabled account without deleting it", () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    config.accounts.codex.push({ id: "work", label: "Work", codexHome: "/tmp/timequota-work", enabled: true });
    const service = new TimeQuotaService(config, db);
    service.ingestCodexSnapshot([
      observation(1_000, 20),
      { ...observation(1_000, 70), account: "work" },
    ]);
    expect(db.latest("codex", "default", "codex:primary:300")?.usedPercent).toBe(20);
    expect(db.latest("codex", "work", "codex:primary:300")?.usedPercent).toBe(70);
    expect(service.statuses(1_000).map((status) => status.account)).toEqual(["default", "work"]);
    config.accounts.codex[1]!.enabled = false;
    expect(service.statuses(1_000).map((status) => status.account)).toEqual(["default"]);
    expect(db.latest("codex", "work", "codex:primary:300")?.usedPercent).toBe(70);
    db.close();
  });

  test("keeps Claude session consensus isolated by account alias", () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    config.accounts.claude.push({
      id: "work",
      label: "Work",
      configDir: "/tmp/timequota-claude-work",
      enabled: true,
      keychainService: null,
    });
    const service = new TimeQuotaService(config, db);
    const make = (account: string, used: number): QuotaObservation => ({
      provider: "claude",
      account,
      bucket: "five_hour",
      label: "Claude 5h",
      windowSeconds: 18_000,
      usedPercent: used,
      resetsAtMs: 50_000,
      observedAtMs: 1_000,
      source: "claude-statusline",
      quality: "authoritative",
      metadata: { sessionHash: "same-local-session-hash" },
    });
    service.ingestClaudeSessions([make("default", 10), make("work", 80)]);
    expect(db.latest("claude", "default", "five_hour")?.usedPercent).toBe(10);
    expect(db.latest("claude", "work", "five_hour")?.usedPercent).toBe(80);
    db.close();
  });

  test("fails closed before polling Codex profiles that could share one keychain login", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    config.accounts.codex = [
      { id: "default", label: "Main", codexHome: "/tmp/timequota-no-file-main", enabled: true },
      { id: "work", label: "Work", codexHome: "/tmp/timequota-no-file-work", enabled: true },
    ];
    const service = new TimeQuotaService(config, db);
    await expect(service.pollCodex()).rejects.toThrow("all configured Codex accounts failed");
    expect(service.codexPollResults()).toHaveLength(2);
    expect(service.codexPollResults().every((result) => result.error?.includes("cli_auth_credentials_store") === true)).toBeTrue();
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
    await service.close();
  });

  test("repairs private storage permissions for existing paths", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "timequota-permissions-"));
    chmodSync(directory, 0o755);
    const path = resolve(directory, "timequota.sqlite3");
    const db = new QuotaDatabase(path);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${path}${suffix}`)) expect(statSync(`${path}${suffix}`).mode & 0o777).toBe(0o600);
    }
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("prunes analysis history while retaining the latest snapshot", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new TimeQuotaService(structuredClone(DEFAULT_CONFIG), db);
    const now = 40 * 86_400_000;
    service.ingest([observation(1_000, 10), observation(now - 1_000, 20)]);
    expect(db.history("codex", "default", "codex:primary:300")).toHaveLength(2);
    expect(db.maybePrune(now, 28, true)).toBeTrue();
    expect(db.history("codex", "default", "codex:primary:300")).toHaveLength(1);
    expect(db.latest("codex", "default", "codex:primary:300")?.usedPercent).toBe(20);
    db.close();
  });

  test("keeps a long-retired bucket inactive across retention and restart", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "timequota-retired-"));
    const path = resolve(directory, "timequota.sqlite3");
    const config = structuredClone(DEFAULT_CONFIG);
    const db = new QuotaDatabase(path);
    const service = new TimeQuotaService(config, db);
    const primary = observation(1_000, 20);
    const promo = { ...observation(1_000, 5), bucket: "promo", label: "Promo" };
    service.ingestCodexSnapshot([primary, promo]);
    service.ingestCodexSnapshot([{ ...primary, observedAtMs: 2_000 }]);
    service.ingestCodexSnapshot([{ ...primary, observedAtMs: 3_000 }]);
    db.maybePrune(200 * 86_400_000, 28, true);
    db.close();
    const reopened = new QuotaDatabase(path);
    expect(reopened.latestAll().map((item) => item.bucket)).not.toContain("promo");
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("marks pre-migration events as already handled", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "timequota-migration-"));
    const path = resolve(directory, "timequota.sqlite3");
    const legacy = new Database(path, { create: true });
    legacy.run(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        account TEXT NOT NULL,
        bucket TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        occurred_at_ms INTEGER NOT NULL,
        confidence TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      )
    `);
    legacy.run(`
      INSERT INTO events(
        fingerprint, provider, account, bucket, kind, severity,
        occurred_at_ms, confidence, summary, details_json
      ) VALUES ('legacy', 'codex', 'default', 'x', 'schedule_rebased', 'info', 1000, 'high', 'old', '{}')
    `);
    legacy.run(`
      CREATE TABLE event_delivery (
        event_id INTEGER PRIMARY KEY,
        claimed_at_ms INTEGER,
        delivered_at_ms INTEGER,
        disposition TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      )
    `);
    legacy.close();
    const migrated = new QuotaDatabase(path);
    expect(migrated.pendingAlertEvents()).toEqual([]);
    migrated.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("wakes at the provider reset before a long polling interval", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.pollSeconds = 300;
    const window = {
      resetsAtMs: 60_000,
      observedAtMs: 0,
    } as WindowAnalysis;
    expect(nextWakeDelayMs([window], config, 0)).toBe(61_000);
  });

  test("a changed reset time cancels the old schedule by recomputation", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.pollSeconds = 10_000;
    const oldWindow = { resetsAtMs: 300_000, observedAtMs: 0 } as WindowAnalysis;
    const newWindow = { resetsAtMs: 120_000, observedAtMs: 1_000 } as WindowAnalysis;
    expect(nextWakeDelayMs([newWindow], config, 1_000)).toBeLessThan(nextWakeDelayMs([oldWindow], config, 1_000));
  });
});

describe("account state contract", () => {
  test("enabled accounts with no collection history still appear as never-attempted", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new TimeQuotaService(structuredClone(DEFAULT_CONFIG), db);
    db.recordCollectionAttempt("codex", "default", "codex-appserver", 1_000, null, null);
    const states = service.accountStates(2_000);
    const claude = states.find((state) => state.provider === "claude");
    expect(claude).toBeDefined();
    expect(claude!.collection.health).toBe("never-attempted");
    expect(claude!.windows).toEqual([]);
    const codex = states.find((state) => state.provider === "codex");
    expect(codex!.collection.lastSuccessAtMs).toBe(1_000);
    expect(codex!.collection.activeSource).toBe("codex-appserver");
  });

  test("failed poll then success is recorded so health recovers", () => {
    const db = new QuotaDatabase(":memory:");
    db.recordCollectionAttempt("codex", "default", "codex-appserver", 1_000, "boom", "provider-error");
    let row = db.collectionSourceStates()[0]!;
    expect(row.lastSuccessMs).toBeNull();
    expect(row.lastError).toBe("boom");
    expect(row.lastErrorCategory).toBe("provider-error");
    db.recordCollectionAttempt("codex", "default", "codex-appserver", 2_000, null, null);
    row = db.collectionSourceStates()[0]!;
    expect(row.lastSuccessMs).toBe(2_000);
    expect(row.lastError).toBeNull();
  });

  test("an OAuth failure does not erase a recent status-line success", () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    const service = new TimeQuotaService(config, db);
    const nowMs = 10_000_000;
    db.recordCollectionAttempt("claude", "default", "claude-statusline", nowMs - 1_000, null, null);
    db.recordCollectionAttempt(
      "claude", "default", "claude-oauth", nowMs, "no Claude login found", "auth-required",
    );
    const claude = service.accountStates(nowMs).find((state) => state.provider === "claude")!;
    // 계정 건강도는 살아 있는 소스를 따르되, 실패한 소스의 원인은 그대로 노출한다.
    expect(claude.collection.health).toBe("recent-success");
    expect(claude.collection.activeSource).toBe("claude-statusline");
    expect(claude.collection.sources.map((item) => item.source).sort()).toEqual([
      "claude-oauth",
      "claude-statusline",
    ]);
    expect(claude.collection.sources.find((item) => item.source === "claude-oauth")!.errorCategory)
      .toBe("auth-required");
  });

  test("status-line samples are ignored while OAuth is authoritative", () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    const service = new TimeQuotaService(config, db);
    const nowMs = 20_000_000;
    db.recordCollectionAttempt("claude", "default", "claude-oauth", nowMs - 1_000, null, null);
    db.ingestObservation({
      provider: "claude",
      account: "default",
      bucket: "five_hour",
      label: "Claude 5h",
      windowSeconds: 18_000,
      usedPercent: 40,
      resetsAtMs: nowMs + 3_600_000,
      observedAtMs: nowMs - 1_000,
      source: "claude-oauth",
      quality: "authoritative",
    }, config);
    service.ingestClaudeSessions([{
      provider: "claude",
      account: "default",
      bucket: "five_hour",
      label: "Claude 5h",
      windowSeconds: 18_000,
      usedPercent: 12,
      resetsAtMs: nowMs + 3_600_000,
      observedAtMs: nowMs,
      source: "claude-statusline",
      quality: "authoritative",
      metadata: { sessionHash: "abc123" },
    }], nowMs);
    // 폴백 값이 권위 있는 값을 되돌리지 않는다.
    expect(db.latest("claude", "default", "five_hour")?.usedPercent).toBe(40);
    expect(db.latest("claude", "default", "five_hour")?.source).toBe("claude-oauth");
    // 폴백 소스가 살아 있다는 사실 자체는 기록된다.
    const statusLine = db.collectionSourceStates()
      .find((row) => row.source === "claude-statusline");
    expect(statusLine?.lastSuccessMs).toBe(nowMs);
  });

  test("status-line samples are accepted once OAuth has gone stale", () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    const service = new TimeQuotaService(config, db);
    const nowMs = 30_000_000;
    const staleMs = config.collection.staleAfterSeconds * 1_000 + 60_000;
    db.recordCollectionAttempt("claude", "default", "claude-oauth", nowMs - staleMs, null, null);
    service.ingestClaudeSessions([{
      provider: "claude",
      account: "default",
      bucket: "five_hour",
      label: "Claude 5h",
      windowSeconds: 18_000,
      usedPercent: 12,
      resetsAtMs: nowMs + 3_600_000,
      observedAtMs: nowMs,
      source: "claude-statusline",
      quality: "authoritative",
      metadata: { sessionHash: "abc123" },
    }], nowMs);
    expect(db.latest("claude", "default", "five_hour")?.usedPercent).toBe(12);
  });
});

describe("collection isolation between providers", () => {
  test("a failing Claude poll never throws and leaves Codex collection untouched", async () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    // 자격증명이 없는 임시 디렉터리를 가리켜 Claude 수집이 확실히 실패하게 만든다.
    config.accounts.claude = [{
      id: "default",
      label: "Main",
      configDir: mkdtempSync(join(tmpdir(), "tq-claude-fail-")),
      enabled: true,
      keychainService: "TimeQuota-nonexistent-service",
    }];
    const service = new TimeQuotaService(config, db);
    const nowMs = 40_000_000;
    db.recordCollectionAttempt("codex", "default", "codex-appserver", nowMs - 1_000, null, null);
    db.ingestObservation({
      provider: "codex",
      account: "default",
      bucket: "codex:primary:10080",
      label: "Codex weekly",
      windowSeconds: 604_800,
      usedPercent: 20,
      resetsAtMs: nowMs + 86_400_000,
      observedAtMs: nowMs - 1_000,
      source: "codex-appserver",
      quality: "authoritative",
    }, config);

    const events = await service.pollClaudeOAuth(nowMs, true);
    expect(events).toEqual([]);

    const states = service.accountStates(nowMs);
    const codex = states.find((state) => state.provider === "codex")!;
    expect(codex.collection.health).toBe("recent-success");
    expect(codex.windows).toHaveLength(1);
    const claude = states.find((state) => state.provider === "claude")!;
    expect(claude.collection.health).toBe("attempted-then-failed");
    expect(claude.collection.errorCategory).toBe("auth-required");
    // 실패 사유에 자격증명 값이 섞이지 않는다.
    expect(claude.collection.errorDetail ?? "").not.toContain("Bearer");
  });
});

describe("a provider outage stays contained", () => {
  test("a Claude usage endpoint outage is recorded without throwing or touching Codex", async () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    const dir = mkdtempSync(join(tmpdir(), "tq-claude-outage-"));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 3_600_000 },
    }));
    config.accounts.claude = [{ id: "default", label: "Main", configDir: dir, enabled: true, keychainService: null }];
    const service = new TimeQuotaService(config, db);
    const nowMs = 50_000_000;
    db.recordCollectionAttempt("codex", "default", "codex-appserver", nowMs - 1_000, null, null);
    const failing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

    const events = await service.pollClaudeOAuth(nowMs, true, failing);
    expect(events).toEqual([]);

    const states = service.accountStates(nowMs);
    expect(states.find((state) => state.provider === "codex")!.collection.health).toBe("recent-success");
    const claude = states.find((state) => state.provider === "claude")!;
    expect(claude.collection.health).toBe("attempted-then-failed");
    expect(claude.collection.errorCategory).toBe("provider-error");
    // 실패 기록에 토큰이 새지 않는다.
    expect(JSON.stringify(claude)).not.toContain("test-token");
  });
});
