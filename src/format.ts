import { DEFAULT_LOCALE, t } from "./i18n";
import type { Locale, MessageParams } from "./i18n";
import type { ProviderStatus, QuotaEvent, WindowAnalysis } from "./types";

export function formatDuration(milliseconds: number | null, locale: Locale = DEFAULT_LOCALE): string {
  if (milliseconds == null) return t("format.duration.unknown", {}, locale);
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return t("format.duration.days-hours", { days, hours }, locale);
  if (hours > 0) return t("format.duration.hours-minutes", { hours, minutes }, locale);
  return t("format.duration.minutes", { minutes }, locale);
}

function number(value: number | null, digits = 1): string {
  return value == null ? "—" : value.toFixed(digits);
}

function clock(timestampMs: number | null, locale: Locale): string {
  return timestampMs == null
    ? "—"
    : new Date(timestampMs).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function eventHasSemanticParams(event: QuotaEvent): boolean {
  const hasString = (key: string) => typeof event.details[key] === "string";
  switch (event.kind) {
    case "paid_usage":
    case "credit_topup":
    case "banked_reset_consumed":
    case "account_changed":
      return true;
    case "window_changed":
      return ["fromLabel", "toLabel"].every(hasString);
    case "plan_changed":
      return ["fromPlan", "toPlan"].every(hasString);
    default:
      return hasString("label");
  }
}

function windowLine(window: WindowAnalysis, bottleneck: boolean, locale: Locale): string[] {
  const marker = bottleneck ? "●" : "○";
  const remaining = window.remainingPercent == null
    ? "—"
    : t("format.status.remaining", { percent: Number(window.remainingPercent.toFixed(1)) }, locale);
  const reset = window.resetsAtMs == null
    ? t("format.status.reset-unknown", {}, locale)
    : t("format.status.reset-in", { detail: formatDuration(window.timeToResetMs, locale) }, locale);
  const freshness = t(`format.freshness.${window.freshness}`, {}, locale);
  const lines = [t("format.status.window", { marker, label: window.label, remaining, reset, freshness }, locale)];
  if (window.blendedBurnPerHour != null) {
    const pace = window.paceRatio == null
      ? t("format.status.pace-learning", {}, locale)
      : t("format.status.safe-pace", { pace: window.paceRatio.toFixed(2) }, locale);
    lines.push(
      t("format.status.burn", {
        burn: number(window.blendedBurnPerHour),
        personal: number(window.personalBurnPerHour),
        pace,
        confidence: t(`format.confidence.${window.confidence}`, {}, locale),
      }, locale),
    );
  } else {
    lines.push(t("format.status.personal-learning", { count: window.sampleCount }, locale));
  }
  if (window.minutesBeforeReset != null && window.minutesBeforeReset > 0) {
    lines.push(
      t("format.status.reserve-eta", {
        date: clock(window.exhaustsAtMs, locale),
        detail: formatDuration(window.minutesBeforeReset * 60_000, locale),
      }, locale),
    );
  }
  lines.push(
    t("format.status.observation", {
      date: clock(window.resetsAtMs, locale),
      source: window.source,
      observed: formatDuration(Date.now() - window.observedAtMs, locale),
    }, locale),
  );
  return lines;
}

export function formatStatuses(statuses: ProviderStatus[], locale: Locale = DEFAULT_LOCALE): string {
  if (!statuses.length) {
    return t("format.status.none", {}, locale);
  }
  const lines: string[] = [];
  for (const status of statuses) {
    lines.push(`${status.provider.toUpperCase()} · ${status.accountLabel}`);
    for (const window of status.windows) {
      lines.push(...windowLine(window, window.bucket === status.bottleneckBucket, locale));
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function formatEvents(events: QuotaEvent[], locale: Locale = DEFAULT_LOCALE): string {
  if (!events.length) return t("format.events.none", {}, locale);
  return events
    .map((event) => {
      const at = new Date(event.occurredAtMs).toLocaleString(locale === "ko" ? "ko-KR" : "en-US");
      const params = {
        provider: event.provider,
        account: event.account,
        ...event.details,
      } as MessageParams;
      // Old database rows may predate semantic details. Preserve their stored
      // compatibility rendering instead of replacing it with "undefined";
      // current rows are always rendered in the requested locale.
      const message = eventHasSemanticParams(event)
        ? t(`event.${event.kind}`, params, locale)
        : event.displayText;
      const severity = t(`format.severity.${event.severity}`, {}, locale);
      return `${at} [${severity}] ${event.provider}/${event.account}/${event.bucket} ${event.kind}\n  ${message}`;
    })
    .join("\n");
}

export function compactClaudeLine(
  windows: WindowAnalysis[],
  accountLabel?: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const claude = windows.filter((window) => window.provider === "claude");
  if (!claude.length) return t("format.claude.waiting", {}, locale);
  const short = claude.find((window) => window.windowSeconds != null && window.windowSeconds <= 6 * 3_600);
  // Claude can expose several weekly windows (overall plus per-model). Taking
  // the first one hides a model-scoped window that is the actual bottleneck,
  // which is the opposite of what this line is for.
  const weekly = claude
    .filter((window) => window.windowSeconds != null && window.windowSeconds >= 6 * 86_400)
    .sort((left, right) => right.bottleneckScore - left.bottleneckScore)[0];
  const item = (window: WindowAnalysis | undefined, name: string): string => {
    if (!window || window.remainingPercent == null) return `${name} —`;
    const pace = window.paceRatio == null
      ? t("format.claude.learning", {}, locale)
      : `${window.paceRatio.toFixed(1)}×`;
    return `${name} ${Math.round(window.remainingPercent)}% · ${formatDuration(window.timeToResetMs, locale)} · ${pace}`;
  };
  return `⏱${accountLabel ? ` ${accountLabel}` : ""} ${
    item(short, t("format.claude.short", {}, locale))
  } | ${item(weekly, t("format.claude.weekly", {}, locale))}`;
}
