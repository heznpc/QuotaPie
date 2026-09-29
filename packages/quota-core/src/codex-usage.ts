import type { QuotaObservation } from "./quota-types.js";

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeCodexPlanType(value: unknown): string | null {
  return typeof value === "string" && ["free", "go", "plus", "pro", "prolite", "team", "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "edu"].includes(value)
    ? value : null;
}

function epochToMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.round(value) : Math.round(value * 1_000);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function labelFor(limitName: string | null, durationMinutes: number | null, lane: string): string {
  const base = limitName && limitName !== "codex" ? limitName : "Codex";
  if (durationMinutes === 300) return `${base} 5h`;
  if (durationMinutes === 10_080) return `${base} weekly`;
  if (durationMinutes === 43_200) return `${base} monthly`;
  if (durationMinutes != null) return `${base} ${durationMinutes}m`;
  return `${base} ${lane}`;
}

export function parseCodexRateLimits(
  payload: unknown,
  observedAtMs = Date.now(),
  account = "default",
): QuotaObservation[] {
  if (!payload || typeof payload !== "object") return [];
  const result = payload as Record<string, unknown>;
  const multi = result.rateLimitsByLimitId;
  const entries: Array<[string, Record<string, unknown>]> = [];

  if (multi && typeof multi === "object") {
    for (const [key, value] of Object.entries(multi as Record<string, unknown>)) {
      if (value && typeof value === "object") entries.push([key, value as Record<string, unknown>]);
    }
  } else if (result.rateLimits && typeof result.rateLimits === "object") {
    const single = result.rateLimits as Record<string, unknown>;
    entries.push([String(single.limitId ?? "codex"), single]);
  }

  const resetCreditBlock = result.rateLimitResetCredits;
  const resetCreditsAvailable = resetCreditBlock && typeof resetCreditBlock === "object"
    ? numberOrNull((resetCreditBlock as Record<string, unknown>).availableCount)
    : null;
  const topLevelCreditBlock = result.credits;
  const topLevelCreditBalance = topLevelCreditBlock && typeof topLevelCreditBlock === "object"
    ? numberOrNull(
        (topLevelCreditBlock as Record<string, unknown>).balance ??
          (topLevelCreditBlock as Record<string, unknown>).remaining,
      )
    : null;

  const observations: QuotaObservation[] = [];
  for (const [fallbackLimitId, value] of entries) {
    const entryStart = observations.length;
    const limitId = String(value.limitId ?? fallbackLimitId);
    const limitName = typeof value.limitName === "string" ? value.limitName : null;
    for (const lane of ["primary", "secondary"] as const) {
      const rawWindow = value[lane];
      if (!rawWindow || typeof rawWindow !== "object") continue;
      const window = rawWindow as Record<string, unknown>;
      const durationMinutes = numberOrNull(window.windowDurationMins);
      const usedPercent = numberOrNull(window.usedPercent);
      const resetsAtMs = epochToMs(window.resetsAt);
      observations.push({
        provider: "codex",
        account,
        bucket: `${limitId}:${lane}:${durationMinutes ?? "unknown"}`,
        label: labelFor(limitName, durationMinutes, lane),
        windowSeconds: durationMinutes == null ? null : durationMinutes * 60,
        usedPercent,
        resetsAtMs,
        observedAtMs,
        source: "codex-app-server",
        quality: "authoritative",
        metadata: {
          limitId,
          lane,
          planType: normalizeCodexPlanType(value.planType),
          rateLimitReachedType:
            typeof value.rateLimitReachedType === "string" ? value.rateLimitReachedType : null,
        },
      });
    }
    const entryCreditBlock = value.credits;
    const entryCreditBalance = entryCreditBlock && typeof entryCreditBlock === "object"
      ? numberOrNull(
          (entryCreditBlock as Record<string, unknown>).balance ??
            (entryCreditBlock as Record<string, unknown>).remaining,
        )
      : null;
    if (entryCreditBalance != null) {
      const target = observations
        .slice(entryStart)
        .find((observation) => observation.metadata?.lane === "primary") ?? observations[entryStart];
      if (target) target.creditBalance = entryCreditBalance;
    }
  }

  const canonical = observations.find(
    (observation) => observation.metadata?.limitId === "codex" && observation.metadata?.lane === "primary",
  ) ?? observations[0];
  if (canonical) {
    if (canonical.creditBalance == null) canonical.creditBalance = topLevelCreditBalance;
    canonical.resetCreditsAvailable = resetCreditsAvailable;
  }
  return observations;
}
