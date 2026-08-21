// Every user-visible sentence this process produces comes from here.
//
// The rule for the rest of the codebase is that it moves meaning around, not
// prose: an event carries its kind and its parameters, a headline carries what
// it concluded and about which window. Sentences are made at the edge, by
// whichever surface is about to show one. The backend is itself that edge for
// two surfaces — macOS notifications and the CLI — so the catalog lives here
// rather than only in the apps.
//
// English is the default. Korean is a locale, not the substrate.

export const LOCALES = ["en", "ko"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/// Resolves "auto" against the environment. Only the language subtag matters,
/// so ko_KR.UTF-8, ko-KR, and ko all land on Korean.
export function resolveLocale(
  configured: string | null | undefined,
  environment: Record<string, string | undefined> = process.env,
): Locale {
  if (isLocale(configured)) return configured;
  if (configured != null && configured !== "auto") return DEFAULT_LOCALE;
  const raw = environment.QUOTAPIE_LOCALE ?? environment.LC_ALL ?? environment.LC_MESSAGES ?? environment.LANG;
  const language = typeof raw === "string" ? raw.toLowerCase().split(/[._-]/)[0] : null;
  return isLocale(language) ? language : DEFAULT_LOCALE;
}

export type WindowKind = "five-hour" | "weekly" | "monthly" | "other";

export interface MessageParams {
  label?: string;
  provider?: string;
  account?: string;
  windowKind?: WindowKind;
  fromLabel?: string;
  toLabel?: string;
  limitId?: string;
  lane?: string;
  percent?: number;
  minutes?: number;
  date?: string;
  paceRatio?: number;
  threshold?: number;
  detail?: string;
}

type Renderer = (params: MessageParams) => string;

function windowName(kind: WindowKind | undefined, locale: Locale, fallback?: string): string {
  if (kind == null || kind === "other") return fallback ?? "";
  const names: Record<Locale, Record<Exclude<WindowKind, "other">, string>> = {
    en: { "five-hour": "5-hour", weekly: "weekly", monthly: "monthly" },
    ko: { "five-hour": "5시간", weekly: "주간", monthly: "월간" },
  };
  return names[locale][kind];
}

/// Minutes stop being readable within a day, so a gap is always expressed in
/// its largest two units.
export function humanGap(minutes: number, locale: Locale = DEFAULT_LOCALE): string {
  const total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / 1_440);
  const hours = Math.floor((total % 1_440) / 60);
  const mins = total % 60;
  if (locale === "ko") {
    if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
    if (hours > 0) return mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;
    return `${mins}분`;
  }
  const unit = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`;
  if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day");
  if (hours > 0) return mins > 0 ? `${unit(hours, "hour")} ${unit(mins, "minute")}` : unit(hours, "hour");
  return unit(mins, "minute");
}

const CATALOG: Record<string, Record<Locale, Renderer>> = {
  // Events, one per EventKind that is ever shown.
  "event.first_observation": {
    en: (p) => `Started tracking ${p.label}.`,
    ko: (p) => `${p.label} 관측을 시작했습니다.`,
  },
  "event.out_of_order": {
    en: (p) => `Ignored an out-of-order response for ${p.label}.`,
    ko: (p) => `${p.label}의 오래된 응답을 무시했습니다.`,
  },
  "event.source_changed": {
    en: (p) => `${p.label} switched data source.`,
    ko: (p) => `${p.label} 데이터 소스가 변경됐습니다.`,
  },
  "event.source_unknown": {
    en: (p) => `${p.label} temporarily reported no value.`,
    ko: (p) => `${p.label} 원본 값이 일시적으로 사라졌습니다.`,
  },
  "event.scheduled_reset": {
    en: (p) => `${p.label} reset on schedule.`,
    ko: (p) => `${p.label} 한도가 예정대로 갱신됐습니다.`,
  },
  "event.external_relief": {
    en: (p) => `${p.label} was refilled ahead of schedule.`,
    ko: (p) => `${p.label}에 예정 밖 충전이 감지됐습니다.`,
  },
  "event.allowance_relief": {
    en: (p) => `${p.label} usage fell sharply — a reset, a larger allowance, or a server correction.`,
    ko: (p) => `${p.label} 사용률이 크게 낮아졌습니다. 리셋·한도 증액·서버 보정 중 하나일 수 있습니다.`,
  },
  "event.meter_correction": {
    en: (p) => `${p.label} usage moved slightly backwards.`,
    ko: (p) => `${p.label} 사용률이 소폭 역행했습니다.`,
  },
  "event.schedule_rebased": {
    en: (p) => `${p.label} reset time was rescheduled.`,
    ko: (p) => `${p.label} 리셋 시각이 재조정됐습니다.`,
  },
  "event.paid_usage": {
    en: (p) => `${p.provider} paid credits were used.`,
    ko: (p) => `${p.provider} 유료 크레딧이 사용됐습니다.`,
  },
  "event.credit_topup": {
    en: (p) => `${p.provider} credit balance increased.`,
    ko: (p) => `${p.provider} 크레딧 잔액이 증가했습니다.`,
  },
  "event.banked_reset_consumed": {
    en: () => "A banked reset appears to have been used.",
    ko: () => "저장형 리셋이 사용된 것으로 보입니다.",
  },
  "event.bucket_retired": {
    en: (p) => `${p.label} disappeared from the provider's full response; tracking stopped.`,
    ko: (p) => `${p.label} 항목이 공급자 전체 응답에서 사라져 추적을 종료했습니다.`,
  },
  "event.window_changed": {
    en: (p) => `${p.limitId} ${p.lane} window changed: ${p.fromLabel} → ${p.toLabel}`,
    ko: (p) => `${p.limitId} ${p.lane} 한도 창 전환: ${p.fromLabel} → ${p.toLabel}`,
  },

  "window.five-hour": { en: () => "5-hour", ko: () => "5시간" },
  "window.weekly": { en: () => "weekly", ko: () => "주간" },
  "window.monthly": { en: () => "monthly", ko: () => "월간" },

  // Headline: the single conclusion for the menu bar.
  "headline.pace-risk": {
    en: (p) => `⚠ ${windowName(p.windowKind, "en", p.label)} at risk`,
    ko: (p) => `⚠ ${windowName(p.windowKind, "ko", p.label)} 위험`,
  },
  "headline.pace-risk.detail": {
    en: (p) => `${p.provider} · ${p.account} · ${p.label}${p.date ? ` · runs dry around ${p.date}` : ""}`,
    ko: (p) => `${p.provider} · ${p.account} · ${p.label}${p.date ? ` · ${p.date}경 소진 예상` : ""}`,
  },
  "headline.degraded": { en: () => "Limits unconfirmed", ko: () => "한도 확인 지연" },
  "headline.setup": { en: () => "Setup needed", ko: () => "설정 필요" },
  "headline.normal": {
    en: (p) => `${Math.round(p.percent ?? 0)}% left`,
    ko: (p) => `${Math.round(p.percent ?? 0)}% 남음`,
  },
  "headline.normal.unknown": { en: () => "Limits confirmed", ko: () => "한도 확인됨" },
  "headline.detail": {
    en: (p) => `${p.provider} · ${p.account} · ${p.label}`,
    ko: (p) => `${p.provider} · ${p.account} · ${p.label}`,
  },
  "headline.noAccounts": {
    en: () => "No account is configured for tracking.",
    ko: () => "추적할 계정이 설정되지 않았습니다.",
  },

  // Collection state, phrased as something to act on.
  "collection.auth-required": { en: () => "Sign-in required", ko: () => "로그인이 필요합니다" },
  "collection.auth-expired": { en: () => "Sign-in expired", ko: () => "로그인이 만료됐습니다" },
  "collection.rate-limited": { en: () => "Provider rate limit reached", ko: () => "공급자 요청 한도에 걸렸습니다" },
  "collection.network": { en: () => "Cannot reach the network", ko: () => "네트워크에 연결할 수 없습니다" },
  "collection.not-configured": { en: () => "Collection is not configured", ko: () => "수집이 설정되지 않았습니다" },
  "collection.isolation-unsafe": {
    en: () => "Account credentials need isolating",
    ko: () => "계정 자격증명 격리가 필요합니다",
  },
  "collection.provider-error": {
    en: () => "Could not read the provider's response",
    ko: () => "공급자 응답을 읽지 못했습니다",
  },
  "collection.no-windows": { en: () => "The response carried no limit windows", ko: () => "응답에 한도 창이 없습니다" },
  "collection.never-attempted": { en: () => "Not collected yet", ko: () => "아직 수집을 시도하지 않았습니다" },
  "collection.stale-success": { en: () => "Collection is running late", ko: () => "한도 확인이 지연되고 있습니다" },
  "collection.attempted-then-failed": { en: () => "Collection failed", ko: () => "수집에 실패했습니다" },

  // Alerts.
  "alert.remaining.title": {
    en: (p) => `${p.provider}/${p.account} limit running low`,
    ko: (p) => `${p.provider}/${p.account} 잔여 한도 경고`,
  },
  "alert.remaining.message": {
    en: (p) => `${p.label} has ${p.percent}% left (threshold ${p.threshold}%).`,
    ko: (p) => `${p.label} 잔여 ${p.percent}% (기준 ${p.threshold}%).`,
  },
  "alert.pace.title.measured": {
    en: (p) => `${p.provider}/${p.account} burning too fast`,
    ko: (p) => `${p.provider}/${p.account} 사용 속도 과열`,
  },
  "alert.pace.title.projected": {
    en: (p) => `${p.provider}/${p.account} pace forecast`,
    ko: (p) => `${p.provider}/${p.account} 사용 패턴 전망`,
  },
  "alert.pace.message.measured": {
    en: (p) => `${p.label} is on course to exhaust its safety margin about ${p.detail} before the reset.`,
    ko: (p) => `${p.label} 안전 여유가 리셋보다 약 ${p.detail} 먼저 소진될 전망입니다.`,
  },
  "alert.pace.message.projected": {
    en: (p) => `${p.label}: on this pattern the safety margin runs out about ${p.detail} before the reset.`,
    ko: (p) => `${p.label} 이 패턴이면 안전 여유가 리셋보다 약 ${p.detail} 먼저 소진될 전망입니다.`,
  },
  "alert.stale.title": {
    en: (p) => `${p.provider}/${p.account} collection stalled`,
    ko: (p) => `${p.provider}/${p.account} 수집 중단`,
  },
  "alert.stale.message": {
    en: (p) => `${p.label} has had no fresh value for a while.`,
    ko: (p) => `${p.label} 값이 한동안 갱신되지 않았습니다.`,
  },
  "alert.event.title.payment": {
    en: (p) => `${p.provider}/${p.account} billable usage changed`,
    ko: (p) => `${p.provider}/${p.account} 결제성 사용 변화`,
  },
  "alert.event.title.window": {
    en: (p) => `${p.provider}/${p.account} limit window changed`,
    ko: (p) => `${p.provider}/${p.account} 한도 창 전환`,
  },
  "alert.event.title.resync": {
    en: (p) => `${p.provider}/${p.account} timer resynchronised`,
    ko: (p) => `${p.provider}/${p.account} 타이머 재동기화`,
  },
  "alert.test.title": { en: () => "QuotaPie test", ko: () => "QuotaPie 테스트" },
  "alert.test.message": {
    en: () => "The notification channel is connected.",
    ko: () => "알림 채널이 정상적으로 연결됐습니다.",
  },
};

export type MessageKey = keyof typeof CATALOG;

export function t(key: string, params: MessageParams = {}, locale: Locale = DEFAULT_LOCALE): string {
  const entry = CATALOG[key];
  // A missing key is a bug, not a reason to show nothing: surface the key so it
  // is obvious in a screenshot rather than silently empty.
  if (!entry) return key;
  return (entry[locale] ?? entry[DEFAULT_LOCALE])(params);
}

export function windowKindOf(windowSeconds: number | null | undefined): WindowKind {
  if (windowSeconds == null) return "other";
  if (windowSeconds >= 28 * 86_400) return "monthly";
  if (windowSeconds >= 7 * 86_400) return "weekly";
  if (windowSeconds <= 6 * 3_600) return "five-hour";
  return "other";
}

export function formatDay(timestampMs: number, locale: Locale = DEFAULT_LOCALE): string {
  return new Date(timestampMs).toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", {
    month: locale === "ko" ? "long" : "short",
    day: "numeric",
  });
}
