import { localAnnouncementTime, parseAnnouncementTime } from "./time";
import { t, type Locale, type MessageKey } from "../i18n";
import type { TriggerDecision } from "../types";
import { benefitCategory, type ResetSignal } from "./classify";

/** Quantities quoted by the source, never inferred from observed burn rate. */
export function benefitChangeText(signal: ResetSignal, locale: Locale): string | null {
  const change = signal.change;
  if (!change) return null;
  const number = (value: number) => new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US", { maximumFractionDigits: 2 }).format(value);
  const units: Record<string, string> = locale === "ko"
    ? { tokens: "토큰", credits: "크레딧", resets: "개", messages: "메시지", requests: "회" }
    : { tokens: "tokens", credits: "credits", resets: "tickets", messages: "messages", requests: "requests" };
  const unit = change.unit && change.unit !== "%" ? ` ${units[change.unit] ?? change.unit}` : "";
  const parts: string[] = [];
  if (Number.isFinite(change.before) && Number.isFinite(change.after))
    parts.push(`${number(change.before!)} → ${number(change.after!)}${unit}`);
  else if (Number.isFinite(change.amount)) parts.push(`+${number(change.amount!)}${unit}`);
  if (Number.isFinite(change.percent)) {
    const percent = change.percent!;
    parts.push(locale === "ko"
      ? `기존 대비 ${percent >= 0 ? "+" : ""}${number(percent)}% (기존의 ${number(1 + percent / 100)}배)`
      : `${percent >= 0 ? "+" : ""}${number(percent)}% (${number(1 + percent / 100)}× previous allowance)`);
  }
  return parts.length ? (locale === "ko" ? "발표 수치: " : "Announced: ") + parts.join(" · ") : null;
}

export function signalDecision(signal: ResetSignal, locale: Locale, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, remaining: string[] = []): TriggerDecision {
  const fallback = (!signal.benefitKind || signal.benefitKind === "reset") && signal.resetKind === "banked" ? "resetCredits" : signal.benefitKind;
  const benefit = benefitCategory(signal.change?.evidence ?? `${signal.text}\n${signal.contextText ?? ""}`, fallback);
  const titleKey: MessageKey = benefit !== "reset" ? `signal.${benefit}`
    : signal.provider === "claude" ? `signal.claude.${signal.state}` : `signal.${signal.state}`;
  const titleParams = { provider: signal.provider === "claude" ? "Claude" : "Codex" };
  // Long release posts often put the reset/time promise at the end.
  const evidence = signal.change?.evidence ?? signal.timeHint ?? signal.text.split(/(?<=[.!?])\s+|\n+/).find(s => /\b(?:reset|credits?|tokens?|limits?|allowance|usage)\b/i.test(s)) ?? signal.text;
  const localTime = localAnnouncementTime(signal, locale, timeZone);
  const state = { possible: locale === "ko" ? "가능성 언급" : "Possible", announced: locale === "ko" ? "예고" : "Announced", reported: locale === "ko" ? "시행 발표" : "Reported", updated: locale === "ko" ? "변경" : "Updated", withdrawn: locale === "ko" ? "철회" : "Withdrawn" }[signal.state];
  const change = benefitChangeText(signal, locale);
  const pendingReset = benefit === "reset" && signal.resetKind !== "banked" && ["possible", "announced", "updated"].includes(signal.state);
  const endOfDay = pendingReset && /\b(?:EOD|end\s+of\s+(?:the\s+)?day)\b/i.test(evidence)
    && !parseAnnouncementTime(evidence, signal.publishedAtMs);
  const uncertain = pendingReset && (!localTime || endOfDay);
  const sourceZone = evidence.match(/\b(PST|PDT|PT|EST|EDT|ET|UTC|GMT|KST|JST|CET|CEST)\b/i)?.[0]?.toUpperCase();
  const deadline = benefit === "reset" && signal.resetKind !== "banked"
    && ["possible", "announced", "updated"].includes(signal.state) && !!localTime && /\bby\b/i.test(evidence);
  const guidance = endOfDay && localTime ? (locale === "ko"
    ? "확정 리셋 시각이 아니며 더 일찍 리셋될 수 있습니다."
    : "This is not a confirmed reset time; it may reset earlier.") : endOfDay ? (locale === "ko"
    ? `오늘 중 리셋 예고(EOD): ${sourceZone ? `원문 시간대 ${sourceZone}, 정확한 시행 시각 미정` : "원문의 날짜·시간대 기준과 시행 시각 미확인"}. 자정까지 기다리지 마세요. 그 전에 리셋될 수 있으니 남은 한도로 할 작업을 지금 확인하세요.`
    : `Reset announced by end of day (EOD): ${sourceZone ? `source zone ${sourceZone}, execution time unknown` : "source date/time-zone basis and execution time unverified"}. Do not wait until midnight; it may reset earlier. Review work for your remaining quota now.`) : deadline ? (locale === "ko"
    ? "표시된 시각은 시행 예정 시각이 아니라 발표된 마감입니다. 그보다 일찍 리셋될 수 있으니 남은 한도로 할 작업을 지금 확인하세요."
    : "The displayed time is the announced deadline, not the scheduled reset time. It may reset earlier; review work for your remaining quota now.") : uncertain ? (locale === "ko"
    ? "시각 미정: 예고 없이 시행될 수 있습니다. 리셋 전에 쓸 작업을 확인하세요."
    : "Timing unknown: a reset may happen without further notice. Review work you want to finish before it.") : null;
  const compact = endOfDay && !!localTime;
  const detail = compact ? localTime! : [localTime, guidance, ...remaining, benefit !== "reset" ? state : null, change, evidence.slice(0, 240)].filter(Boolean).join(" · ");
  const params = { source: `@${signal.author}`, detail: detail + (signal.timeHint && !localTime ? (locale === "ko" ? " (확정 시각 미확인)" : " (exact deadline unverified)") : ""), url: compact ? "" : signal.sourceUrl };
  const messageKey: MessageKey = signal.observedVia !== "x-api" ? "signal.message.relay" : "signal.message.direct";
  return { key: `signal:${signal.fingerprint}`, title: t(titleKey, titleParams, locale),
    message: t(messageKey, params, locale), severity: uncertain || deadline ? "warning" : "info",
    presentation: { title: { key: titleKey, params: titleParams }, message: { key: messageKey, params } } };
}
