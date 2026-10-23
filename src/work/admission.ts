import type { WindowAnalysis } from "../types";
import type { WorkObservation, WorkPolicy, WorkPolicyInput, WorkForecast, WorkPlanning } from "./types";
import { workPolicyExpiresAtMs } from "./lifetime";

export interface WorkAdmissionOptions {
  maxAgeMs?: number;
  forecast?: WorkForecast | null;
  frozenPlanning?: WorkPlanning;
  estimatedWorkMinutes?: number;
  announcementPublishedAtMs?: number;
  inheritedActivitySchedules?: NonNullable<WorkPolicyInput["activitySchedule"]>[];
  publicAnnouncementEligible?: boolean;
  /** A started execution keeps its quota/activity checks, not a past start trigger. */
  ignoreTrigger?: boolean;
  running?: boolean;
  /** Explicit hard account floors, distinct from editable reserve preferences. */
  minimumReserveByBucket?: Record<string, number>;
}
export interface WorkAdmission { ready: boolean; reason: string; windows: WindowAnalysis[]; timeoutSeconds: number; planning: WorkPlanning }

function general(policy: WorkPolicyInput, window: WindowAnalysis): boolean {
  return policy.provider === "codex" ? window.bucket.startsWith("codex:") : ["five_hour", "seven_day"].includes(window.bucket);
}

function modelWindow(policy: WorkPolicyInput, window: WindowAnalysis): boolean {
  if (policy.provider !== "codex") return window.bucket.startsWith("seven_day_") && (!policy.model ||
    ["opus", "sonnet", "haiku"].some(family => policy.model!.toLowerCase().includes(family) && window.bucket.includes(family)));
  const limitId = typeof window.metadata?.limitId === "string" ? window.metadata.limitId : window.bucket.split(":")[0];
  const normalModelSlug = typeof window.metadata?.normalModelSlug === "string" && window.metadata.normalModelSlug.length > 0
    ? window.metadata.normalModelSlug : undefined;
  if (!policy.model || policy.model === limitId || policy.model === normalModelSlug) return true;
  // An opaque quota alias without a provider association cannot safely be
  // declared unrelated to an automatic recovery. Fail closed by observing it
  // too, rather than maintaining a guessed alias/model table.
  return policy.purpose === "quota-resume" && normalModelSlug === undefined;
}

export function workWindows(policy: WorkPolicyInput, windows: WindowAnalysis[]): WindowAnalysis[] {
  return windows.filter(window => window.provider === policy.provider && window.account === policy.account && (
    Object.hasOwn(policy.budgetByBucket, window.bucket) || general(policy, window) || modelWindow(policy, window)
  ));
}

export function evaluateWorkAdmission(policy: WorkPolicy, windows: WindowAnalysis[], nowMs = Date.now(), options: WorkAdmissionOptions = {}): WorkAdmission {
  const scoped = workWindows(policy, windows);
  const planning = options.frozenPlanning ?? planWork(policy, nowMs, options);
  const expiresAtMs = workPolicyExpiresAtMs(policy);
  const timeoutSeconds = Math.max(0, Math.min(policy.maxDurationSeconds, policy.maxTotalDurationSeconds - policy.state.totalDurationSeconds,
    (expiresAtMs - nowMs) / 1000, planning.finishAtMs === null ? Infinity : (planning.finishAtMs - nowMs) / 1000));
  const answer = (reason: string): WorkAdmission => ({ ready: reason === "ready", reason, windows: scoped, timeoutSeconds, planning });
  if (!policy.enabled) return answer("disabled");
  if (expiresAtMs <= nowMs || (policy.workDeadline !== undefined && policy.workDeadline <= nowMs)) return answer("expired");
  if (policy.state.totalDurationSeconds >= policy.maxTotalDurationSeconds || timeoutSeconds <= 0) return answer("time-budget-ended");
  // The running turn has already consumed its ordinal and may finish it.
  if (!options.running && policy.state.turns >= policy.maxTurns) return answer("turn-budget-ended");
  if (!options.running && policy.state.activeExecutionId) return answer("work-already-claimed");
  if (["objective-completed", "needs-user-input", "uncertain", "failed", "time-budget-ended"].includes(policy.state.status)) return answer(policy.state.status);
  if (policy.state.status === "quota-blocked") return answer("awaiting-quota-recovery");
  if (policy.activityMode === "inherit" && !(options.inheritedActivitySchedules ?? []).some(schedule => withinActivitySchedule({activitySchedule:schedule}, nowMs))) return answer("activity-paused");
  if (policy.activityMode !== "unrestricted" && policy.activityMode !== "inherit" && !withinActivitySchedule(policy, nowMs)) return answer("activity-paused");
  if (!scoped.some(window => general(policy, window)) || Object.keys(policy.budgetByBucket).some(bucket => !scoped.some(window => window.bucket === bucket))) return answer("quota-unknown");
  if (new Set(scoped.map(window => window.bucket)).size !== scoped.length) return answer("quota-unknown");
  // Providers can introduce another general/model window after registration.
  // Never apply it as an unbudgeted lane while an existing run keeps going.
  if (scoped.some(window => !Object.hasOwn(policy.budgetByBucket, window.bucket))) return answer("work-bucket-budget-required");
  const maxAgeMs = options.maxAgeMs ?? 120_000;
  if (scoped.some(window => window.quality !== "authoritative" || window.freshness === "unknown" ||
    window.remainingPercent === null || !Number.isFinite(window.remainingPercent) || window.remainingPercent < 0 || window.remainingPercent > 100 ||
    window.resetsAtMs === null || !Number.isFinite(window.resetsAtMs))) return answer("quota-unknown");
  if (scoped.some(window => window.freshness === "reset_due" || window.resetsAtMs! <= nowMs)) return answer("reset-unconfirmed");
  if (scoped.some(window => window.freshness !== "fresh" || !Number.isFinite(window.observedAtMs) || window.observedAtMs > nowMs || nowMs - window.observedAtMs > maxAgeMs)) return answer("quota-stale");
  // Explicit provider restrictions take precedence over apparently available
  // percentages. In a newer permission-bearing response, null is unknown,
  // never permission to retry; legacy responses may omit the field entirely.
  if (scoped.some(window => window.metadata?.ordinaryUsageAllowed === false || window.metadata?.spendControlReached === true)) return answer("reserve-reached");
  if (policy.purpose === "quota-resume" && scoped.some(window => window.metadata &&
    Object.hasOwn(window.metadata, "ordinaryUsageAllowed") && window.metadata.ordinaryUsageAllowed !== true)) return answer("quota-unknown");
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
  const announcementEligible = !!options.publicAnnouncementEligible && (policy.opportunityMaxAgeMinutes === undefined || options.announcementPublishedAtMs === undefined || nowMs - options.announcementPublishedAtMs <= policy.opportunityMaxAgeMinutes * 60_000);
  if (!options.ignoreTrigger && policy.trigger === "notify-only") return answer("notification-only");
  if (!options.ignoreTrigger && policy.trigger === "forecast-probability") {
    const probability = options.forecast?.actionProbabilityEstimate;
    if (probability == null || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      if (policy.unknownForecastAction === "personal-deadline") {
        if (!policy.usePersonalDeadlineForPlanning || policy.personalDeadline === undefined || planning.startByAtMs === null) return answer("forecast-personal-deadline-required");
        if (nowMs < planning.startByAtMs) return answer("awaiting-planned-start");
      } else if (policy.unknownForecastAction !== "announcement" || !announcementEligible) return answer(policy.unknownForecastAction === "notify" ? "forecast-unavailable-notify" : "forecast-unavailable");
    } else if (probability < (policy.startProbability ?? 0.8)) return answer("awaiting-forecast-probability");
  }
  if (!options.ignoreTrigger && policy.trigger === "public-announcement" && !announcementEligible) return answer("awaiting-announcement");
  if (!options.ignoreTrigger && policy.trigger === "scheduled") {
    const reset = scoped.find(window => window.bucket === policy.resetBucket);
    if (!reset || reset.resetsAtMs === null) return answer("quota-unknown");
    if (reset.resetsAtMs - nowMs > policy.resetWithinMinutes * 60_000) return answer("awaiting-reset-window");
  }
  return answer("ready");
}

/** Planning changes a deadline, never the forecast probability or quota entitlement. */
export function planWork(policy: WorkPolicyInput, nowMs: number, options: WorkAdmissionOptions = {}): WorkPlanning {
  const expectedWorkMinutes = policy.expectedWorkMinutes ?? options.estimatedWorkMinutes ?? policy.maxDurationSeconds / 60;
  const expectedWorkSource = policy.expectedWorkMinutes !== undefined ? "user" : options.estimatedWorkMinutes !== undefined ? "execution-history" : "turn-limit";
  const horizonAtMs = options.forecast?.horizonAtMs ?? Math.min(policy.workDeadline ?? Infinity, nowMs + (expectedWorkMinutes + (policy.finishBufferMinutes ?? 0)) * 60_000);
  let deadlineAtMs: number | null = policy.workDeadline ?? null;
  let deadlineSource: WorkPlanning["deadlineSource"] = deadlineAtMs === null ? null : "work-deadline";
  // New planning preferences are opt-in. Existing policies keep their original deadline.
  const candidates:Array<{at:number|undefined|null;source:WorkPlanning["deadlineSource"]}> = [
    {at:policy.usePersonalDeadlineForPlanning?policy.personalDeadline:undefined,source:"personal-assumption"},
    {at:policy.earlyResetQuantile!==undefined?options.forecast?.quantileAtMs:undefined,source:"forecast"},
  ];
  for(const candidate of candidates) if(candidate.at!=null&&Number.isFinite(candidate.at)&&(deadlineAtMs===null||candidate.at<deadlineAtMs)) {
    deadlineAtMs=candidate.at;deadlineSource=candidate.source;
  }
  const finishAtMs = deadlineAtMs === null ? null : deadlineAtMs - (policy.finishBufferMinutes ?? 0) * 60_000;
  return {forecastId:options.forecast?.id,eventId:options.forecast?.eventId,horizonAtMs,expectedWorkMinutes,expectedWorkSource,
    deadlineAtMs,deadlineSource,finishAtMs,startByAtMs:finishAtMs === null ? null : finishAtMs - expectedWorkMinutes * 60_000};
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
  return { quotaAccount: policy.account, id: `${policy.id}:${atMs}`, atMs, buckets };
}
