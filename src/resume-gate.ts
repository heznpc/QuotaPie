import type { AccountState, Provider, WindowAnalysis } from "./types";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { codexProfileRoot, resolveUserPath, type AppConfig } from "./config";

export function resumeProfileKey(config: AppConfig, provider: Provider, accountId: string): string | null {
  const profile = (provider === "codex" ? config.accounts.codex : config.accounts.claude)
    .find(p => p.id === accountId && p.enabled);
  if (!profile || ("desktopBinding" in profile && profile.desktopBinding)) return null;
  try {
    const root = realpathSync("codexHome" in profile ? codexProfileRoot(profile) : resolveUserPath(profile.configDir));
    return createHash("sha256").update(root).digest("hex");
  } catch { return null; }
}

export interface ResumeGate {
  schemaVersion: 1;
  provider: Provider;
  account: string;
  profileKey: string | null;
  accountKey?: string | null;
  ready: boolean;
  reason: "ready" | "account-unavailable" | "collection-unavailable" | "quota-unknown" | "quota-stale" | "reset-unconfirmed" | "reserve-reached";
  checkedAtMs: number;
  retryAtMs: number | null;
  validUntilMs?: number;
  resetOpportunities?: import("./signals/opportunities").ResetOpportunity[];
  windows: Array<{ bucket: string; remainingPercent: number | null; reservePercent: number; observedAtMs: number; resetsAtMs: number | null }>;
}

/** A host remains the owner of its conversation. This gate grants no execution
 * lease and never starts a CLI or substitutes a different account. */
export function evaluateResumeGate(
  account: AccountState | undefined,
  provider: Provider,
  accountId: string,
  nowMs: number,
  maxAgeMs = 120_000,
  requiredBucket?: string,
): ResumeGate {
  const result: ResumeGate = { schemaVersion: 1, provider, account: accountId,
    profileKey: null, ready: false, reason: "account-unavailable", checkedAtMs: nowMs, retryAtMs: null, windows: [] };
  if (!account?.enabled || account.provider !== provider || account.account !== accountId) return result;
  const quota = evaluateResumeWindows(account.windows, provider, accountId, nowMs, maxAgeMs, requiredBucket);
  if (account.collection.health !== "recent-success" || account.collection.errorCategory != null) {
    return { ...quota, ready: false, reason: "collection-unavailable", retryAtMs: null };
  }
  return quota;
}

/** Shared by approved legacy resumes and unattended host continuations. The
 * caller supplies its execution reserves; forecast reserves do not grant or
 * remove permission to run. Collection and account identity are checked by the host. */
export function evaluateResumeWindows(
  windows: WindowAnalysis[], provider: Provider, accountId: string, nowMs: number,
  maxAgeMs: number, requiredBucket?: string,
): ResumeGate {
  const result: ResumeGate = { schemaVersion: 1, provider, account: accountId,
    profileKey: null, ready: false, reason: "quota-unknown", checkedAtMs: nowMs, retryAtMs: null, windows: [] };
  const general = windows.filter(w => provider === "codex" ? w.bucket.startsWith("codex:")
    : w.bucket === "five_hour" || w.bucket === "seven_day");
  const scoped = windows.filter(w => general.includes(w) || w.bucket === requiredBucket);
  result.windows = scoped.map(w => ({ bucket: w.bucket, remainingPercent: w.remainingPercent,
    reservePercent: w.reservePercent, observedAtMs: w.observedAtMs, resetsAtMs: w.resetsAtMs }));
  if (!general.length || (requiredBucket != null && !scoped.some(w => w.bucket === requiredBucket)) ||
    scoped.some(w => w.provider !== provider || w.account !== accountId ||
    w.quality !== "authoritative" || w.freshness === "unknown" ||
    w.remainingPercent == null || !Number.isFinite(w.remainingPercent) ||
    w.remainingPercent < 0 || w.remainingPercent > 100 || !Number.isFinite(w.reservePercent) ||
    w.reservePercent < 0 || w.reservePercent > 100 || w.resetsAtMs == null || !Number.isFinite(w.resetsAtMs))) {
    result.reason = "quota-unknown"; return result;
  }
  if (scoped.some(w => w.resetsAtMs! <= nowMs || w.freshness === "reset_due")) {
    result.reason = "reset-unconfirmed"; return result;
  }
  if (scoped.some(w => w.freshness !== "fresh" || !Number.isFinite(w.observedAtMs) ||
    w.observedAtMs > nowMs || nowMs - w.observedAtMs > maxAgeMs)) {
    result.reason = "quota-stale"; return result;
  }
  const blocked = scoped.filter(w => w.remainingPercent! <= w.reservePercent);
  if (blocked.length) {
    result.reason = "reserve-reached";
    result.retryAtMs = Math.min(...blocked.map(w => w.resetsAtMs!));
    return result;
  }
  result.ready = true; result.reason = "ready";
  return result;
}
