import { createHash } from "node:crypto";
import type { QuotaObservation } from "../types";

function usedPercent(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>).used_percentage;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function resetMs(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>).resets_at;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 10_000_000_000 ? Math.round(raw) : Math.round(raw * 1_000);
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function labelFor(key: string): string {
  const labels: Record<string, string> = {
    five_hour: "Claude 5h",
    seven_day: "Claude weekly",
    seven_day_sonnet: "Claude Sonnet weekly",
    seven_day_opus: "Claude Opus weekly",
    seven_day_routines: "Claude Routines weekly",
    seven_day_cowork: "Claude Cowork weekly",
  };
  return labels[key] ?? `Claude ${key.replaceAll("_", " ")}`;
}

function durationFor(key: string): number | null {
  if (key === "five_hour") return 5 * 3_600;
  if (key.startsWith("seven_day")) return 7 * 86_400;
  return null;
}

export function parseClaudeStatusLine(
  payload: unknown,
  observedAtMs = Date.now(),
  account = "default",
): QuotaObservation[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const rateLimits = root.rate_limits;
  if (!rateLimits || typeof rateLimits !== "object") return [];
  const sessionHash = createHash("sha256")
    .update(typeof root.session_id === "string" ? root.session_id : "unknown")
    .digest("hex")
    .slice(0, 16);
  const observations: QuotaObservation[] = [];
  for (const [key, value] of Object.entries(rateLimits as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    observations.push({
      provider: "claude",
      account,
      bucket: key,
      label: labelFor(key),
      windowSeconds: durationFor(key),
      usedPercent: usedPercent(value),
      resetsAtMs: resetMs(value),
      observedAtMs,
      source: "claude-statusline",
      quality: "authoritative",
      metadata: { sessionHash },
    });
  }
  return observations;
}
