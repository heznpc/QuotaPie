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
}

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
