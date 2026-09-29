import type { QuotaObservation } from "./quota-types.js";
import { durationFor, labelFor } from "./claude-statusline.js";

interface FlatLimit {
  utilization?: unknown;
  resets_at?: unknown;
}

interface ScopedLimit {
  kind?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { display_name?: unknown } | null } | null;
}

// Normalise at the adapter boundary: a percentage outside 0..100 is not
// something the domain should have to reason about later.
function percent(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, raw));
}

function resetMs(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

export function mapClaudeUsage(
  payload: unknown,
  account = "default",
  observedAtMs = Date.now(),
): QuotaObservation[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const buckets = new Map<string, { usedPercent: number; resetsAtMs: number | null }>();

  for (const [key, value] of Object.entries(root)) {
    if (!/^(five_hour|seven_day)/.test(key)) continue;
    if (!value || typeof value !== "object") continue;
    const flat = value as FlatLimit;
    const used = percent(flat.utilization);
    if (used == null) continue;
    buckets.set(key, { usedPercent: used, resetsAtMs: resetMs(flat.resets_at) });
  }

  // Newer responses carry weekly caps in a limits array instead of flat
  // fields. Buckets already filled from the flat form are left alone, which
  // keeps this stable while both shapes coexist.
  const limits = root.limits;
  if (Array.isArray(limits)) {
    for (const entry of limits as ScopedLimit[]) {
      if (!entry || typeof entry !== "object") continue;
      const scopedUsed = percent(entry.percent);
      if (scopedUsed == null) continue;
      let bucket: string | null = null;
      if (entry.kind === "session") bucket = "five_hour";
      else if (entry.kind === "weekly_all") bucket = "seven_day";
      else if (entry.kind === "weekly_scoped") {
        const name = entry.scope?.model?.display_name;
        if (typeof name === "string" && name.length > 0) {
          bucket = `seven_day_${name.toLowerCase().replaceAll(/\s+/g, "_")}`;
        }
      }
      if (!bucket || buckets.has(bucket)) continue;
      buckets.set(bucket, { usedPercent: scopedUsed, resetsAtMs: resetMs(entry.resets_at) });
    }
  }

  return [...buckets.entries()].map(([bucket, value]) => ({
    provider: "claude" as const,
    account,
    bucket,
    label: labelFor(bucket),
    windowSeconds: durationFor(bucket),
    usedPercent: value.usedPercent,
    resetsAtMs: value.resetsAtMs,
    observedAtMs,
    source: "claude-oauth",
    quality: "authoritative" as const,
  }));
}
