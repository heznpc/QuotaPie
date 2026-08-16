import type { AppConfig } from "./config";
import type { QuotaEvent, QuotaObservation } from "./types";

function event(
  next: QuotaObservation,
  kind: QuotaEvent["kind"],
  severity: QuotaEvent["severity"],
  confidence: QuotaEvent["confidence"],
  summary: string,
  details: QuotaEvent["details"] = {},
): QuotaEvent {
  return {
    provider: next.provider,
    account: next.account,
    bucket: next.bucket,
    kind,
    severity,
    occurredAtMs: next.observedAtMs,
    confidence,
    summary,
    details,
  };
}

export function classifyDelta(
  previous: QuotaObservation | null,
  next: QuotaObservation,
  config: AppConfig,
): QuotaEvent[] {
  if (!previous) {
    return [event(next, "first_observation", "info", "high", `${next.label} 관측을 시작했습니다.`)];
  }

  if (next.observedAtMs < previous.observedAtMs) {
    return [
      event(next, "out_of_order", "info", "high", `${next.label}의 오래된 응답을 무시했습니다.`, {
        previousObservedAtMs: previous.observedAtMs,
        nextObservedAtMs: next.observedAtMs,
      }),
    ];
  }

  const events: QuotaEvent[] = [];
  if (next.source !== previous.source) {
    events.push(
      event(next, "source_changed", "info", "high", `${next.label} 데이터 소스가 변경됐습니다.`, {
        from: previous.source,
        to: next.source,
      }),
    );
  }

  if (next.usedPercent == null || next.resetsAtMs == null) {
    if (previous.usedPercent != null || previous.resetsAtMs != null) {
      events.push(
        event(next, "source_unknown", "warning", "high", `${next.label} 원본 값이 일시적으로 사라졌습니다.`, {
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
          `${next.label} 한도가 예정대로 갱신됐습니다.`,
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
          `${next.label}에 예정 밖 충전이 감지됐습니다.`,
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
          `${next.label} 사용률이 크게 낮아졌습니다. 리셋·한도 증액·서버 보정 중 하나일 수 있습니다.`,
          {
            usedPercentBefore: previousUsed,
            usedPercentAfter: next.usedPercent,
            resetChanged,
          },
        ),
      );
    } else if (smallDrop) {
      events.push(
        event(next, "meter_correction", "info", "low", `${next.label} 사용률이 소폭 역행했습니다.`, {
          usedPercentBefore: previousUsed,
          usedPercentAfter: next.usedPercent,
        }),
      );
    } else if (resetChanged) {
      events.push(
        event(next, "schedule_rebased", "info", "high", `${next.label} 리셋 시각이 재조정됐습니다.`, {
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
      event(next, "paid_usage", "warning", "high", `${next.provider} 유료 크레딧이 사용됐습니다.`, {
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
      event(next, "credit_topup", "warning", "medium", `${next.provider} 크레딧 잔액이 증가했습니다.`, {
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
      event(next, "banked_reset_consumed", "info", "high", "저장형 리셋이 사용된 것으로 보입니다.", {
        countBefore: previous.resetCreditsAvailable,
        countAfter: next.resetCreditsAvailable,
      }),
    );
  }

  return events;
}
