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
  fromPlan?: string;
  toPlan?: string;
  limitId?: string;
  lane?: string;
  percent?: number;
  drop?: number;
  minutes?: number;
  date?: string;
  paceRatio?: number;
  threshold?: number;
  detail?: string;
  path?: string;
  root?: string;
  command?: string;
  url?: string;
  variable?: string;
  value?: string;
  count?: number;
  days?: number;
  hours?: number;
  marker?: string;
  remaining?: string;
  reset?: string;
  freshness?: string;
  burn?: string;
  personal?: string;
  pace?: string;
  confidence?: string;
  source?: string;
  observed?: string;
  check?: string;
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

const CATALOG = {
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
    en: (p) => `Displayed limit changed: ${p.fromLabel} → ${p.toLabel}. Account or plan change unverified.`,
    ko: (p) => `한도 표시 변경: ${p.fromLabel} → ${p.toLabel} · 계정·플랜 변경 여부 미확인`,
  },
  "event.account_changed": {
    en: () => "A different Codex login was observed. Tracking quota from the new account separately.",
    ko: () => "다른 Codex 계정으로 로그인한 것을 확인했습니다. 새 계정의 잔량을 별도로 추적합니다.",
  },
  "event.plan_changed": {
    en: p => `The same Codex login changed plan: ${p.fromPlan} → ${p.toPlan}. Quota was remeasured.`,
    ko: p => `같은 Codex 계정의 플랜 변경: ${p.fromPlan} → ${p.toPlan} · 잔량을 새로 측정합니다.`,
  },

  "window.five-hour": { en: () => "5-hour", ko: () => "5시간" },
  "window.weekly": { en: () => "weekly", ko: () => "주간" },
  "window.monthly": { en: () => "monthly", ko: () => "월간" },

  // Headline: the single conclusion for the menu bar.
  "headline.remaining": {
    en: (p) => `${p.provider} ${windowName(p.windowKind, "en", p.label)} ${Math.round(Number(p.percent))}% left`,
    ko: (p) => `${p.provider} ${windowName(p.windowKind, "ko", p.label)} ${Math.round(Number(p.percent))}% 남음`,
  },
  "alert.rapid.title": {
    en: (p) => `${p.provider}/${p.account} quota dropping quickly`,
    ko: (p) => `${p.provider}/${p.account} 한도 빠르게 소모 중`,
  },
  "alert.rapid.message": {
    en: (p) => `${p.label}: ${p.drop} percentage points used in ${p.minutes} minutes · ${p.percent}% left.`,
    ko: (p) => `${p.label}: 최근 ${p.minutes}분 동안 ${p.drop}%p 사용 · ${p.percent}% 남음.`,
  },
  "headline.pace-risk": {
    en: (p) => `⚠ ${windowName(p.windowKind, "en", p.label)} at risk`,
    ko: (p) => `⚠ ${windowName(p.windowKind, "ko", p.label)} 위험`,
  },
  "headline.pace-risk.detail": {
    en: (p) => `${p.provider} · ${p.account} · ${p.label}${p.date ? ` · runs dry around ${p.date}` : ""}`,
    ko: (p) => `${p.provider} · ${p.account} · ${p.label}${p.date ? ` · ${p.date}경 소진 예상` : ""}`,
  },
  "headline.degraded": { en: () => "Quota unavailable", ko: () => "잔량 조회 실패" },
  "headline.cached": {
    en: p => `${p.provider} ${windowName(p.windowKind, "en", p.label)} ${Math.round(Number(p.percent))}% · last checked`,
    ko: p => `${p.provider} ${windowName(p.windowKind, "ko", p.label)} ${Math.round(Number(p.percent))}% · 갱신 안 됨`,
  },
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
  "collection.rate-limited": { en: () => "Quota lookup requests are rate limited", ko: () => "한도 조회 요청이 제한됐습니다" },
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
  "collection.stale-success": { en: () => "Quota could not be refreshed", ko: () => "잔량을 새로 조회하지 못했습니다" },
  "collection.attempted-then-failed": { en: () => "Collection failed", ko: () => "수집에 실패했습니다" },
  "collection.recent-success": { en: () => "Collection is current", ko: () => "한도가 최신 상태입니다" },

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
    en: () => "Codex limit display changed",
    ko: () => "Codex 한도 표시 변경",
  },
  "alert.event.title.account": { en: () => "Codex login changed", ko: () => "Codex 로그인 계정 변경" },
  "alert.event.title.plan": { en: () => "Codex plan changed", ko: () => "Codex 플랜 변경" },
  "alert.event.title.resync": {
    en: (p) => `${p.provider}/${p.account} timer resynchronised`,
    ko: (p) => `${p.provider}/${p.account} 타이머 재동기화`,
  },
  "alert.test.title": { en: () => "QuotaPie test", ko: () => "QuotaPie 테스트" },
  "alert.test.message": {
    en: () => "The notification channel is connected.",
    ko: () => "알림 채널이 정상적으로 연결됐습니다.",
  },
  "alert.resume.ready.title": {
    en: (p) => `${p.provider}/${p.account} task is ready`,
    ko: (p) => `${p.provider}/${p.account} 작업 재개 가능`,
  },
  "alert.resume.ready.message": {
    en: (p) => `${p.label} has fresh quota again. Open QuotaPie to approve resuming it.`,
    ko: (p) => `${p.label} 한도가 다시 확인됐습니다. QuotaPie에서 재개를 승인해 주세요.`,
  },
  "resume.registered": {
    en: (p) => `${p.label} will be offered for resume after fresh quota is confirmed.`,
    ko: (p) => `${p.label} 한도가 다시 확인되면 재개할 수 있도록 알려드립니다.`,
  },

  // CLI. Commands and environment-variable names stay literal; every phrase
  // around them is selected by locale here.
  "signal.possible": { en: () => "Possible Codex reset", ko: () => "Codex 리셋 가능성 감지" },
  "signal.announced": { en: () => "Codex reset announced", ko: () => "Codex 리셋 예고" },
  "signal.reported": { en: () => "Codex reset reported", ko: () => "Codex 리셋 시행 소식" },
  "signal.updated": { en: () => "Codex reset update", ko: () => "Codex 리셋 예고 변경" },
  "signal.withdrawn": { en: () => "Codex reset signal withdrawn", ko: () => "Codex 리셋 소식 정정·철회" },
  "signal.message.relay": { en: p => `Public feed · ${p.source}: ${p.detail} — Check your account. ${p.url}`, ko: p => `공개 피드 경유 · ${p.source}: ${p.detail} — 내 계정 적용은 별도 확인. ${p.url}` },
  "signal.message.direct": { en: p => `${p.source}: ${p.detail} — Check your account. ${p.url}`, ko: p => `${p.source}: ${p.detail} — 내 계정 적용은 별도 확인. ${p.url}` },
  "cli.help": {
    en: () => `QuotaPie — provider clocks + personal burn-rate timer

Usage:
  quotapie init                 Create a private default config and print integrations
  quotapie poll [--json]        Fetch Codex once and update history
  quotapie status [--account ID] [--json]
                                 Show current windows, pace, and predicted exhaustion
  quotapie explain [--account ID] [--json]
                                 Explain resets, relief, re-bases, and paid-credit changes
  quotapie accounts [--json]    Show local account aliases and isolated profile roots
  quotapie pause [--provider codex|claude] [--account ID] [--session UUID]
                 [--cwd PATH] [--label NAME] [--bucket ID] [--json]
                                 Register this task for an explicit resume after quota recovers
  quotapie signals [--refresh]  Show public reset signals
  quotapie awake connect|disconnect
                                 Connect or remove working-task sleep hooks
  quotapie codex [--compact-model MODEL] -- [Codex arguments]
                                 Run Codex with experimental Astra → Sol compaction routing
  quotapie claude-statusline [--account ID]
                                 Ingest Claude status-line JSON and render one account's compact line
  quotapie watch                Run the adaptive collector and macOS triggers
  quotapie serve                Watch and serve the local dashboard
  quotapie doctor               Verify the local data sources
  quotapie test-alert           Send a test through configured notification channels
  quotapie launchd              Print a launchd plist for an always-on local service
  quotapie menubar-launchd      Print a launchd plist for the native menu bar app

Environment:
  QUOTAPIE_CONFIG=/path/config.json
  QUOTAPIE_HOME=/path/data-dir`,
    ko: () => `QuotaPie — 공급자 한도 시계 + 개인 사용 속도 타이머

사용법:
  quotapie init                 비공개 기본 설정을 만들고 연동 방법 표시
  quotapie poll [--json]        Codex 한도를 한 번 가져와 기록 갱신
  quotapie status [--account ID] [--json]
                                 현재 한도 창, 사용 속도, 예상 소진 시각 표시
  quotapie explain [--account ID] [--json]
                                 리셋, 충전, 시각 재조정, 유료 크레딧 변화 설명
  quotapie accounts [--json]    로컬 계정 별칭과 격리된 프로필 경로 표시
  quotapie pause [--provider codex|claude] [--account ID] [--session UUID]
                 [--cwd PATH] [--label NAME] [--bucket ID] [--json]
                                 한도 회복 후 명시적으로 재개할 작업 등록
  quotapie signals [--refresh]  공개 리셋 소식 조회
  quotapie awake connect|disconnect
                                 작업 중 잠자기 방지 훅 연결 또는 해제
  quotapie codex [--compact-model MODEL] -- [Codex 인자]
                                 Astra 압축 요청을 Sol로 자동 전환하여 Codex 실행 (실험 기능)
  quotapie claude-statusline [--account ID]
                                 Claude 상태 표시줄 JSON을 받아 한 계정의 요약 표시
  quotapie watch                적응형 수집기와 macOS 트리거 실행
  quotapie serve                수집기와 로컬 대시보드 실행
  quotapie doctor               로컬 데이터 소스 점검
  quotapie test-alert           설정된 알림 채널로 테스트 전송
  quotapie launchd              상시 실행 로컬 서비스용 launchd plist 출력
  quotapie menubar-launchd      기본 메뉴 막대 앱용 launchd plist 출력

환경 변수:
  QUOTAPIE_CONFIG=/path/config.json
  QUOTAPIE_HOME=/path/data-dir`,
  },
  "cli.option.value-required": {
    en: (p) => `${p.label} requires a value`,
    ko: (p) => `${p.label} 옵션에 값이 필요합니다`,
  },
  "cli.init.config": { en: (p) => `Config: ${p.path}`, ko: (p) => `설정: ${p.path}` },
  "cli.init.data": { en: (p) => `Data:   ${p.path}`, ko: (p) => `데이터: ${p.path}` },
  "cli.init.merge": {
    en: (p) => `Merge this into ${p.path} for ${p.label} (${p.account}):`,
    ko: (p) => `${p.label} (${p.account}) 계정용으로 다음 내용을 ${p.path}에 병합하세요:`,
  },
  "cli.init.then-run": {
    en: (p) => `Then run: ${p.command}`,
    ko: (p) => `그런 다음 실행하세요: ${p.command}`,
  },
  "cli.error.unknown-account": {
    en: (p) => `unknown or disabled account alias: ${p.account}`,
    ko: (p) => `알 수 없거나 비활성화된 계정 별칭입니다: ${p.account}`,
  },
  "cli.error.unknown-claude-account": {
    en: (p) => `unknown or disabled Claude account alias: ${p.account}`,
    ko: (p) => `알 수 없거나 비활성화된 Claude 계정 별칭입니다: ${p.account}`,
  },
  "cli.error.profile-mismatch": {
    en: (p) => `${p.variable} does not match one configured ${p.provider} account; pass --account`,
    ko: (p) => `${p.variable} 경로가 설정된 ${p.provider} 계정 하나와 일치하지 않습니다. --account를 지정하세요`,
  },
  "cli.error.multiple-accounts": {
    en: (p) => `multiple ${p.provider} accounts are enabled; pass --account or set ${p.variable}`,
    ko: (p) => `활성화된 ${p.provider} 계정이 여러 개입니다. --account를 지정하거나 ${p.variable}을 설정하세요`,
  },
  "cli.error.no-account": {
    en: (p) => `no enabled ${p.provider} account is configured`,
    ko: (p) => `활성화된 ${p.provider} 계정이 설정되지 않았습니다`,
  },
  "cli.error.provider-invalid": {
    en: () => "--provider must be codex or claude",
    ko: () => "--provider에는 codex 또는 claude를 지정해야 합니다",
  },
  "cli.error.session-ambiguous": {
    en: () => "both CODEX_THREAD_ID and CLAUDE_SESSION_ID are set; pass --provider",
    ko: () => "CODEX_THREAD_ID와 CLAUDE_SESSION_ID가 모두 설정돼 있습니다. --provider를 지정하세요",
  },
  "cli.error.provider-required": {
    en: () => "pass --provider, or run inside a Codex/Claude session environment",
    ko: () => "--provider를 지정하거나 Codex/Claude 세션 환경 안에서 실행하세요",
  },
  "cli.error.session-required": {
    en: (p) => `--session is required because ${p.variable} is not set`,
    ko: (p) => `${p.variable}이 설정되지 않아 --session이 필요합니다`,
  },
  "cli.error.unknown-command": {
    en: (p) => `Unknown command: ${p.command}`,
    ko: (p) => `알 수 없는 명령입니다: ${p.command}`,
  },
  "cli.error.prefix": { en: () => "error", ko: () => "오류" },
  "cli.accounts.profile-root": {
    en: (p) => `  profile root: ${p.root}${p.detail ?? ""}`,
    ko: (p) => `  프로필 경로: ${p.root}${p.detail ?? ""}`,
  },
  "cli.accounts.inherited": { en: () => " (inherited default)", ko: () => " (기본값 상속)" },
  "cli.accounts.login": { en: (p) => `  login: ${p.command}`, ko: (p) => `  로그인: ${p.command}` },
  "cli.accounts.status-line": {
    en: (p) => `  status line: ${p.command}`,
    ko: (p) => `  상태 표시줄: ${p.command}`,
  },
  "cli.accounts.codex-isolation": {
    en: () => `For isolated Codex logins, set cli_auth_credentials_store = "file" in each CODEX_HOME/config.toml.`,
    ko: () => `Codex 로그인을 격리하려면 각 CODEX_HOME/config.toml에 cli_auth_credentials_store = "file"을 설정하세요.`,
  },
  "cli.doctor.check.config": { en: () => "config", ko: () => "설정" },
  "cli.doctor.check.codex-binary": { en: () => "codex binary", ko: () => "Codex 실행 파일" },
  "cli.doctor.check.codex-rate-limits": {
    en: (p) => `codex rate limits [${p.account}]`,
    ko: (p) => `Codex 한도 [${p.account}]`,
  },
  "cli.doctor.check.codex-auth-isolation": {
    en: (p) => `codex auth isolation [${p.account}]`,
    ko: (p) => `Codex 인증 격리 [${p.account}]`,
  },
  "cli.doctor.check.claude-collection": {
    en: (p) => `claude collection [${p.account}]`,
    ko: (p) => `Claude 수집 [${p.account}]`,
  },
  "cli.doctor.check.claude-status-line": {
    en: (p) => `claude status line [${p.account}]`,
    ko: (p) => `Claude 상태 표시줄 [${p.account}]`,
  },
  "cli.doctor.check.claude-login": {
    en: (p) => `claude login [${p.account}]`,
    ko: (p) => `Claude 로그인 [${p.account}]`,
  },
  "cli.doctor.not-created": {
    en: (p) => `not created; defaults active (${p.path})`,
    ko: (p) => `아직 만들지 않음; 기본값 사용 중 (${p.path})`,
  },
  "cli.doctor.not-found": { en: () => "not found", ko: () => "찾을 수 없음" },
  "cli.doctor.windows": {
    en: (p) => `${p.count} windows · ${p.label}`,
    ko: (p) => `${p.count}개 한도 창 · ${p.label}`,
  },
  "cli.doctor.no-windows": {
    en: (p) => `current response contained no windows · ${p.label}`,
    ko: (p) => `현재 응답에 한도 창이 없음 · ${p.label}`,
  },
  "cli.doctor.file-credentials": {
    en: (p) => `${p.path} uses file-scoped credentials`,
    ko: (p) => `${p.path}에서 파일 단위 자격증명을 사용 중`,
  },
  "cli.doctor.set-file-credentials": {
    en: (p) => `set cli_auth_credentials_store = "file" in ${p.path}`,
    ko: (p) => `${p.path}에 cli_auth_credentials_store = "file"을 설정하세요`,
  },
  "cli.doctor.healthy-collection": {
    en: (p) => `${p.source} · ${p.count} windows · ${p.label}`,
    ko: (p) => `${p.source} · 한도 창 ${p.count}개 · ${p.label}`,
  },
  "cli.doctor.fallback-delivering": {
    en: () => "fallback source is delivering while OAuth is unavailable",
    ko: () => "OAuth를 사용할 수 없는 동안 대체 소스가 값을 전달하고 있습니다",
  },
  "cli.doctor.login-instruction": {
    en: () => "run `claude auth login` in a terminal, then re-run doctor",
    ko: () => "터미널에서 `claude auth login`을 실행한 뒤 doctor를 다시 실행하세요",
  },
  "cli.doctor.configured-in": {
    en: (p) => `configured in ${p.path}`,
    ko: (p) => `${p.path}에 설정됨`,
  },
  "cli.doctor.oauth-off": {
    en: (p) => `OAuth collection is off; merge this into ${p.path}: ${p.command} — or set collection.claudeOAuthEnabled = true`,
    ko: (p) => `OAuth 수집이 꺼져 있습니다. ${p.path}에 다음 명령을 병합하세요: ${p.command} — 또는 collection.claudeOAuthEnabled = true를 설정하세요`,
  },
  "cli.test-alert.native-ok": {
    en: () => "Test alert queued for QuotaPie.",
    ko: () => "QuotaPie에 테스트 알림을 등록했습니다.",
  },
  "cli.test-alert.native-partial": {
    en: () => "Test alert queued for QuotaPie, but another configured channel failed.",
    ko: () => "QuotaPie에 테스트 알림을 등록했지만 다른 알림 채널에서 실패했습니다.",
  },
  "cli.test-alert.channels-ok": {
    en: () => "Test alert handed off to configured notification channels.",
    ko: () => "설정된 알림 채널에 테스트 알림을 전달했습니다.",
  },
  "cli.test-alert.channels-failed": {
    en: () => "Test alert could not be handed off; check notification settings and command.",
    ko: () => "테스트 알림을 전달하지 못했습니다. 알림 설정과 명령을 확인하세요.",
  },
  "cli.watch.started": {
    en: () => "QuotaPie is watching provider clocks. Press Ctrl-C to stop.",
    ko: () => "QuotaPie가 공급자 한도 시계를 감시하고 있습니다. 중지하려면 Ctrl-C를 누르세요.",
  },
  "cli.serve.started": {
    en: (p) => `QuotaPie dashboard: ${p.url}`,
    ko: (p) => `QuotaPie 대시보드: ${p.url}`,
  },

  // Human-readable status, event history, and Claude's compact status line.
  "format.duration.unknown": { en: () => "unknown", ko: () => "알 수 없음" },
  "format.duration.days-hours": {
    en: (p) => `${p.days}d ${p.hours}h`,
    ko: (p) => `${p.days}일 ${p.hours}시간`,
  },
  "format.duration.hours-minutes": {
    en: (p) => `${p.hours}h ${p.minutes}m`,
    ko: (p) => `${p.hours}시간 ${p.minutes}분`,
  },
  "format.duration.minutes": { en: (p) => `${p.minutes}m`, ko: (p) => `${p.minutes}분` },
  "format.status.none": {
    en: () => "No quota observations yet. Run `quotapie poll` and connect the Claude status line.",
    ko: () => "아직 한도 관측값이 없습니다. `quotapie poll`을 실행하고 Claude 상태 표시줄을 연결하세요.",
  },
  "format.status.remaining": { en: (p) => `${p.percent}% left`, ko: (p) => `${p.percent}% 남음` },
  "format.status.reset-unknown": { en: () => "reset unknown", ko: () => "리셋 시각 알 수 없음" },
  "format.status.reset-in": { en: (p) => `reset in ${p.detail}`, ko: (p) => `${p.detail} 후 리셋` },
  "format.status.window": {
    en: (p) => `  ${p.marker} ${p.label}: ${p.remaining} · ${p.reset} · ${p.freshness}`,
    ko: (p) => `  ${p.marker} ${p.label}: ${p.remaining} · ${p.reset} · ${p.freshness}`,
  },
  "format.status.pace-learning": { en: () => "pace learning", ko: () => "속도 학습 중" },
  "format.status.safe-pace": { en: (p) => `${p.pace}× safe pace`, ko: (p) => `안전 속도의 ${p.pace}배` },
  "format.status.burn": {
    en: (p) => `    burn ${p.burn}%/active-h · personal ${p.personal}%/active-h · ${p.pace} · confidence ${p.confidence}`,
    ko: (p) => `    소모 ${p.burn}%/활동시간 · 개인 ${p.personal}%/활동시간 · ${p.pace} · 신뢰도 ${p.confidence}`,
  },
  "format.status.personal-learning": {
    en: (p) => `    personal pace learning (${p.count} samples)`,
    ko: (p) => `    개인 사용 속도 학습 중 (표본 ${p.count}개)`,
  },
  "format.status.reserve-eta": {
    en: (p) => `    safe reserve ETA ${p.date} · ${p.detail} before reset`,
    ko: (p) => `    안전 여유 소진 예상 ${p.date} · 리셋 ${p.detail} 전`,
  },
  "format.status.observation": {
    en: (p) => `    provider reset ${p.date} · source ${p.source} · observed ${p.observed} ago`,
    ko: (p) => `    공급자 리셋 ${p.date} · 소스 ${p.source} · ${p.observed} 전 관측`,
  },
  "format.freshness.fresh": { en: () => "fresh", ko: () => "최신" },
  "format.freshness.stale": { en: () => "stale", ko: () => "지연" },
  "format.freshness.reset_due": { en: () => "reset due", ko: () => "리셋 예정" },
  "format.freshness.unknown": { en: () => "unknown", ko: () => "알 수 없음" },
  "format.confidence.none": { en: () => "none", ko: () => "없음" },
  "format.confidence.low": { en: () => "low", ko: () => "낮음" },
  "format.confidence.medium": { en: () => "medium", ko: () => "보통" },
  "format.confidence.high": { en: () => "high", ko: () => "높음" },
  "format.events.none": { en: () => "No events recorded.", ko: () => "기록된 이벤트가 없습니다." },
  "format.severity.info": { en: () => "info", ko: () => "정보" },
  "format.severity.warning": { en: () => "warning", ko: () => "경고" },
  "format.severity.critical": { en: () => "critical", ko: () => "심각" },
  "format.claude.waiting": {
    en: () => "⏱ Claude quota: waiting for first API response",
    ko: () => "⏱ Claude 한도: 첫 API 응답 대기 중",
  },
  "format.claude.short": { en: () => "5h", ko: () => "5시간" },
  "format.claude.weekly": { en: () => "W", ko: () => "주간" },
  "format.claude.learning": { en: () => "learning", ko: () => "학습 중" },
} satisfies Record<string, Record<Locale, Renderer>>;

export type MessageKey = keyof typeof CATALOG;
export const MESSAGE_KEYS: readonly MessageKey[] = Object.freeze(
  Object.keys(CATALOG) as MessageKey[],
);

export function isMessageKey(value: unknown): value is MessageKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CATALOG, value);
}

export function t(key: MessageKey, params: MessageParams = {}, locale: Locale = DEFAULT_LOCALE): string {
  const entry = CATALOG[key];
  // A missing key is a bug, not a reason to show nothing: surface the key so it
  // is obvious in a screenshot rather than silently empty.
  if (!entry) return key;
  return (entry[locale] ?? entry[DEFAULT_LOCALE])(params);
}

export function windowKindOf(windowSeconds: number | null | undefined): WindowKind {
  if (windowSeconds == null) return "other";
  if (windowSeconds >= 28 * 86_400 && windowSeconds <= 31 * 86_400) return "monthly";
  if (windowSeconds === 7 * 86_400) return "weekly";
  if (windowSeconds === 5 * 3_600) return "five-hour";
  return "other";
}

export function formatDay(timestampMs: number, locale: Locale = DEFAULT_LOCALE): string {
  return new Date(timestampMs).toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", {
    month: locale === "ko" ? "long" : "short",
    day: "numeric",
  });
}
