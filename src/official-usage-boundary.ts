import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config";
import type { OfficialUsageQuery } from "./official-usage";
import { usageResetBoundaries } from "./usage-report-api";

export function officialUsageBoundary(db: Database, config: AppConfig, account: string, query: OfficialUsageQuery, now: number) {
  if (!query.analysisDate) return null;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: query.analysisTimeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  const matches = usageResetBoundaries(db, config, Date.parse(query.analysisDate), now).filter(b =>
    b.provider === "codex" && b.account === account && (b.bucket.endsWith(":10080") || b.bucket === "weekly")
    && day.format(b.atMs) === query.analysisDate);
  // A second weekly observation on the same date is ambiguous. Never guess.
  if (matches.length !== 1) return null;
  return { atMs: matches[0]!.atMs, kind: matches[0]!.kind ?? "scheduled_reset" };
}
