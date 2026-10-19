import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config";
import { UsageReportIndex, type UsageReport, type UsageResetBoundary } from "./usage-report";

const DAY = 86_400_000;
export interface UsageQuery { fromMs: number; toMs: number; timeZone: string; provider?: "codex" | "claude"; account?: string }
export function parseUsageQuery(url: URL, config: AppConfig, nowMs = Date.now()): UsageQuery {
  const fromMs = url.searchParams.has("fromMs") ? Number(url.searchParams.get("fromMs")) : nowMs - 7 * DAY;
  const toMs = url.searchParams.has("toMs") ? Number(url.searchParams.get("toMs")) : nowMs;
  const timeZone = url.searchParams.get("timeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs <= 0 || toMs <= fromMs
      || toMs > nowMs + DAY || toMs - fromMs > 90 * DAY || timeZone.length > 100) throw new Error("invalid_usage_range");
  try { new Intl.DateTimeFormat("en", { timeZone }).format(0); } catch { throw new Error("invalid_usage_timezone"); }
  const provider = url.searchParams.get("provider"), account = url.searchParams.get("account");
  if (provider !== null || account !== null) {
    if ((provider !== "codex" && provider !== "claude") || !account
        || !config.accounts[provider].some(profile => profile.enabled && profile.id === account)) throw new Error("invalid_usage_account");
    return { fromMs, toMs, timeZone, provider, account };
  }
  return { fromMs, toMs, timeZone };
}

/** Use the confirmed prior reset timestamp, not the later polling timestamp.
 * Different quota buckets remain separate, overlapping accounting views. */
export function usageResetBoundaries(db: Database, config: AppConfig, fromMs: number, toMs: number): UsageResetBoundary[] {
  const rows = db.query<{provider: string; account: string; bucket: string; kind: "scheduled_reset" | "external_relief"; confidence: string; occurred_at_ms: number; details_json: string}, [number, number]>(
    `SELECT provider, account, bucket, kind, confidence, occurred_at_ms, details_json FROM events
     WHERE kind IN ('scheduled_reset','external_relief') AND occurred_at_ms >= ? AND occurred_at_ms <= ? ORDER BY occurred_at_ms DESC LIMIT 5000`
  ).all(Math.max(0, fromMs - 90 * DAY), toMs + DAY);
  const result: UsageResetBoundary[] = [];
  for (const row of rows) {
    if ((row.provider !== "codex" && row.provider !== "claude")
        || !config.accounts[row.provider].some(profile => profile.enabled && profile.id === row.account)) continue;
    try {
      const details = JSON.parse(row.details_json);
      // Early full recovery is a distinct observed boundary. A small correction
      // or an advertised future reset is not a reset that actually happened.
      if (row.kind === "external_relief" && !(row.confidence === "high" && details.usedPercentBefore > 0
          && details.usedPercentAfter === 0 && details.previousQuality === "authoritative"
          && details.nextQuality === "authoritative")) continue;
      const atMs = row.kind === "scheduled_reset" ? details.previousResetsAtMs : row.occurred_at_ms;
      if (!Number.isSafeInteger(atMs) || atMs <= 0 || atMs > toMs || atMs > row.occurred_at_ms + 10 * 60_000) continue;
      result.push({ atMs, provider: row.provider, account: row.account, bucket: row.bucket, kind: row.kind,
        label: typeof details.label === "string" ? details.label.slice(0, 100) : row.bucket });
    } catch { /* Invalid historical evidence cannot define a reset period. */ }
  }
  return result;
}

export interface UsageReportState { state: "loading" | "ready" | "error"; report: UsageReport | null; error?: string }
interface CacheEntry { state: UsageReportState; checkedAt: number }
/** A scan starts only when this screen is requested. One scan at a time across
 * all ranges, bounded cache, no work added to the quota/status refresh path. */
export class UsageReportAPI {
  private cache = new Map<string, CacheEntry>();
  private pending = false;
  constructor(private config: AppConfig, private db: Database, private relayRoot?: string,
    private index: Pick<UsageReportIndex, "report"> = new UsageReportIndex()) {}
  read(query: UsageQuery, nowMs = Date.now(), refresh = false): UsageReportState {
    const key = JSON.stringify([query, this.config.accounts]);
    let entry = this.cache.get(key);
    if (entry && nowMs - entry.checkedAt < (entry.state.report?.coverage.filesPending ? 1_000 : refresh ? 2_000 : 30_000)) return entry.state;
    if (this.pending) return { state: "loading", report: entry?.state.report ?? null };
    if (!entry) {
      while (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value!);
      entry = { state: { state: "loading", report: null }, checkedAt: 0 };
      this.cache.set(key, entry);
    }
    const target = entry;
    target.state = { state: "loading", report: target.state.report };
    this.pending = true;
    Promise.resolve().then(() => this.index.report(this.config, { ...query,
      relayRoot: this.relayRoot,
      resetBoundaries: usageResetBoundaries(this.db, this.config, query.fromMs, query.toMs),
    })).then(report => { target.state = { state: "ready", report }; }, () => {
      target.state = { state: "error", report: target.state.report, error: "usage_scan_failed" };
    }).finally(() => { target.checkedAt = Date.now(); this.pending = false; });
    return target.state;
  }
}
