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

// The one list of event kinds that raise an alert. The delivery query and the
// trigger planner both derive from this: when they were written out separately,
// window_changed was added to the planner and not to the query, so the event was
// recorded and then never delivered.
export const ALERTABLE_EVENT_KINDS = [
  "external_relief",
  "allowance_relief",
  "schedule_rebased",
  "paid_usage",
  "credit_topup",
  "window_changed",
] as const satisfies readonly EventKind[];

export type AlertableEventKind = (typeof ALERTABLE_EVENT_KINDS)[number];

export function isAlertableEventKind(kind: string): kind is AlertableEventKind {
  return (ALERTABLE_EVENT_KINDS as readonly string[]).includes(kind);
}

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

// Risk is "will this run dry before it resets", not "how much is left". 10%
// remaining with a reset in ten minutes is safe; 60% remaining that is
// projected to run out three days early is not.
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

// Categorised by what the user can actually do about it. The raw provider
// message travels separately as detail, and no field ever carries a
// credential or token value.
export type CollectionErrorCategory =
  | "auth-required"
  | "auth-expired"
  | "rate-limited"
  | "network"
  | "not-configured"
  | "isolation-unsafe"
  | "provider-error"
  | "no-windows";

// One account can have several sources (claude-oauth, claude-statusline).
// Storing health per source is what stops a failure in one from overwriting
// a recent success in the other.
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

// A configured account never disappears just because it has no snapshots.
// The native UI needs to be able to render an honest empty or error state.
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

// The menu bar title is one conclusion, not a row of provider abbreviations.
// Which conclusion wins is decided here, where it can be tested; the app only
// draws it.
export interface Headline {
  kind: HeadlineKind;
  title: string;
  detail: string | null;
  provider: Provider | null;
  account: string | null;
  bucket: string | null;
}
