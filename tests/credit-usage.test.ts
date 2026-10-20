import { expect, test } from "bun:test";
import { projectCreditUsage, CreditUsageReader } from "../src/credit-usage";
import { QuotaDatabase } from "../src/db";
import type { AccountState, QuotaObservation } from "../src/types";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = 10_000_000, minute = 60_000;
function account(): AccountState {
  return { provider: "codex", account: "main", accountLabel: "Main", enabled: true,
    collection: { health: "recent-success", activeSource: "codex-app-server", lastSuccessAtMs: now,
      errorCategory: null, errorDetail: null, sources: [] },
    windows: [{ bucket: "codex:primary:10080", freshness: "fresh", remainingPercent: 0 } as AccountState["windows"][number]],
    bottleneckBucket: "codex:primary:10080", updatedAtMs: now };
}
function point(minutesAgo: number, creditBalance: number | null, metadata = {}): QuotaObservation {
  return { provider: "codex", account: "main", bucket: "codex:primary:10080", label: "Weekly", windowSeconds: 604800,
    usedPercent: 100, resetsAtMs: now + 86400000, observedAtMs: now - minutesAgo * minute,
    source: "codex-app-server", quality: "authoritative", creditBalance,
    metadata: { limitId: "codex", lane: "primary", collectorEpoch: "epoch-1", accountContext: "identity-1", contextSession: "session-1", ...metadata } };
}
const project = (points: QuotaObservation[], current = account()) => projectCreditUsage(current, points, now, 10 * minute, 3 * minute);

test("hourly credits preserve ledger units and separate increases from observed decreases", () => {
  const points = Array.from({ length: 31 }, (_, i) => point(60 - i * 2, 62500 - i * 10));
  points[15]!.creditBalance! += 1000;
  const result = project(points);
  expect(result).toMatchObject({ unit: "credits", balance: 62200, freshness: "fresh", subscriptionExhausted: true,
    spendingObserved: true, attribution: "account-balance-only", billingVerified: false,
    lastHour: { observedDecrease: 1290, observedIncrease: 990, coveredMs: 60 * minute, coverage: "complete" } });
});

test("duplicate and overlapping quota windows never double count account balances", () => {
  const points = [point(2, 150.5), point(0, 130.25)];
  const overlapping = points.map(row => ({ ...row, bucket: "special:primary:300", creditBalance: 9999,
    metadata: { ...row.metadata, limitId: "special" } }));
  expect(project([...points, ...points, ...overlapping]).lastHour).toMatchObject({ observedDecrease: 20.25, sampleCount: 2 });
  expect(project([point(1, 0), point(0, 0)])).toMatchObject({ balance: 0, spendingObserved: false, lastHour: { observedDecrease: 0 } });
});

test("missing observations and long gaps do not become attributable spending", () => {
  const result = project([point(30, 500), point(28, 490), point(5, 100), point(3, null), point(2, 90), point(0, 87)]);
  expect(result.lastHour).toMatchObject({ observedDecrease: 13, gapCount: 3, coveredMs: 4 * minute, coverage: "partial" });
  expect(project([point(3, 100), point(0, null)])).toMatchObject({ balance: null, freshness: "unknown", spendingObserved: false,
    lastHour: { observedDecrease: null, coverage: "unknown" } });
});

test("only the latest verified login context contributes, and anonymous identity remains unknown", () => {
  for (const metadata of [{ collectorEpoch: "restarted" }, { accountContext: "new-login" }, { contextSession: "new-session" }]) {
    expect(project([point(4, 1000), point(3, 900), point(2, 600, metadata), point(0, 595, metadata)]).lastHour)
      .toMatchObject({ observedDecrease: 5, identityBreakCount: 1, coverage: "partial" });
  }
  expect(project([point(1, 100, { accountContext: null }), point(0, 50, { accountContext: null })]).lastHour.observedDecrease).toBeNull();
  const mismatch = account(); mismatch.collection.errorCategory = "account-mismatch";
  expect(project([point(1, 100), point(0, 50)], mismatch)).toMatchObject({ balance: null, freshness: "unknown",
    spendingObserved: false, lastHour: { observedDecrease: null, coverage: "unknown" } });
});

test("stale balance and collection failures cannot advertise current spending", () => {
  expect(project([point(20, 100), point(18, 50)])).toMatchObject({ balance: 50, freshness: "stale", spendingObserved: false });
  const failed = account(); failed.collection.health = "attempted-then-failed";
  expect(project([point(1, 100), point(0, 50)], failed)).toMatchObject({ freshness: "stale", spendingObserved: false });
  const quota = account(); quota.windows[0]!.remainingPercent = 20;
  expect(project([point(1, 100), point(0, 50)], quota).spendingObserved).toBe(false);
});

test("bounded database reads isolate accounts, keep missing samples and cache repeated polls", () => {
  const db = new QuotaDatabase(":memory:");
  try {
    for (const row of [point(61, 1000), point(2, 100), point(1, null), point(0, 90),
      { ...point(0, 700), account: "other" }]) db.insertSnapshot(row);
    const history = db.creditHistory("main", now - 60 * minute);
    expect(history.map(row => row.creditBalance)).toEqual([100, null, 90]);
    const before = db.db.query("SELECT COUNT(*) AS count FROM snapshots").get();
    const reader = new CreditUsageReader(db);
    const first = reader.accounts([account()], now, 10 * minute, 3 * minute)[0]!;
    expect("credits" in first && first.credits).toMatchObject({ balance: 90, lastHour: { observedDecrease: null } });
    expect(reader.accounts([account()], now + 1000, 10 * minute, 3 * minute)[0]).toMatchObject({ credits: { balance: 90 } });
    expect(db.db.query("SELECT COUNT(*) AS count FROM snapshots").get()).toEqual(before);
  } finally { db.close(); }
});

test("a new collection revision invalidates the five-second cache before attaching another login's balance", () => {
  const db = new QuotaDatabase(":memory:");
  const current = account(), reader = new CreditUsageReader(db);
  current.windows = [{ ...current.windows[0]!, ...point(0, 100), remainingPercent: 0, freshness: "fresh" }];
  try {
    db.insertSnapshot(point(1, 120)); db.insertSnapshot(point(0, 100));
    expect(reader.accounts([current], now, 10 * minute, 3 * minute)[0]).toMatchObject({ credits: { balance: 100, lastHour: { observedDecrease: 20 } } });
    const next = { ...point(0, 700, { accountContext: "identity-2" }), observedAtMs: now + 1000 };
    db.insertSnapshot(next);
    current.updatedAtMs = current.collection.lastSuccessAtMs = next.observedAtMs;
    current.windows = [{ ...current.windows[0]!, ...next }];
    expect(reader.accounts([current], now + 2000, 10 * minute, 3 * minute)[0]).toMatchObject({ credits: { balance: 700,
      lastHour: { observedDecrease: null, observedIncrease: null, identityBreakCount: 1 } } });
  } finally { db.close(); }
});

test("same-timestamp identity changes invalidate cached readings and a context mismatch stays unknown", () => {
  const db = new QuotaDatabase(":memory:");
  const current = account(), reader = new CreditUsageReader(db);
  current.windows = [{ ...current.windows[0]!, ...point(0, 100), remainingPercent: 0, freshness: "fresh" }];
  try {
    db.insertSnapshot(point(1, 120)); db.insertSnapshot(point(0, 100));
    expect(reader.accounts([current], now, 10 * minute, 3 * minute)[0]).toMatchObject({ credits: { balance: 100 } });
    const next = point(0, 700, { accountContext: "identity-2" });
    current.windows = [{ ...current.windows[0]!, ...next }];
    // The active state has changed before its replacement is visible in storage.
    expect(reader.accounts([current], now + 1000, 10 * minute, 3 * minute)[0]).toMatchObject({ credits: { balance: null,
      freshness: "unknown", lastHour: { observedDecrease: null, observedIncrease: null } } });
    // Synthetic same-time replacement models a provider revision without relying
    // on a new observedAtMs/lastSuccessAtMs value to invalidate the cache.
    db.db.query("UPDATE snapshots SET credit_balance=?,metadata_json=? WHERE account='main' AND observed_at_ms=?")
      .run(700, JSON.stringify(next.metadata), now);
    current.windows[0]!.metadata = { ...next.metadata, collectorEpoch: "epoch-2" };
    db.db.query("UPDATE snapshots SET metadata_json=? WHERE account='main' AND observed_at_ms=?")
      .run(JSON.stringify(current.windows[0]!.metadata), now);
    expect(reader.accounts([current], now + 2000, 10 * minute, 3 * minute)[0]).toMatchObject({ credits: { balance: 700,
      lastHour: { observedDecrease: null, observedIncrease: null, identityBreakCount: 1 } } });
  } finally { db.close(); }
});

test("quota HTTP polling exposes credit and routing contracts without invoking provider usage reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "quotapie-credit-http-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.dashboard.port = 0; config.accounts.codex = [{ id: "main", label: "Main", enabled: true, codexHome: join(root, "profile") }];
  config.accounts.claude = []; config.collection.codexEnabled = false; config.alerts.enabled = false; config.resetSignals.enabled = false;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const timestamp = Date.now();
  service.db.insertSnapshot({ ...point(1, 100), observedAtMs: timestamp - minute, resetsAtMs: timestamp + minute });
  service.db.insertSnapshot({ ...point(0, 80), observedAtMs: timestamp, resetsAtMs: timestamp + minute });
  service.collection.recordAttempt("codex", "main", "codex-app-server", timestamp, null, null);
  const server = startDashboard(service, config, { compactionRoot: root });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/quota`);
    const payload = await response.json() as any;
    expect(response.status).toBe(200);
    expect(payload.accounts[0].credits).toMatchObject({ unit: "credits", balance: 80,
      lastHour: { observedDecrease: 20, observedIncrease: 0 }, billingVerified: false });
    expect(payload.routing).toMatchObject({ active: [], recent: [], freshness: "unknown" });
    expect(JSON.stringify(payload.accounts[0].credits)).not.toContain("identity-1");
  } finally { server.stop(true); await service.close(); rmSync(root, { recursive: true, force: true }); }
});
