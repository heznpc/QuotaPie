import type { WindowAnalysis } from "../types";
import type { WorkObservation, WorkPolicy, WorkPolicyInput } from "./types";

export interface WorkAdmissionOptions {
  maxAgeMs?: number;
  publicAnnouncementEligible?: boolean;
  /** A started execution keeps its quota/activity checks, not a past start trigger. */
  ignoreTrigger?: boolean;
  running?: boolean;
  /** Explicit hard account floors, distinct from editable reserve preferences. */
  minimumReserveByBucket?: Record<string, number>;
}
export interface WorkAdmission { ready: boolean; reason: string; windows: WindowAnalysis[]; timeoutSeconds: number }

function general(policy: WorkPolicyInput, window: WindowAnalysis): boolean {
  return policy.provider === "codex" ? window.bucket.startsWith("codex:") : ["five_hour", "seven_day"].includes(window.bucket);
}
export function workWindows(policy: WorkPolicyInput, windows: WindowAnalysis[]): WindowAnalysis[] {
  return windows.filter(window => window.provider === policy.provider && window.account === policy.account && (
    Object.hasOwn(policy.budgetByBucket, window.bucket) || general(policy, window) ||
    (policy.provider === "codex" ? !!policy.model && window.bucket.startsWith(policy.model + ":") :
      window.bucket.startsWith("seven_day_") && (!policy.model || ["opus", "sonnet", "haiku"].some(family => policy.model!.toLowerCase().includes(family) && window.bucket.includes(family))))
  ));
}

export function evaluateWorkAdmission(policy: WorkPolicy, windows: WindowAnalysis[], nowMs = Date.now(), options: WorkAdmissionOptions = {}): WorkAdmission {
  const scoped = workWindows(policy, windows);
  const timeoutSeconds = Math.max(0, Math.min(policy.maxDurationSeconds, policy.maxTotalDurationSeconds - policy.state.totalDurationSeconds,
    (policy.expiresAtMs - nowMs) / 1000, policy.workDeadline === undefined ? Infinity : (policy.workDeadline - nowMs) / 1000));
  const answer = (reason: string): WorkAdmission => ({ ready: reason === "ready", reason, windows: scoped, timeoutSeconds });
  if (!policy.enabled) return answer("disabled");
  if (policy.expiresAtMs <= nowMs || (policy.workDeadline !== undefined && policy.workDeadline <= nowMs)) return answer("expired");
  if (policy.state.totalDurationSeconds >= policy.maxTotalDurationSeconds || timeoutSeconds <= 0) return answer("time-budget-ended");
  // The running turn has already consumed its ordinal and may finish it.
  if (!options.running && policy.state.turns >= policy.maxTurns) return answer("turn-budget-ended");
  if (!options.running && policy.state.activeExecutionId) return answer("work-already-claimed");
  if (["objective-completed", "needs-user-input", "uncertain", "failed", "time-budget-ended"].includes(policy.state.status)) return answer(policy.state.status);
  if (policy.state.status === "quota-blocked") return answer("awaiting-quota-recovery");
  if (!withinActivitySchedule(policy, nowMs)) return answer("activity-paused");
  if (!scoped.some(window => general(policy, window)) || Object.keys(policy.budgetByBucket).some(bucket => !scoped.some(window => window.bucket === bucket))) return answer("quota-unknown");
  // Providers can introduce another general/model window after registration.
  // Never apply it as an unbudgeted lane while an existing run keeps going.
  if (scoped.some(window => !Object.hasOwn(policy.budgetByBucket, window.bucket))) return answer("work-bucket-budget-required");
  const maxAgeMs = options.maxAgeMs ?? 120_000;
  if (scoped.some(window => window.quality !== "authoritative" || window.freshness === "unknown" ||
    window.remainingPercent === null || !Number.isFinite(window.remainingPercent) || window.remainingPercent < 0 || window.remainingPercent > 100 ||
    window.resetsAtMs === null || !Number.isFinite(window.resetsAtMs))) return answer("quota-unknown");
  if (scoped.some(window => window.freshness === "reset_due" || window.resetsAtMs! <= nowMs)) return answer("reset-unconfirmed");
  if (scoped.some(window => window.freshness !== "fresh" || !Number.isFinite(window.observedAtMs) || window.observedAtMs > nowMs || nowMs - window.observedAtMs > maxAgeMs)) return answer("quota-stale");
  for (const window of scoped) {
    // An explicit task reserve, including zero, overrides the account preference.
    // Separate mandatory account restrictions are applied by the service.
    const budget = policy.budgetByBucket[window.bucket];
    const preference = budget?.reservePercent ?? window.reservePercent;
    const mandatory = options.minimumReserveByBucket?.[window.bucket] ?? 0;
    if (!Number.isFinite(mandatory) || mandatory < 0 || mandatory > 100) return answer("quota-unknown");
    const reserve = Math.max(preference, mandatory);
    if (!Number.isFinite(reserve) || reserve < 0 || reserve > 100) return answer("quota-unknown");
    if (window.remainingPercent! <= reserve) return answer("reserve-reached");
    if (budget && (policy.state.spentByBucket[window.bucket] ?? 0) >= budget.maxUsagePercent) return answer("usage-budget-ended");
  }
  if (!options.ignoreTrigger && policy.trigger === "public-announcement" && !options.publicAnnouncementEligible) return answer("awaiting-announcement");
  if (!options.ignoreTrigger && policy.trigger === "scheduled") {
    const reset = scoped.find(window => window.bucket === policy.resetBucket);
    if (!reset || reset.resetsAtMs === null) return answer("quota-unknown");
    if (reset.resetsAtMs - nowMs > policy.resetWithinMinutes * 60_000) return answer("awaiting-reset-window");
  }
  return answer("ready");
}

export function withinActivitySchedule(policy: Pick<WorkPolicyInput, "activitySchedule">, nowMs: number): boolean {
  const schedule = policy.activitySchedule;
  if (!schedule) return true;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(nowMs);
  } catch { return false; }
  const part = (name: string) => parts.find(value => value.type === name)?.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday") ?? "");
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  const parse = (time: string) => { const [h, m] = time.split(":").map(Number); return h! * 60 + m!; };
  const start = parse(schedule.start), end = parse(schedule.end);
  if (start === end) return schedule.days.includes(weekday);
  if (start < end) return schedule.days.includes(weekday) && minute >= start && minute < end;
  return (minute >= start && schedule.days.includes(weekday)) || (minute < end && schedule.days.includes((weekday + 6) % 7));
}

/** Retain each bucket's actual timestamp; mixing snapshots must not freshen one. */
export function workObservation(policy: WorkPolicyInput, windows: WindowAnalysis[], nowMs?: number): WorkObservation | null {
  const scoped = workWindows(policy, windows).filter(window => Object.hasOwn(policy.budgetByBucket, window.bucket)
    && window.quality === "authoritative" && window.freshness === "fresh" && Number.isFinite(window.observedAtMs)
    && (nowMs === undefined || window.observedAtMs <= nowMs)
    && window.remainingPercent !== null && Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100
    && window.resetsAtMs !== null && Number.isFinite(window.resetsAtMs));
  if (!scoped.length) return null;
  const buckets: WorkObservation["buckets"] = {};
  for (const window of scoped) {
    // A changed reset boundary starts a new observation epoch; this is a
    // conservative accounting boundary, not proof of a global public reset.
    const id = `${window.provider}:${window.account}:${window.bucket}:${window.observedAtMs}`;
    buckets[window.bucket] = { remainingPercent: window.remainingPercent!, epoch: String(window.resetsAtMs), atMs: window.observedAtMs, id };
  }
  const atMs = Math.max(...scoped.map(window => window.observedAtMs));
  return { id: `${policy.id}:${atMs}`, atMs, buckets };
}
