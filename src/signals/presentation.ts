import { t, type Locale, type MessageKey } from "../i18n";
import type { TriggerDecision } from "../types";
import { benefitCategory, type ResetSignal } from "./classify";

export function signalDecision(signal: ResetSignal, locale: Locale): TriggerDecision {
  const benefit = benefitCategory(`${signal.text}\n${signal.contextText ?? ""}`, signal.benefitKind);
  const titleKey: MessageKey = benefit !== "reset" ? `signal.${benefit}`
    : signal.provider === "claude" ? `signal.claude.${signal.state}` : `signal.${signal.state}`;
  const titleParams = { provider: signal.provider === "claude" ? "Claude" : "Codex" };
  // Long release posts often put the reset/time promise at the end.
  const evidence = signal.timeHint ?? signal.text.split(/(?<=[.!?])\s+|\n+/).find(s => /\b(?:reset|credits?|limits?|allowance)\b/i.test(s)) ?? signal.text;
  const params = { source: `@${signal.author}`, detail: evidence.slice(0, 240) + (signal.timeHint && signal.targetAtMs == null ? (locale === "ko" ? " (확정 시각 미확인)" : " (exact deadline unverified)") : ""), url: signal.sourceUrl };
  const messageKey: MessageKey = signal.observedVia !== "x-api" ? "signal.message.relay" : "signal.message.direct";
  return { key: `signal:${signal.fingerprint}`, title: t(titleKey, titleParams, locale),
    message: t(messageKey, params, locale), severity: "info",
    presentation: { title: { key: titleKey, params: titleParams }, message: { key: messageKey, params } } };
}
