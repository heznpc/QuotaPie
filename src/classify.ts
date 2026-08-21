import type { AppConfig } from "./config";
import { resolveLocale, t } from "./i18n";
import type { QuotaEvent, QuotaObservation } from "./types";

// An event carries its kind and the parameters that describe it. The summary is
// a rendering of those, kept alongside so stored history stays readable and so
// consumers that do not want to translate anything have something to show.
function event(
  next: QuotaObservation,
  kind: QuotaEvent["kind"],
  severity: QuotaEvent["severity"],
  confidence: QuotaEvent["confidence"],
  config: AppConfig,
  details: QuotaEvent["details"] = {},
): QuotaEvent {
  const params = {
    label: next.label,
    provider: next.provider,
    account: next.account,
    ...details,
  };
  return {
    provider: next.provider,
    account: next.account,
    bucket: next.bucket,
    kind,
    severity,
    occurredAtMs: next.observedAtMs,
    confidence,
    displayText: t(`event.${kind}`, params, resolveLocale(config.profile.locale)),
    details: { label: next.label, ...details },
  };
}

export function classifyDelta(
  previous: QuotaObservation | null,
  next: QuotaObservation,
  config: AppConfig,
): QuotaEvent[] {
  if (!previous) {
    return [event(next, "first_observation", "info", "high", config,)];
  }

  if (next.observedAtMs < previous.observedAtMs) {
    return [
      event(next, "out_of_order", "info", "high", config, {
        previousObservedAtMs: previous.observedAtMs,
        nextObservedAtMs: next.observedAtMs,
      }),
    ];
  }

  const events: QuotaEvent[] = [];
  if (next.source !== previous.source) {
    events.push(
      event(next, "source_changed", "info", "high", config, {
        from: previous.source,
        to: next.source,
      }),
    );
  }

  if (next.usedPercent == null || next.resetsAtMs == null) {
    if (previous.usedPercent != null || previous.resetsAtMs != null) {
      events.push(
        event(next, "source_unknown", "warning", "high", config, {
          usedPercentMissing: next.usedPercent == null,
          resetsAtMissing: next.resetsAtMs == null,
        }),
      );
    }
    return events;
  }

  const previousUsed = previous.usedPercent;
  const previousReset = previous.resetsAtMs;
  if (previousUsed != null && previousReset != null) {
    const drop = previousUsed - next.usedPercent;
    const resetShiftMs = next.resetsAtMs - previousReset;
    const rebaseToleranceMs = config.detection.rebaseToleranceMinutes * 60_000;
    const resetToleranceMs = config.detection.resetToleranceMinutes * 60_000;
    const nearScheduledReset = Math.abs(next.observedAtMs - previousReset) <= resetToleranceMs;
    const resetChanged = Math.abs(resetShiftMs) > rebaseToleranceMs;
    const meaningfulDrop = drop > 0.000_001;
    const strongDrop = drop >= config.detection.reliefDropPercent;
    const smallDrop = drop >= config.detection.meterCorrectionPercent;

    // A provider clock advancing to a new window is a stronger reset signal than
    // the absolute drop. Low-use windows commonly reset from only 2–10% to 0%.
    if (resetChanged && meaningfulDrop && nearScheduledReset) {
      events.push(
        event(
          next,
          "scheduled_reset",
          "info",
          strongDrop ? "high" : smallDrop ? "medium" : "low",
          config,
          {
            usedPercentBefore: previousUsed,
            usedPercentAfter: next.usedPercent,
            previousResetsAtMs: previousReset,
            nextResetsAtMs: next.resetsAtMs,
          },
        ),
      );
    } else if (
      resetChanged &&
      meaningfulDrop &&
      next.observedAtMs < previousReset - resetToleranceMs
    ) {
      events.push(
        event(
          next,
          "external_relief",
          "info",
          strongDrop ? "high" : smallDrop ? "medium" : "low",
          config,
          {
            usedPercentBefore: previousUsed,
            usedPercentAfter: next.usedPercent,
            minutesEarly: Math.round((previousReset - next.observedAtMs) / 60_000),
            previousResetsAtMs: previousReset,
            nextResetsAtMs: next.resetsAtMs,
          },
        ),
      );
    } else if (strongDrop) {
      events.push(
        event(
          next,
          "allowance_relief",
          "info",
          "medium",
          config,
          {
            usedPercentBefore: previousUsed,
            usedPercentAfter: next.usedPercent,
            resetChanged,
          },
        ),
      );
    } else if (smallDrop) {
      events.push(
        event(next, "meter_correction", "info", "low", config, {
          usedPercentBefore: previousUsed,
          usedPercentAfter: next.usedPercent,
        }),
      );
    } else if (resetChanged) {
      events.push(
        event(next, "schedule_rebased", "info", "high", config, {
          shiftMinutes: Math.round(resetShiftMs / 60_000),
          previousResetsAtMs: previousReset,
          nextResetsAtMs: next.resetsAtMs,
        }),
      );
    }
  }

  if (
    previous.creditBalance != null &&
    next.creditBalance != null &&
    next.creditBalance < previous.creditBalance - 0.000_001
  ) {
    events.push(
      event(next, "paid_usage", "warning", "high", config, {
        balanceBefore: previous.creditBalance,
        balanceAfter: next.creditBalance,
      }),
    );
  } else if (
    previous.creditBalance != null &&
    next.creditBalance != null &&
    next.creditBalance > previous.creditBalance + 0.000_001
  ) {
    events.push(
      event(next, "credit_topup", "warning", "medium", config, {
        balanceBefore: previous.creditBalance,
        balanceAfter: next.creditBalance,
      }),
    );
  }

  if (
    previous.resetCreditsAvailable != null &&
    next.resetCreditsAvailable != null &&
    next.resetCreditsAvailable < previous.resetCreditsAvailable
  ) {
    events.push(
      event(next, "banked_reset_consumed", "info", "high", config, {
        countBefore: previous.resetCreditsAvailable,
        countAfter: next.resetCreditsAvailable,
      }),
    );
  }

  return events;
}
