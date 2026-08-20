export type Provider = "codex" | "claude";

export type SourceQuality = "authoritative" | "fallback" | "derived";

export interface QuotaObservation {
  provider: Provider;
  account: string;
  bucket: string;
  label: string;
  windowSeconds: number | null;
  usedPercent: number | null;
  resetsAtMs: number | null;
  observedAtMs: number;
  source: string;
  quality: SourceQuality;
  creditBalance?: number | null;
  resetCreditsAvailable?: number | null;
  metadata?: Record<string, string | number | boolean | null>;
}

export type EventKind =
  | "first_observation"
  | "scheduled_reset"
  | "external_relief"
  | "allowance_relief"
  | "schedule_rebased"
  | "meter_correction"
  | "source_unknown"
  | "source_changed"
  | "paid_usage"
  | "credit_topup"
  | "banked_reset_consumed"
  | "bucket_retired"
  | "window_changed"
  | "out_of_order";

export type Severity = "info" | "warning" | "critical";

export interface QuotaEvent {
  id?: number;
  provider: Provider;
  account: string;
  bucket: string;
  kind: EventKind;
  severity: Severity;
  occurredAtMs: number;
  confidence: "low" | "medium" | "high";
  summary: string;
  details: Record<string, string | number | boolean | null>;
}

export type Freshness = "fresh" | "stale" | "reset_due" | "unknown";

export interface WindowAnalysis {
  provider: Provider;
  account: string;
  bucket: string;
  label: string;
  windowSeconds: number | null;
  source: string;
  quality: SourceQuality;
  freshness: Freshness;
  observedAtMs: number;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAtMs: number | null;
  timeToResetMs: number | null;
  reservePercent: number;
  recentBurnPerHour: number | null;
  personalBurnPerHour: number | null;
  blendedBurnPerHour: number | null;
  safePacePerActiveHour: number | null;
  paceRatio: number | null;
  exhaustsAtMs: number | null;
  minutesBeforeReset: number | null;
  confidence: "none" | "low" | "medium" | "high";
  sampleCount: number;
  activeHoursUntilReset: number | null;
  bottleneckScore: number;
  riskLevel: RiskLevel;
}

// 위험은 "남은 비율"이 아니라 "갱신 전에 마르는가"로 정의한다. 10% 남았어도
// 10분 뒤 갱신이면 안전하고, 60% 남았어도 사흘 먼저 마를 전망이면 위험하다.
export type RiskLevel = "none" | "watch" | "at-risk";

export interface ProviderStatus {
  provider: Provider;
  account: string;
  accountLabel: string;
  windows: WindowAnalysis[];
  bottleneckBucket: string | null;
  updatedAtMs: number | null;
}

export interface TriggerDecision {
  key: string;
  title: string;
  message: string;
  severity: Severity;
  eventId?: number;
  rearmWhenRemainingAbove?: number;
}

export type CollectionHealth =
  | "never-attempted"
  | "attempted-then-failed"
  | "stale-success"
  | "recent-success";

export interface CollectionStateRow {
  provider: Provider;
  account: string;
  lastAttemptMs: number | null;
  lastSuccessMs: number | null;
  lastError: string | null;
}

// 사용자가 실제로 취할 수 있는 행동으로 분류한다. 원문 오류 메시지는 detail로
// 따로 나르고, 자격증명·토큰 값은 어느 필드에도 담지 않는다.
export type CollectionErrorCategory =
  | "auth-required"
  | "auth-expired"
  | "rate-limited"
  | "network"
  | "not-configured"
  | "isolation-unsafe"
  | "provider-error"
  | "no-windows";

// 한 계정에 여러 소스(claude-oauth, claude-statusline)가 붙는다. 소스 단위로
// 저장해야 한쪽 실패가 다른 쪽의 최근 성공을 덮어쓰지 않는다.
export interface CollectionSourceStateRow {
  provider: Provider;
  account: string;
  source: string;
  lastAttemptMs: number | null;
  lastSuccessMs: number | null;
  lastError: string | null;
  lastErrorCategory: CollectionErrorCategory | null;
}

export interface CollectionSourceState {
  source: string;
  health: CollectionHealth;
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  errorCategory: CollectionErrorCategory | null;
  errorDetail: string | null;
}

export interface AccountCollectionState {
  health: CollectionHealth;
  activeSource: string | null;
  lastSuccessAtMs: number | null;
  errorCategory: CollectionErrorCategory | null;
  errorDetail: string | null;
  sources: CollectionSourceState[];
}

// 스냅샷이 하나도 없어도 설정된 계정은 사라지지 않는다. 네이티브 UI가
// 정직한 빈 상태·오류 상태를 그릴 수 있어야 하기 때문이다.
export interface AccountState {
  provider: Provider;
  account: string;
  accountLabel: string;
  enabled: boolean;
  collection: AccountCollectionState;
  windows: WindowAnalysis[];
  bottleneckBucket: string | null;
  updatedAtMs: number | null;
}

export type HeadlineKind = "normal" | "pace-risk" | "degraded" | "setup";

// 메뉴 막대 제목은 공급자 약어 나열이 아니라 결론 하나다. 어떤 결론을 고를지는
// 서버에서 정해 테스트 가능하게 두고, 앱은 그리기만 한다.
export interface Headline {
  kind: HeadlineKind;
  title: string;
  detail: string | null;
  provider: Provider | null;
  account: string | null;
  bucket: string | null;
}
