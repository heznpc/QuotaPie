import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { parseUsageQuery, usageResetBoundaries, UsageReportAPI } from "../src/usage-report-api";
import type { UsageReport } from "../src/usage-report";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DAY = 86_400_000;
const now = Date.parse("2026-10-19T09:00:00Z");
function config() {
  const c = structuredClone(DEFAULT_CONFIG);
  c.accounts.codex = [{ id: "main", label: "Main", enabled: true, codexHome: "/unused" }];
  c.accounts.claude = [];
  return c;
}
test("usage range validation bounds work and validates timezone/account before scanning", () => {
  const c = config();
  expect(parseUsageQuery(new URL("http://localhost/api/usage-report"), c, now).fromMs).toBe(now - 7 * DAY);
  for (const query of ["fromMs=NaN", "fromMs=0", `fromMs=${now}&toMs=${now-1}`,
    `fromMs=${now-91*DAY}&toMs=${now}`, "timeZone=Invalid/Zone", "provider=codex", "account=main",
    "provider=codex&account=other"]) {
    expect(() => parseUsageQuery(new URL(`http://localhost/api/usage-report?${query}`), c, now)).toThrow();
  }
  expect(parseUsageQuery(new URL("http://localhost/api/usage-report?provider=codex&account=main&timeZone=Asia%2FSeoul"), c, now))
    .toMatchObject({ provider: "codex", account: "main", timeZone: "Asia/Seoul" });
});

test("reset accounting uses confirmed boundary timestamps and keeps quota buckets separate", () => {
  const database = new QuotaDatabase(":memory:");
  try {
    const insert = database.db.query(`INSERT INTO events(provider,account,bucket,kind,severity,occurred_at_ms,confidence,summary,details_json,fingerprint)
      VALUES('codex',? ,? ,? ,'info',? ,'high','',?,hex(randomblob(16)))`);
    const boundary = now - DAY;
    insert.run("main", "weekly", "scheduled_reset", boundary + 1000, JSON.stringify({ previousResetsAtMs: boundary, label: "Weekly" }));
    insert.run("main", "five_hour", "scheduled_reset", boundary + 1000, JSON.stringify({ previousResetsAtMs: boundary, label: "5h" }));
    insert.run("main", "weekly", "schedule_rebased", now, JSON.stringify({ previousResetsAtMs: now }));
    insert.run("main", "weekly", "scheduled_reset", now, "{}");
    insert.run("other", "weekly", "scheduled_reset", boundary, JSON.stringify({ previousResetsAtMs: boundary }));
    const result = usageResetBoundaries(database.db, config(), now - 2 * DAY, now);
    expect(result).toHaveLength(2);
    expect(result.map(row => row.bucket).sort()).toEqual(["five_hour", "weekly"]);
    expect(result.every(row => row.atMs === boundary)).toBe(true);
    const relief = { usedPercentBefore: 83, usedPercentAfter: 0, previousQuality: "authoritative", nextQuality: "authoritative" };
    insert.run("main", "weekly", "external_relief", now - 1000, JSON.stringify(relief));
    insert.run("main", "weekly", "external_relief", now - 500, JSON.stringify({ ...relief, usedPercentAfter: 50 }));
    const recoveries = usageResetBoundaries(database.db, config(), now - 2 * DAY, now);
    expect(recoveries).toHaveLength(3);
    expect(recoveries.find(row => row.kind === "external_relief")?.atMs).toBe(now - 1000);
  } finally { database.close(); }
});

test("usage HTTP route requires local authentication and rejects invalid ranges without scanning", async () => {
  const c = config(); c.accounts.codex = []; c.dashboard.port = 0;
  const root = mkdtempSync(join(tmpdir(), "usage-http-"));
  const service = new QuotaPieService(c, new QuotaDatabase(":memory:"));
  const server = startDashboard(service, c, { compactionRoot: root });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const { actionToken } = await (await fetch(base + "/api/quota")).json() as { actionToken: string };
    const headers = { "x-quotapie-action-token": actionToken };
    expect((await fetch(base + "/api/usage-report")).status).toBe(403);
    expect((await fetch(base + "/api/usage-report", { headers: { ...headers, origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(base + "/api/usage-report", { method: "POST", headers })).status).toBe(405);
    expect((await fetch(base + "/api/usage-report?fromMs=-1", { headers })).status).toBe(400);
    expect((await fetch(base + "/api/quota")).status).toBe(200);
  } finally { server.stop(true); await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an expired range keeps polling while another range scan is in flight", async () => {
  const database = new QuotaDatabase(":memory:");
  const report = { coverage: { filesPending: 0 } } as UsageReport;
  let resolveScan: ((value: UsageReport) => void) | undefined;
  let delayed = false;
  const api = new UsageReportAPI(config(), database.db, undefined, { report: async () => {
    if (!delayed) return report;
    return new Promise<UsageReport>(resolve => { resolveScan = resolve; });
  } });
  const query = { fromMs: now - DAY, toMs: now, timeZone: "Asia/Seoul" };
  try {
    expect(api.read(query).state).toBe("loading");
    await Bun.sleep(0);
    expect(api.read(query).state).toBe("ready");
    delayed = true;
    expect(api.read({ ...query, fromMs: now - 2 * DAY }).state).toBe("loading");
    await Bun.sleep(0);
    expect(api.read(query, Date.now() + 31_000)).toEqual({ state: "loading", report });
    resolveScan!(report);
    await Bun.sleep(0);
  } finally { database.close(); }
});
