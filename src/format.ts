import type { ProviderStatus, QuotaEvent, WindowAnalysis } from "./types";

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds == null) return "unknown";
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function number(value: number | null, digits = 1): string {
  return value == null ? "—" : value.toFixed(digits);
}

function clock(timestampMs: number | null): string {
  return timestampMs == null
    ? "—"
    : new Date(timestampMs).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function windowLine(window: WindowAnalysis, bottleneck: boolean): string[] {
  const marker = bottleneck ? "●" : "○";
  const remaining = window.remainingPercent == null ? "—" : `${window.remainingPercent.toFixed(1)}% left`;
  const reset = window.resetsAtMs == null ? "reset unknown" : `reset in ${formatDuration(window.timeToResetMs)}`;
  const lines = [`  ${marker} ${window.label}: ${remaining} · ${reset} · ${window.freshness}`];
  if (window.blendedBurnPerHour != null) {
    const pace = window.paceRatio == null ? "pace learning" : `${window.paceRatio.toFixed(2)}× safe pace`;
    lines.push(
      `    burn ${number(window.blendedBurnPerHour)}%/active-h · personal ${number(window.personalBurnPerHour)}%/active-h · ${pace} · confidence ${window.confidence}`,
    );
  } else {
    lines.push(`    personal pace learning (${window.sampleCount} samples)`);
  }
  if (window.minutesBeforeReset != null && window.minutesBeforeReset > 0) {
    lines.push(
      `    safe reserve ETA ${clock(window.exhaustsAtMs)} · ${Math.round(window.minutesBeforeReset)}m before reset`,
    );
  }
  lines.push(
    `    provider reset ${clock(window.resetsAtMs)} · source ${window.source} · observed ${formatDuration(Date.now() - window.observedAtMs)} ago`,
  );
  return lines;
}

export function formatStatuses(statuses: ProviderStatus[]): string {
  if (!statuses.length) {
    return "No quota observations yet. Run `quotapie poll` and connect the Claude status line.";
  }
  const lines: string[] = [];
  for (const status of statuses) {
    lines.push(`${status.provider.toUpperCase()} · ${status.accountLabel}`);
    for (const window of status.windows) {
      lines.push(...windowLine(window, window.bucket === status.bottleneckBucket));
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function formatEvents(events: QuotaEvent[]): string {
  if (!events.length) return "No events recorded.";
  return events
    .map((event) => {
      const at = new Date(event.occurredAtMs).toLocaleString();
      return `${at} [${event.severity}] ${event.provider}/${event.account}/${event.bucket} ${event.kind}\n  ${event.displayText}`;
    })
    .join("\n");
}

export function compactClaudeLine(windows: WindowAnalysis[], accountLabel?: string): string {
  const claude = windows.filter((window) => window.provider === "claude");
  if (!claude.length) return "⏱ Claude quota: waiting for first API response";
  const short = claude.find((window) => window.windowSeconds != null && window.windowSeconds <= 6 * 3_600);
  // Claude can expose several weekly windows (overall plus per-model). Taking
  // the first one hides a model-scoped window that is the actual bottleneck,
  // which is the opposite of what this line is for.
  const weekly = claude
    .filter((window) => window.windowSeconds != null && window.windowSeconds >= 6 * 86_400)
    .sort((left, right) => right.bottleneckScore - left.bottleneckScore)[0];
  const item = (window: WindowAnalysis | undefined, name: string): string => {
    if (!window || window.remainingPercent == null) return `${name} —`;
    const pace = window.paceRatio == null ? "learning" : `${window.paceRatio.toFixed(1)}×`;
    return `${name} ${Math.round(window.remainingPercent)}% · ${formatDuration(window.timeToResetMs)} · ${pace}`;
  };
  return `⏱${accountLabel ? ` ${accountLabel}` : ""} ${item(short, "5h")} | ${item(weekly, "W")}`;
}
