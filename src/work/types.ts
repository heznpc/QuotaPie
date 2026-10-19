export type WorkProvider = "codex" | "claude";
export type WorkOwner = "local" | "dots";
export interface LocalBeforeSendRecovery { permitId: string; parentExecutionId: string; sourceQuotaTurnId: string }
export type WorkStatus = "waiting" | "running" | "turn-finished" | "objective-completed" | "needs-user-input" | "quota-blocked" | "activity-paused" | "time-budget-ended" | "failed" | "uncertain" | "stopped";
export interface WorkBudget { reservePercent: number; maxUsagePercent: number; targetUsagePercent?: number }
export interface WorkPolicyInput {
  id: string; provider: WorkProvider; account: string; profileKey: string; accountKey: string;
  purpose?: "quota-resume";
  quotaResume?: { turnId: string; stamp: string; waitUntilRecovered?: true; localBeforeSendRecovery?: LocalBeforeSendRecovery };
  nativeSessionId: string; cwd: string; model?: string; prompt: string; objective: string;
  completionCriteria: string[]; dispatchOwner: WorkOwner; enabled: boolean;
  trigger: "quota-ready" | "public-announcement" | "scheduled" | "forecast-probability" | "notify-only";
  resetBucket?: string; resetWithinMinutes: number; budgetByBucket: Record<string, WorkBudget>;
  maxTurns: number; maxDurationSeconds: number; maxTotalDurationSeconds: number;
  expiresAtMs: number; priority: number;
  activitySchedule?: { timeZone: string; days: number[]; start: string; end: string };
  activityMode?: "unrestricted" | "inherit" | "custom";
  expectedWorkMinutes?: number; finishBufferMinutes?: number; earlyResetQuantile?: number;
  startProbability?: number; unknownForecastAction?: "wait" | "notify" | "announcement" | "personal-deadline";
  personalDeadline?: number; usePersonalDeadlineForPlanning?: boolean;
  opportunityMaxAgeMinutes?: number; timingHistoryDays?: number;
  workDeadline?: number; onReset: "stop" | "continue";
}
export interface WorkBaseline { observationId: string; atMs: number; remainingPercent: number; epoch: string }
export interface WorkObservationCoverage {
  firstObservationAtMs: number; lastObservationAtMs: number; minimumRemainingPercent: number;
  currentEpochAccountUsage?: number; observationCount?: number; maxObservationGapMs?: number;
  lastActiveObservationAtMs?: number;
  accountingClosedAtMs?: number;
  lastReset?: { evidence?: "quota-recovery" | "epoch-change" | "allowance-change"; afterMs: number; beforeOrAtMs: number; preResetRemainingPercent: number; preResetAccountUsage?: number };
}
export interface WorkState {
  spentByBucket: Record<string, number>; baselines: Record<string, WorkBaseline>;
  turns: number; totalDurationSeconds: number; status: WorkStatus;
  activeExecutionId: string | null; lastResult?: WorkResult;
  quotaBlockedAtMs?: number; quotaBlockedEpochs?: Record<string, string>;
  observationCoverageByBucket?: Record<string, WorkObservationCoverage>;
  pendingAccountingByBucket?: Record<string, number>;
}
export interface WorkPolicy extends WorkPolicyInput { revision: number; state: WorkState; preferenceSources?: Record<string,string> }
export interface WorkResult {
  status: Exclude<WorkStatus, "waiting" | "running" | "stopped">;
  report?: string; summary?: string; evidenceRefs?: string[]; remainingWork?: string;
  blockingQuestion?: string; completionAssessment?: "machine" | "model-assessed";
  reason?: string; durationSeconds?: number;
}
export interface WorkObservation { quotaAccount?: string; id: string; atMs: number; buckets: Record<string, { remainingPercent: number; epoch: string; atMs?: number; id?: string }> }
export interface WorkForecast {
  id?: string; eventId?: string; actionProbabilityEstimate: number | null;
  quantileAtMs?: number | null; horizonAtMs: number; calibrationStatus?: string;
}
export interface WorkPlanning {
  forecastId?: string; eventId?: string; horizonAtMs: number;
  expectedWorkMinutes: number; expectedWorkSource: "user" | "execution-history" | "turn-limit";
  deadlineAtMs: number | null; deadlineSource: "personal-assumption" | "forecast" | "work-deadline" | null;
  finishAtMs: number | null; startByAtMs: number | null;
}
/** Execution quota ownership is separate from the native conversation owner.
 * Only the collector can create this snapshot; it is never a policy input. */
export interface WorkExecutionTarget {
  account: string; profileKey: string; accountKey: string; identity: string;
  sourceIdentity: string; poolPolicyHash: string;
  selectedAtMs: number; expiresAtMs: number;
  budgetByBucket: Record<string, WorkBudget>;
  baselineByBucket: Record<string, WorkBaseline>;
}
export interface WorkTargetAccounting {
  spentByBucket: Record<string, number>; baselines: Record<string, WorkBaseline>;
  observationCoverageByBucket?: Record<string, WorkObservationCoverage>;
  pendingAccountingByBucket?: Record<string, number>;
}
export interface WorkExecution {
  id: string; policyId: string; policyRevision: number; owner: WorkOwner;
  policySnapshot: WorkPolicy; turnOrdinal: number; claimedAtMs: number;
  dispatchedAtMs?: number; finishedAtMs?: number; result?: WorkResult;
  accountedDurationSeconds?: number; planning?: WorkPlanning;
  executionTarget?: WorkExecutionTarget;
  targetAccounting?: WorkTargetAccounting;
  /** Durable intent/receipt for the existing host's queue. The client message
   * ID correlates a turn; the provider does not deduplicate submissions. */
  hostQueue?: {threadId:string;clientUserMessageId:string;sentAtMs:number;queuedSubmissionId?:string;turnId?:string;
    hostWakeRequestedAtMs?:number;hostWakeAttemptCount?:number;hostWakeStatus?:"sent"|"unavailable";hostWakeReason?:string};
  /** Exact native turn proven by the owned managed process after it stopped. */
  managedTurn?: {threadId:string;turnId:string};
  minimumRemainingByBucket?: Record<string,number>; effectiveReserveByBucket?: Record<string,number>;
  status: "claimed" | "dispatched" | "finished" | "uncertain";
}
export interface LegacyWorkFence {
  id: string; provider: WorkProvider; account: string; accountKey: string;
  profileKey?: string; nativeSessionId?: string; reason: string;
}

export type WorkPreferenceValues = Partial<Pick<WorkPolicyInput,
  "budgetByBucket" | "maxTurns" | "maxDurationSeconds" | "maxTotalDurationSeconds" | "priority" |
  "activityMode" | "activitySchedule" | "expectedWorkMinutes" | "finishBufferMinutes" | "earlyResetQuantile" |
  "startProbability" | "unknownForecastAction" | "personalDeadline" | "usePersonalDeadlineForPlanning" |
  "opportunityMaxAgeMinutes" | "timingHistoryDays">>;
export interface WorkPreferences {
  scope:"global"|"provider"|"account";provider?:WorkProvider;account?:string;revision:number;values:WorkPreferenceValues;
}
