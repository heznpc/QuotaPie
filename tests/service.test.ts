import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { planTriggers } from "../src/triggers";
import { ALERTABLE_EVENT_KINDS } from "../src/types";
import { QuotaDatabase } from "../src/db";
import { nextWakeDelayMs } from "../src/scheduler";
import { QuotaPieService } from "../src/service";
import type { QuotaObservation, WindowAnalysis } from "../src/types";
import { AlertStore } from "../src/storage/alert-store";
import { CollectionStore } from "../src/storage/collection-store";

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
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), db);
    service.ingest([observation(2_000, 20)]);
    const events = service.ingest([observation(1_000, 10)]);
    expect(events[0]?.kind).toBe("out_of_order");
    expect(db.history("codex", "default", "codex:primary:300")).toHaveLength(1);
    db.close();
  });

  test("is idempotent for the same provider snapshot", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), db);
    const value = observation(2_000, 20);
    service.ingest([value]);
    service.ingest([value]);
    expect(db.history("codex", "default", "codex:primary:300")).toHaveLength(1);
    db.close();
  });

  test("retires a Codex bucket only after two complete responses omit it", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), db);
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

  test("detects a Codex lane window change on the first switched response", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), db);
    const weekly: QuotaObservation = {
      ...observation(1_000, 100),
      bucket: "codex:primary:10080",
      label: "Codex weekly",
      windowSeconds: 604_800,
      metadata: { limitId: "codex", lane: "primary" },
    };
    const monthly: QuotaObservation = {
      ...weekly,
      bucket: "codex:primary:43200",
      label: "Codex monthly",
      windowSeconds: 2_592_000,
      observedAtMs: 2_000,
      usedPercent: 0,
    };
    service.ingestCodexSnapshot([weekly]);
    const events = service.ingestCodexSnapshot([monthly]);
    const changed = events.find((event) => event.kind === "window_changed");
    expect(changed?.occurredAtMs).toBe(2_000);
    expect(changed?.details).toMatchObject({
      previousBucket: weekly.bucket,
      nextBucket: monthly.bucket,
      previousWindowSeconds: weekly.windowSeconds,
      nextWindowSeconds: monthly.windowSeconds,
    });
    expect(service.analyses(2_000).map((item) => item.bucket)).toContain(weekly.bucket);
    db.close();
  });

  test("does not retire buckets from delayed older complete Codex reads", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), db);
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
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), db);
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
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), db);
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
    config.accounts.codex.push({ id: "work", label: "Work", codexHome: "/tmp/quotapie-work", enabled: true });
    const service = new QuotaPieService(config, db);
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
      configDir: "/tmp/quotapie-claude-work",
      enabled: true,
      keychainService: null,
    });
    const service = new QuotaPieService(config, db);
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
      { id: "default", label: "Main", codexHome: "/tmp/quotapie-no-file-main", enabled: true },
      { id: "work", label: "Work", codexHome: "/tmp/quotapie-no-file-work", enabled: true },
    ];
    const service = new QuotaPieService(config, db);
    await expect(service.pollCodex()).rejects.toThrow("all configured Codex accounts failed");
    expect(service.codexPollResults()).toHaveLength(2);
    expect(service.codexPollResults().every((result) => result.error?.includes("cli_auth_credentials_store") === true)).toBeTrue();
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
    await service.close();
  });

  test("repairs private storage permissions for existing paths", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "quotapie-permissions-"));
    chmodSync(directory, 0o755);
    const path = resolve(directory, "quotapie.sqlite3");
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
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), db);
    const now = 40 * 86_400_000;
    service.ingest([observation(1_000, 10), observation(now - 1_000, 20)]);
    expect(db.history("codex", "default", "codex:primary:300")).toHaveLength(2);
    expect(db.maybePrune(now, 28, true)).toBeTrue();
    expect(db.history("codex", "default", "codex:primary:300")).toHaveLength(1);
    expect(db.latest("codex", "default", "codex:primary:300")?.usedPercent).toBe(20);
    db.close();
  });

  test("keeps a long-retired bucket inactive across retention and restart", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "quotapie-retired-"));
    const path = resolve(directory, "quotapie.sqlite3");
    const config = structuredClone(DEFAULT_CONFIG);
    const db = new QuotaDatabase(path);
    const service = new QuotaPieService(config, db);
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
    const directory = mkdtempSync(resolve(tmpdir(), "quotapie-migration-"));
    const path = resolve(directory, "quotapie.sqlite3");
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
    expect(new AlertStore(migrated.storage).pendingEvents()).toEqual([]);
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
    const service = new QuotaPieService(structuredClone(DEFAULT_CONFIG), db);
    new CollectionStore(db.storage).recordAttempt("codex", "default", "codex-appserver", 1_000, null, null);
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
    new CollectionStore(db.storage).recordAttempt("codex", "default", "codex-appserver", 1_000, "boom", "provider-error");
    let row = new CollectionStore(db.storage).sourceStates()[0]!;
    expect(row.lastSuccessMs).toBeNull();
    expect(row.lastError).toBe("boom");
    expect(row.lastErrorCategory).toBe("provider-error");
    new CollectionStore(db.storage).recordAttempt("codex", "default", "codex-appserver", 2_000, null, null);
    row = new CollectionStore(db.storage).sourceStates()[0]!;
    expect(row.lastSuccessMs).toBe(2_000);
    expect(row.lastError).toBeNull();
  });

  test("an OAuth failure does not erase a recent status-line success", () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    const service = new QuotaPieService(config, db);
    const nowMs = 10_000_000;
    new CollectionStore(db.storage).recordAttempt("claude", "default", "claude-statusline", nowMs - 1_000, null, null);
    new CollectionStore(db.storage).recordAttempt(
      "claude", "default", "claude-oauth", nowMs, "no Claude login found", "auth-required",
    );
    const claude = service.accountStates(nowMs).find((state) => state.provider === "claude")!;
    // Account health follows the live source, while the failing source keeps
    // reporting its own cause.
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
    const service = new QuotaPieService(config, db);
    const nowMs = 20_000_000;
    new CollectionStore(db.storage).recordAttempt("claude", "default", "claude-oauth", nowMs - 1_000, null, null);
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
    // The fallback value does not roll back the authoritative one.
    expect(db.latest("claude", "default", "five_hour")?.usedPercent).toBe(40);
    expect(db.latest("claude", "default", "five_hour")?.source).toBe("claude-oauth");
    // That the fallback source is alive is still recorded.
    const statusLine = new CollectionStore(db.storage).sourceStates()
      .find((row) => row.source === "claude-statusline");
    expect(statusLine?.lastSuccessMs).toBe(nowMs);
  });

  test("status-line samples are accepted once OAuth has gone stale", () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    const service = new QuotaPieService(config, db);
    const nowMs = 30_000_000;
    const staleMs = config.collection.staleAfterSeconds * 1_000 + 60_000;
    new CollectionStore(db.storage).recordAttempt("claude", "default", "claude-oauth", nowMs - staleMs, null, null);
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
    // Seeing the OAuth failure path requires explicitly opening the opt-in gate.
    config.collection.claudeOAuthEnabled = true;
    // Point at a temp directory with no credentials so Claude collection
    // definitely fails.
    config.accounts.claude = [{
      id: "default",
      label: "Main",
      configDir: mkdtempSync(join(tmpdir(), "tq-claude-fail-")),
      enabled: true,
      keychainService: "QuotaPie-nonexistent-service",
    }];
    const service = new QuotaPieService(config, db);
    const nowMs = 40_000_000;
    new CollectionStore(db.storage).recordAttempt("codex", "default", "codex-appserver", nowMs - 1_000, null, null);
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
    // The failure reason carries no credential value.
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
    config.collection.claudeOAuthEnabled = true;
    config.accounts.claude = [{ id: "default", label: "Main", configDir: dir, enabled: true, keychainService: null }];
    const service = new QuotaPieService(config, db);
    const nowMs = 50_000_000;
    new CollectionStore(db.storage).recordAttempt("codex", "default", "codex-appserver", nowMs - 1_000, null, null);
    const failing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

    const events = await service.pollClaudeOAuth(nowMs, true, failing);
    expect(events).toEqual([]);

    const states = service.accountStates(nowMs);
    expect(states.find((state) => state.provider === "codex")!.collection.health).toBe("recent-success");
    const claude = states.find((state) => state.provider === "claude")!;
    expect(claude.collection.health).toBe("attempted-then-failed");
    expect(claude.collection.errorCategory).toBe("provider-error");
    // No token leaks into the failure record.
    expect(JSON.stringify(claude)).not.toContain("test-token");
  });
});

describe("Claude OAuth collection is opt-in", () => {
  function claudeConfig(oauthEnabled: boolean) {
    const config = structuredClone(DEFAULT_CONFIG);
    const dir = mkdtempSync(join(tmpdir(), "tq-optin-"));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 3_600_000 },
    }));
    config.collection.claudeOAuthEnabled = oauthEnabled;
    config.accounts.claude = [{ id: "default", label: "Main", configDir: dir, enabled: true, keychainService: null }];
    return config;
  }

  test("the default configuration does not read anyone's credentials", () => {
    expect(DEFAULT_CONFIG.collection.claudeOAuthEnabled).toBeFalse();
  });

  test("a disabled poller reads nothing even when doctor forces a run", async () => {
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(claudeConfig(false), db);
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const events = await service.pollClaudeOAuth(1_000, true, spy);

    expect(events).toEqual([]);
    expect(called).toBeFalse();
    expect(new CollectionStore(db.storage).sourceStates()).toEqual([]);
  });

  test("enabling it turns the same call into a real sample", async () => {
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(claudeConfig(true), db);
    const responding = (async () =>
      new Response(JSON.stringify({
        five_hour: { utilization: 10, resets_at: new Date(2_000_000).toISOString() },
      }), { status: 200 })) as unknown as typeof fetch;

    await service.pollClaudeOAuth(1_000, true, responding);

    expect(db.latest("claude", "default", "five_hour")?.usedPercent).toBe(10);
    expect(new CollectionStore(db.storage).sourceStates().map((row) => row.source)).toEqual(["claude-oauth"]);
  });

  test("opting out reads as unconfigured rather than broken", () => {
    const db = new QuotaDatabase(":memory:");
    const service = new QuotaPieService(claudeConfig(false), db);
    const claude = service.accountStates(1_000).find((state) => state.provider === "claude")!;
    expect(claude.collection.health).toBe("never-attempted");
    expect(claude.collection.errorCategory).toBe("not-configured");
  });

  test("the status line still collects while OAuth stays off", () => {
    const db = new QuotaDatabase(":memory:");
    const config = claudeConfig(false);
    const service = new QuotaPieService(config, db);
    service.ingestClaudeSessions([{
      provider: "claude",
      account: "default",
      bucket: "five_hour",
      label: "Claude 5h",
      windowSeconds: 18_000,
      usedPercent: 33,
      resetsAtMs: 9_000_000,
      observedAtMs: 1_000,
      source: "claude-statusline",
      quality: "authoritative",
      metadata: { sessionHash: "abc123" },
    }], 1_000);
    expect(db.latest("claude", "default", "five_hour")?.usedPercent).toBe(33);
    const claude = service.accountStates(1_000).find((state) => state.provider === "claude")!;
    expect(claude.collection.health).toBe("recent-success");
    expect(claude.collection.activeSource).toBe("claude-statusline");
  });
});

describe("collection success requires actual windows", () => {
  test("an empty Codex response is a failure, not a healthy poll with zero windows", async () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    const service = new QuotaPieService(config, db);
    // Reproduce an app-server that responds but hands back no windows.
    spyOn(service, "pollCodex" as never);
    (service as unknown as { codexClients: Map<string, unknown> }).codexClients.set("default", {
      readRateLimits: async () => [],
      close: async () => undefined,
      onUpdate: () => undefined,
    });
    await expect(service.pollCodex()).rejects.toThrow();
    const row = new CollectionStore(db.storage).sourceStates().find((item) => item.provider === "codex")!;
    expect(row.lastSuccessMs).toBeNull();
    expect(row.lastErrorCategory).toBe("no-windows");
    const codex = service.accountStates(Date.now()).find((state) => state.provider === "codex")!;
    expect(codex.collection.health).toBe("attempted-then-failed");
  });
});

describe("active source matches the source that wins ingestion", () => {
  test("with both sources fresh, OAuth is reported as the active one", () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    const service = new QuotaPieService(config, db);
    const nowMs = 60_000_000;
    // Even with a more recent status line, OAuth is what ingestion accepts,
    // and the display has to agree with it.
    new CollectionStore(db.storage).recordAttempt("claude", "default", "claude-oauth", nowMs - 5_000, null, null);
    new CollectionStore(db.storage).recordAttempt("claude", "default", "claude-statusline", nowMs - 1_000, null, null);
    const claude = service.accountStates(nowMs).find((state) => state.provider === "claude")!;
    expect(claude.collection.health).toBe("recent-success");
    expect(claude.collection.activeSource).toBe("claude-oauth");
  });

  test("when OAuth has gone stale the fallback becomes the active source", () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    const service = new QuotaPieService(config, db);
    const nowMs = 70_000_000;
    const staleMs = config.collection.staleAfterSeconds * 1_000 + 60_000;
    new CollectionStore(db.storage).recordAttempt("claude", "default", "claude-oauth", nowMs - staleMs, null, null);
    new CollectionStore(db.storage).recordAttempt("claude", "default", "claude-statusline", nowMs - 1_000, null, null);
    const claude = service.accountStates(nowMs).find((state) => state.provider === "claude")!;
    expect(claude.collection.activeSource).toBe("claude-statusline");
  });
});

describe("events reach the alert planner", () => {
  // The producer had a test, the consumer had a test, and nothing covered the
  // seam between them: window_changed was recorded and then silently dropped by
  // the delivery query. This walks the whole path instead.
  function codexWindow(bucket: string, durationMinutes: number, observedAtMs: number): QuotaObservation {
    return {
      provider: "codex",
      account: "default",
      bucket,
      label: `Codex ${durationMinutes}m`,
      windowSeconds: durationMinutes * 60,
      usedPercent: 20,
      resetsAtMs: observedAtMs + durationMinutes * 60_000,
      observedAtMs,
      source: "codex-app-server",
      quality: "authoritative",
      metadata: { limitId: "primary", lane: "primary" },
    };
  }

  test("a Codex lane switch survives from ingestion all the way to a trigger decision", () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    const service = new QuotaPieService(config, db);
    const start = 100_000_000;

    service.ingestCodexSnapshot([codexWindow("primary:primary:10080", 10_080, start)]);
    const produced = service.ingestCodexSnapshot([
      codexWindow("primary:primary:43200", 43_200, start + 60_000),
    ]);
    expect(produced.some((event) => event.kind === "window_changed")).toBeTrue();

    // The delivery query has to hand the same event to the planner.
    const pending = new AlertStore(db.storage).pendingEvents();
    const pendingChange = pending.find((event) => event.kind === "window_changed");
    expect(pendingChange).toBeDefined();

    const decisions = planTriggers([], pending, config, 0, start + 120_000);
    const decision = decisions.find((item) => item.key.includes("window_changed"));
    expect(decision).toBeDefined();
    expect(decision!.eventId).toBe(pendingChange!.id!);
  });

  test("every kind the planner acts on is a kind the delivery query returns", () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    const occurredAtMs = 200_000_000;
    for (const kind of ALERTABLE_EVENT_KINDS) {
      db.insertEvent({
        provider: "codex",
        account: "default",
        bucket: `bucket-${kind}`,
        kind,
        severity: "info",
        occurredAtMs,
        confidence: "high",
        displayText: `${kind} occurred`,
        details: {},
      });
    }
    const pending = new AlertStore(db.storage).pendingEvents();
    expect(pending.map((event) => event.kind).sort()).toEqual([...ALERTABLE_EVENT_KINDS].sort());
    const decisions = planTriggers([], pending, config, 0, occurredAtMs + 1_000);
    expect(decisions).toHaveLength(ALERTABLE_EVENT_KINDS.length);
  });
});

describe("a failing provider does not starve the process", () => {
  test("one analysis pass per tick feeds triggers, the boundary, and the schedule", async () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    const service = new QuotaPieService(config, db);
    const spy = spyOn(service, "analyses");
    await service.tick(1_000);
    // Recomputing it for the schedule, the triggers, and the boundary is what
    // multiplied a full history scan by three on every pass.
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();
    service.close();
  });

  test("a tick that reached no provider reports it, so the caller can back off", async () => {
    const db = new QuotaDatabase(":memory:");
    const config = structuredClone(DEFAULT_CONFIG);
    config.collection.codexEnabled = false;
    config.alerts.enabled = false;
    const service = new QuotaPieService(config, db);
    expect((await service.tick(1_000)).collected).toBeFalse();

    // A recent success from any source is what makes a tick count.
    service.collection.recordAttempt("claude", "default", "claude-oauth", 1_000, null, null);
    expect((await service.tick(1_000)).collected).toBeTrue();

    // An old success does not keep the loop at full speed forever.
    const staleMs = config.collection.staleAfterSeconds * 1_000 + 1_000;
    expect((await service.tick(1_000 + staleMs)).collected).toBeFalse();
    service.close();
  });

  test("the backoff grows and is bounded", () => {
    const steps = QuotaPieService.FAILURE_BACKOFF_MS;
    expect(steps[0]).toBeGreaterThanOrEqual(5_000);
    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index]!).toBeGreaterThan(steps[index - 1]!);
    }
    expect(steps[steps.length - 1]).toBeLessThanOrEqual(600_000);
  });
});
