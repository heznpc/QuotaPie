import { t, type Locale, type MessageKey } from "../i18n";
import type { TriggerDecision } from "../types";
import type { ResetSignal } from "./classify";

export function signalDecision(signal: ResetSignal, locale: Locale): TriggerDecision {
  const titleKey: MessageKey = `signal.${signal.state}`;
  const params = { source: `@${signal.author}`, detail: signal.text.slice(0, 220), url: signal.sourceUrl };
  const messageKey: MessageKey = signal.observedVia === "public-feed" ? "signal.message.relay" : "signal.message.direct";
  return { key: `signal:${signal.fingerprint}`, title: t(titleKey, {}, locale),
    message: t(messageKey, params, locale), severity: "info",
    presentation: { title: { key: titleKey, params: {} }, message: { key: messageKey, params } } };
}
