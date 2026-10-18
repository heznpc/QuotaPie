import { randomUUID } from "node:crypto";
import type { QuotaStorage } from "../storage/database";
import type { LegacyWorkFence, WorkExecution, WorkObservation, WorkOwner, WorkPolicy, WorkPolicyInput, WorkResult, WorkPreferences, WorkPreferenceValues } from "./types";

export class WorkRevisionConflict extends Error {
  constructor(readonly current: WorkPolicy | null) { super("work-revision-conflict"); }
}

/** Shared connection and BEGIN IMMEDIATE serialize every adapter's admission. */
export class WorkStore {
  constructor(private readonly storage: QuotaStorage) {
    storage.db.exec(`
      CREATE TABLE IF NOT EXISTS work_preferences (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_policies (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_executions (id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_requests (id TEXT PRIMARY KEY, payload TEXT NOT NULL, response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_dispatch_requests (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_fences (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_execution_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL, value TEXT NOT NULL);
    `);
  }
  preferences(): WorkPreferences[] {
    return this.storage.db.query<{value:string},[]>("SELECT value FROM work_preferences ORDER BY id").all().map(row=>JSON.parse(row.value));
  }
  savePreferences(scope: WorkPreferences["scope"], provider: WorkPreferences["provider"], account: string|undefined, values:WorkPreferenceValues, expectedRevision:number|null):WorkPreferences {
    if (!["global","provider","account"].includes(scope) || (scope!=="global" && !["codex","claude"].includes(provider??"")) || (scope==="account"&&!account?.trim())) throw new Error("work-invalid-preference-scope");
    const allowed=["budgetByBucket","maxTurns","maxDurationSeconds","maxTotalDurationSeconds","priority","activityMode","activitySchedule","expectedWorkMinutes","finishBufferMinutes","earlyResetQuantile","startProbability","unknownForecastAction","personalDeadline","usePersonalDeadlineForPlanning","opportunityMaxAgeMinutes","timingHistoryDays"];
    if (!values || Object.keys(values).some(key=>!allowed.includes(key))) throw new Error("work-invalid-preferences");
    // Reuse policy validation so defaults cannot introduce values a task would reject.
    validate({...{id:"preferences",provider:"codex",account:"default",profileKey:"default",accountKey:"default",nativeSessionId:"default",cwd:"/",prompt:"default",objective:"default",completionCriteria:["default"],dispatchOwner:"local",enabled:false,trigger:"quota-ready",resetWithinMinutes:60,budgetByBucket:{default:{reservePercent:0,maxUsagePercent:1}},maxTurns:1,maxDurationSeconds:1,maxTotalDurationSeconds:1,expiresAtMs:1,priority:0,onReset:"stop"} as WorkPolicyInput,...values});
    const id=JSON.stringify([scope,scope==="global"?null:provider,scope==="account"?account:null]);
    return this.storage.transaction(()=>{
      const row=this.storage.db.query<{value:string},[string]>("SELECT value FROM work_preferences WHERE id=?").get(id);
      const prior:WorkPreferences|null=row?JSON.parse(row.value):null;
      if ((prior?.revision??null)!==expectedRevision) throw new Error("work-revision-conflict");
      const preference:WorkPreferences={scope,provider:scope==="global"?undefined:provider,account:scope==="account"?account:undefined,revision:(prior?.revision??0)+1,values:structuredClone(values)};
      this.storage.db.query("INSERT INTO work_preferences(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(id,JSON.stringify(preference));
      return preference;
    });
  }
  resolvePreferences(input:WorkPolicyInput):{input:WorkPolicyInput;effectivePreferences:Record<string,string>} {
    const applicable=this.preferences().filter(p=>p.scope==="global" || p.provider===input.provider&&(p.scope==="provider"||p.account===input.account))
      .sort((a,b)=>["global","provider","account"].indexOf(a.scope)-["global","provider","account"].indexOf(b.scope));
    let resolved:Record<string,unknown>={};const effectivePreferences:Record<string,string>={};
    for(const preference of applicable) for(const [key,value] of Object.entries(preference.values)) {
      if(key==="budgetByBucket") {
        const budgets=Object.fromEntries(Object.entries(value as NonNullable<WorkPreferenceValues["budgetByBucket"]>).filter(([bucket])=>{
          if(preference.scope!=="global" || Object.hasOwn(input.budgetByBucket??{},bucket)) return true;
          // Global defaults share a table across providers, not a quota namespace.
          // Unknown/legacy bucket names require an explicit task bucket or a
          // provider/account-scoped default; never add a foreign required lane.
          if(input.provider==="claude") return ["five_hour","seven_day"].includes(bucket) ||
            bucket.startsWith("seven_day_") && !!input.model && ["opus","sonnet","haiku"].some(family=>input.model!.toLowerCase().includes(family)&&bucket.includes(family));
          return bucket.startsWith("codex:") || !!input.model && bucket.startsWith(input.model+":");
        }));
        if(!Object.keys(budgets).length) continue;
        resolved[key]={...(resolved[key] as object??{}),...budgets};
      } else resolved[key]=value;
      effectivePreferences[key]=preference.scope;
    }
    for(const [key,value] of Object.entries(input)) if(value!==undefined) {
      if(key==="budgetByBucket") resolved[key]={...(resolved[key] as object??{}),...(value as object)};else resolved[key]=value;
      effectivePreferences[key]="task";
    }
    return {input:resolved as unknown as WorkPolicyInput,effectivePreferences};
  }
  get(id: string): WorkPolicy | null {
    const row = this.storage.db.query<{ value: string }, [string]>("SELECT value FROM work_policies WHERE id=?").get(id);
    return row ? JSON.parse(row.value) : null;
  }
  list(): WorkPolicy[] {
    return this.storage.db.query<{ value: string }, []>("SELECT value FROM work_policies ORDER BY rowid").all().map(r => JSON.parse(r.value));
  }
  advanceRevision(id: string, expectedRevision: number): WorkPolicy {
    return this.storage.transaction(() => {
      const policy = this.get(id);
      if (!policy || policy.revision !== expectedRevision) throw new WorkRevisionConflict(policy);
      policy.revision++;
      this.write(policy);
      return policy;
    });
  }
  private write(policy: WorkPolicy) {
    this.storage.db.query("INSERT INTO work_policies(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(policy.id, JSON.stringify(policy));
  }
  private request(requestId: string, payload: unknown, mutate: () => WorkPolicy): WorkPolicy {
    if (!requestId.trim()) throw new Error("work-request-id-required");
    return this.storage.transaction(() => {
      const encoded = JSON.stringify(payload);
      const prior = this.storage.db.query<{ payload: string; response: string }, [string]>("SELECT payload,response FROM work_requests WHERE id=?").get(requestId);
      if (prior) {
        if (prior.payload !== encoded) throw new Error("work-request-id-reused");
        return JSON.parse(prior.response);
      }
      const policy = mutate();
      this.storage.db.query("INSERT INTO work_requests(id,payload,response) VALUES (?,?,?)").run(requestId, encoded, JSON.stringify(policy));
      return policy;
    });
  }
  save(input: WorkPolicyInput, expectedRevision: number | null, requestId: string, preferenceSources?: Record<string,string>,
    options?: {context?:unknown;saved?(policy:WorkPolicy):void}): WorkPolicy {
    validate(input);
    return this.request(requestId, { action: "save", input, expectedRevision, ...(options?.context === undefined ? {} : {context:options.context}) }, () => {
      const prior = this.get(input.id);
      if ((prior?.revision ?? null) !== expectedRevision) throw new WorkRevisionConflict(prior);
      if (prior?.state.activeExecutionId) {
        const keys = ["provider", "account", "profileKey", "accountKey", "nativeSessionId", "cwd", "model", "prompt", "objective", "completionCriteria", "dispatchOwner", "purpose", "quotaResume"] as const;
        if (keys.some(key => JSON.stringify(input[key]) !== JSON.stringify(prior[key]))) throw new Error("work-active-binding-change");
      }
      if (prior?.state.status === "objective-completed" && input.enabled) throw new Error("work-objective-already-completed");
      const policy: WorkPolicy = { ...input, preferenceSources:preferenceSources ?? prior?.preferenceSources, revision: (prior?.revision ?? 0) + 1,
        state: prior?.state ?? { spentByBucket: {}, baselines: {}, turns: 0, totalDurationSeconds: 0, status: "waiting", activeExecutionId: null } };
      this.write(policy);
      options?.saved?.(policy);
      return policy;
    });
  }
  setEnabled(id: string, enabled: boolean, expectedRevision: number, requestId: string): WorkPolicy {
    return this.request(requestId, { action: "enabled", id, enabled, expectedRevision }, () => {
      const policy = this.get(id);
      if (!policy || policy.revision !== expectedRevision) throw new WorkRevisionConflict(policy);
      if (enabled && ["objective-completed", "uncertain"].includes(policy.state.status)) throw new Error("work-needs-review");
      policy.enabled = enabled;
      policy.revision++;
      if (!enabled && !policy.state.activeExecutionId) policy.state.status = "stopped";
      // This is an explicit reviewed resume, never an automatic retry. Keep the
      // outcome and consumed budgets while allowing newly supplied input/limits.
      if (enabled && ["stopped", "failed", "needs-user-input", "time-budget-ended"].includes(policy.state.status)) policy.state.status = "waiting";
      this.write(policy);
      return policy;
    });
  }
  getExecution(id: string): WorkExecution | null {
    const row = this.storage.db.query<{ value: string }, [string]>("SELECT value FROM work_executions WHERE id=?").get(id);
    return row ? JSON.parse(row.value) : null;
  }
  executions(policyId?: string): WorkExecution[] {
    const rows = policyId === undefined
      ? this.storage.db.query<{ value: string }, []>("SELECT value FROM work_executions ORDER BY rowid").all()
      : this.storage.db.query<{ value: string }, [string]>("SELECT value FROM work_executions WHERE policy_id=? ORDER BY rowid").all(policyId);
    return rows.map(r => JSON.parse(r.value));
  }
  private writeExecution(execution: WorkExecution, event: string, nowMs: number) {
    this.storage.db.query("INSERT INTO work_executions(id,policy_id,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
      .run(execution.id, execution.policyId, JSON.stringify(execution));
    this.storage.db.query("INSERT INTO work_execution_events(execution_id,value) VALUES (?,?)")
      .run(execution.id, JSON.stringify({ event, atMs: nowMs, execution }));
  }
  getClaimRequest(id: string, owner: WorkOwner, revision: number, requestId: string): WorkExecution | null {
    if (!requestId.trim()) throw new Error("work-request-id-required");
    const row = this.storage.db.query<{ value: string }, [string]>("SELECT value FROM work_dispatch_requests WHERE id=?").get(requestId);
    if (!row) return null;
    const prior = JSON.parse(row.value) as { policyId: string; owner: WorkOwner; revision: number; executionId: string };
    if (prior.policyId !== id || prior.owner !== owner || prior.revision !== revision) throw new Error("work-request-id-reused");
    const execution = this.getExecution(prior.executionId);
    if (!execution) throw new Error("work-execution-record-missing");
    return execution;
  }
  claimRequest(id: string, owner: WorkOwner, revision: number, requestId: string, nowMs = Date.now()): { execution: WorkExecution | null; created: boolean } {
    return this.storage.transaction(() => {
      const prior = this.getClaimRequest(id, owner, revision, requestId);
      if (prior) return { execution: prior, created: false };
      const execution = this.claim(id, owner, revision, nowMs);
      if (!execution) return { execution: null, created: false };
      this.storage.db.query("INSERT INTO work_dispatch_requests(id,value) VALUES (?,?)").run(requestId,
        JSON.stringify({ policyId: id, owner, revision, executionId: execution.id }));
      return { execution, created: true };
    });
  }
  claim(id: string, owner: WorkOwner, expectedRevision: number, nowMs = Date.now()): WorkExecution | null {
    return this.storage.transaction(() => {
      const policy = this.get(id);
      if (!policy || policy.revision !== expectedRevision) throw new WorkRevisionConflict(policy);
      if (!policy.enabled || policy.dispatchOwner !== owner || policy.expiresAtMs <= nowMs || (policy.workDeadline !== undefined && policy.workDeadline <= nowMs)
        || policy.state.activeExecutionId || policy.state.turns >= policy.maxTurns || policy.state.totalDurationSeconds >= policy.maxTotalDurationSeconds
        || ["objective-completed", "needs-user-input", "uncertain", "failed", "time-budget-ended", "quota-blocked"].includes(policy.state.status)) return null;
      for (const [bucket, budget] of Object.entries(policy.budgetByBucket)) {
        if ((policy.state.spentByBucket[bucket] ?? 0) >= budget.maxUsagePercent) return null;
        const baseline = policy.state.baselines[bucket];
        if (baseline && baseline.remainingPercent <= budget.reservePercent) return null;
      }
      if (this.executions().some(e => e.status !== "finished" && overlaps(policy, e.policySnapshot))
        || this.fences().some(f => overlaps(policy, f))) return null;
      const execution: WorkExecution = { id: randomUUID(), policyId: id, policyRevision: policy.revision, owner,
        policySnapshot: structuredClone(policy), turnOrdinal: policy.state.turns + 1, claimedAtMs: nowMs, status: "claimed" };
      policy.state.activeExecutionId = execution.id;
      policy.state.status = "running";
      this.write(policy);
      this.writeExecution(execution, "claimed", nowMs);
      return execution;
    });
  }
  recordPlanning(id: string, planning: import("./types").WorkPlanning, nowMs = Date.now(), effectiveReserveByBucket?: Record<string,number>): void {
    const execution = this.getExecution(id);
    if (!execution || execution.status !== "claimed") throw new Error("work-execution-not-claimable");
    execution.planning = structuredClone(planning);
    execution.effectiveReserveByBucket = effectiveReserveByBucket ? structuredClone(effectiveReserveByBucket) : undefined;
    this.writeExecution(execution, "planned", nowMs);
  }
  markDispatched(id: string, nowMs = Date.now()): WorkExecution {
    return this.storage.transaction(() => {
      const execution = this.getExecution(id);
      if (!execution) throw new Error("work-execution-not-found");
      if (execution.status === "dispatched") return execution;
      if (execution.status !== "claimed") throw new Error("work-execution-not-claimable");
      const policy = this.get(execution.policyId)!;
      if (!policy.enabled || policy.revision !== execution.policyRevision || policy.expiresAtMs <= nowMs || (policy.workDeadline !== undefined && policy.workDeadline <= nowMs)) throw new Error("work-policy-changed-before-dispatch");
      execution.status = "dispatched";
      execution.dispatchedAtMs = nowMs;
      policy.state.turns++;
      this.write(policy);
      this.writeExecution(execution, "dispatched", nowMs);
      return execution;
    });
  }
  finish(id: string, result: WorkResult, nowMs = Date.now()): WorkExecution {
    return this.finishInternal(id, result, nowMs, false);
  }
  recordHostQueue(id: string, receipt: NonNullable<WorkExecution["hostQueue"]>): void {
    this.storage.transaction(() => {
      const execution = this.getExecution(id);
      if (!execution || !["dispatched", "uncertain"].includes(execution.status) ||
          execution.policySnapshot.purpose !== "quota-resume" ||
          receipt.threadId !== execution.policySnapshot.nativeSessionId ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.clientUserMessageId) ||
          !Number.isSafeInteger(receipt.sentAtMs) || receipt.sentAtMs < execution.claimedAtMs ||
          [receipt.queuedSubmissionId, receipt.turnId].some(value => value !== undefined &&
            !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)))
        throw new Error("work-host-queue-receipt-invalid");
      const prior = execution.hostQueue;
      if (prior && Object.entries(prior).some(([key, value]) => receipt[key as keyof typeof receipt] !== value))
        throw new Error("work-host-queue-receipt-conflict");
      execution.hostQueue = structuredClone(receipt);
      this.writeExecution(execution, "host-queue", Date.now());
    });
  }
  /** Call only after the adapter proves its owned process stopped or the exact
   * correlated host turn reached a terminal state. */
  reconcile(id: string, result: WorkResult, nowMs = Date.now()): WorkExecution {
    return this.finishInternal(id, result, nowMs, true);
  }
  private finishInternal(id: string, result: WorkResult, nowMs: number, reconcile: boolean): WorkExecution {
    validateResult(result);
    return this.storage.transaction(() => {
      const execution = this.getExecution(id);
      if (!execution) throw new Error("work-execution-not-found");
      if (execution.status === "finished" || (execution.status === "uncertain" && !reconcile)) {
        if (JSON.stringify(execution.result) !== JSON.stringify(result)) throw new Error("work-result-already-recorded");
        return execution;
      }
      const policy = this.get(execution.policyId)!;
      const wasUncertain = execution.status === "uncertain";
      execution.status = result.status === "uncertain" ? "uncertain" : "finished";
      execution.result = structuredClone(result);
      execution.finishedAtMs = nowMs;
      const elapsed = execution.dispatchedAtMs === undefined ? 0 : Math.max(0, (nowMs - execution.dispatchedAtMs) / 1000);
      const accounted = Math.max(elapsed, result.durationSeconds ?? 0, execution.accountedDurationSeconds ?? 0);
      policy.state.totalDurationSeconds += accounted - (execution.accountedDurationSeconds ?? 0);
      execution.accountedDurationSeconds = accounted;
      policy.state.status = result.status;
      policy.state.lastResult = structuredClone(result);
      if (result.status !== "uncertain") policy.state.activeExecutionId = null;
      if (execution.dispatchedAtMs !== undefined) {
        policy.state.pendingAccountingByBucket = Object.fromEntries(Object.keys(policy.budgetByBucket).map(bucket => [bucket, nowMs]));
      }
      if (result.status === "objective-completed") { policy.enabled = false; policy.revision++; }
      else if (policy.purpose === "quota-resume" && policy.enabled) { policy.enabled = false; policy.revision++; }
      if (result.status === "quota-blocked") {
        policy.state.quotaBlockedAtMs = nowMs;
        policy.state.quotaBlockedEpochs = Object.fromEntries(Object.entries(policy.state.baselines).map(([key, value]) => [key, value.epoch]));
      }
      this.write(policy);
      this.writeExecution(execution, wasUncertain ? "reconciled" : "finished", nowMs);
      return execution;
    });
  }
  observe(id: string, observation: WorkObservation): WorkPolicy {
    if (!observation.id || !Number.isFinite(observation.atMs)) throw new Error("work-invalid-observation");
    return this.storage.transaction(() => {
      const policy = this.get(id);
      if (!policy) throw new Error("work-policy-not-found");
      const active = policy.state.activeExecutionId !== null;
      for (const [bucket, sample] of Object.entries(observation.buckets)) {
        if (!policy.budgetByBucket[bucket]) continue;
        percent(sample.remainingPercent);
        if (!sample.epoch) throw new Error("work-observation-epoch-required");
        const atMs = sample.atMs ?? observation.atMs;
        const observationId = sample.id ?? observation.id;
        if (!Number.isFinite(atMs)) throw new Error("work-invalid-observation");
        const prior = policy.state.baselines[bucket];
        if (prior && (atMs <= prior.atMs || prior.observationId === observationId)) continue;
        const pendingThrough = policy.state.pendingAccountingByBucket?.[bucket];
        const chargeUsage = active || (policy.enabled && policy.state.turns > 0) || pendingThrough !== undefined;
        const reset = prior && (prior.epoch !== sample.epoch || sample.remainingPercent > prior.remainingPercent);
        const decrement = prior && !reset ? prior.remainingPercent - sample.remainingPercent : 0;
        if (chargeUsage) {
          const execution = active ? this.getExecution(policy.state.activeExecutionId!) : pendingThrough !== undefined ? this.executions(policy.id).filter(e=>e.dispatchedAtMs!==undefined).at(-1) : null;
          if (execution?.dispatchedAtMs!==undefined && atMs>=execution.dispatchedAtMs) {
            const minima=execution.minimumRemainingByBucket??={};
            if (minima[bucket]===undefined || sample.remainingPercent<minima[bucket]!) {
              minima[bucket]=sample.remainingPercent;
              this.writeExecution(execution,"quota-observed",atMs);
            }
          }
        }
        if (chargeUsage) policy.state.spentByBucket[bucket] = (policy.state.spentByBucket[bucket] ?? 0) + decrement;
        if (chargeUsage) {
          const coverage = policy.state.observationCoverageByBucket ??= {};
          const row = coverage[bucket] ??= { firstObservationAtMs: prior?.atMs ?? atMs, lastObservationAtMs: atMs,
            minimumRemainingPercent: Math.min(prior?.remainingPercent ?? sample.remainingPercent, sample.remainingPercent) };
          row.observationCount = (row.observationCount ?? 0) + 1;
          row.maxObservationGapMs = Math.max(row.maxObservationGapMs ?? 0, atMs - (prior?.atMs ?? atMs));
          row.lastObservationAtMs = atMs;
          row.minimumRemainingPercent = Math.min(row.minimumRemainingPercent, sample.remainingPercent);
          if (active) row.lastActiveObservationAtMs = atMs;
          if (reset && prior) {
            row.lastReset = { evidence:sample.remainingPercent>prior.remainingPercent ? sample.remainingPercent>=99?"quota-recovery":"allowance-change":"epoch-change", afterMs: prior.atMs, beforeOrAtMs: atMs, preResetRemainingPercent: prior.remainingPercent,
              preResetAccountUsage: row.currentEpochAccountUsage ?? 0 };
            row.currentEpochAccountUsage = 0;
          } else row.currentEpochAccountUsage = (row.currentEpochAccountUsage ?? 0) + decrement;
          if (pendingThrough !== undefined && atMs >= pendingThrough) {
            row.accountingClosedAtMs = atMs;
            delete policy.state.pendingAccountingByBucket![bucket];
          }
        }
        policy.state.baselines[bucket] = { observationId, atMs, remainingPercent: sample.remainingPercent, epoch: sample.epoch };
        if (reset && (policy.resetBucket === undefined || bucket === policy.resetBucket) && policy.onReset === "stop") {
          if (policy.enabled) { policy.enabled = false; policy.revision++; }
          if (!policy.state.activeExecutionId) policy.state.status = "stopped";
        }
        if (reset && policy.state.status === "quota-blocked" && atMs > (policy.state.quotaBlockedAtMs ?? 0)) policy.state.status = "waiting";
      }
      this.write(policy);
      return policy;
    });
  }
  fenceLegacy(fence: LegacyWorkFence): void {
    this.storage.transaction(() => {
      this.storage.db.query("INSERT INTO work_fences(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(fence.id, JSON.stringify(fence));
    });
  }
  fences(): LegacyWorkFence[] {
    return this.storage.db.query<{ value: string }, []>("SELECT value FROM work_fences ORDER BY id").all().map(r => JSON.parse(r.value));
  }
  releaseLegacy(id: string): void {
    this.storage.transaction(() => { this.storage.db.query("DELETE FROM work_fences WHERE id=?").run(id); });
  }
}

function overlaps(a: WorkPolicyInput, b: Pick<WorkPolicyInput, "provider" | "account" | "accountKey"> & { profileKey?: string; nativeSessionId?: string }): boolean {
  return a.provider === b.provider && (a.account === b.account || a.accountKey === b.accountKey
    || (!!b.profileKey && a.profileKey === b.profileKey) || (!!b.nativeSessionId && a.nativeSessionId === b.nativeSessionId));
}
function percent(value: number) { if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("work-invalid-percent"); }
function validate(input: WorkPolicyInput) {
  for (const key of ["id", "account", "profileKey", "accountKey", "nativeSessionId", "cwd", "prompt", "objective"] as const) {
    if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`work-required-${key}`);
  }
  if (!["codex", "claude"].includes(input.provider) || !["local", "dots"].includes(input.dispatchOwner)
    || !["quota-ready", "public-announcement", "scheduled", "forecast-probability", "notify-only"].includes(input.trigger) || !["stop", "continue"].includes(input.onReset)
    || typeof input.enabled !== "boolean") throw new Error("work-invalid-policy");
  if (!Array.isArray(input.completionCriteria) || !input.completionCriteria.length || input.completionCriteria.some(c => typeof c !== "string" || !c.trim())) throw new Error("work-completion-criteria-required");
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1) throw new Error("work-invalid-turn-limit");
  if (input.purpose !== undefined && input.purpose !== "quota-resume") throw new Error("work-invalid-purpose");
  if (input.purpose === "quota-resume") {
    const evidence = input.quotaResume;
    if (input.provider !== "codex" || input.dispatchOwner !== "local" || input.trigger !== "quota-ready" || input.maxTurns !== 1 ||
        !evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
        Object.keys(evidence).some(key => !["turnId", "stamp"].includes(key)) ||
        typeof evidence.turnId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(evidence.turnId) ||
        typeof evidence.stamp !== "string" || !evidence.stamp.trim() || evidence.stamp.length > 4096 || /[\u0000-\u001f\u007f]/.test(evidence.stamp))
      throw new Error("work-invalid-quota-resume");
  } else if (input.quotaResume !== undefined) throw new Error("work-invalid-quota-resume");
  for (const value of [input.maxDurationSeconds, input.maxTotalDurationSeconds, input.expiresAtMs]) if (!Number.isFinite(value) || value <= 0) throw new Error("work-invalid-limit");
  if (!Number.isFinite(input.priority) || !Number.isFinite(input.resetWithinMinutes) || input.resetWithinMinutes < 0) throw new Error("work-invalid-policy");
  if (input.workDeadline !== undefined && (!Number.isFinite(input.workDeadline) || input.workDeadline <= 0)) throw new Error("work-invalid-deadline");
  if (!input.budgetByBucket || !Object.keys(input.budgetByBucket).length) throw new Error("work-budgets-required");
  if (input.trigger === "forecast-probability" && (!input.resetBucket || !Object.hasOwn(input.budgetByBucket,input.resetBucket))) throw new Error("work-forecast-bucket-required");
  for (const budget of Object.values(input.budgetByBucket)) {
    percent(budget.reservePercent); percent(budget.maxUsagePercent);
    if (budget.targetUsagePercent !== undefined) { percent(budget.targetUsagePercent); if (budget.targetUsagePercent > budget.maxUsagePercent) throw new Error("work-target-exceeds-limit"); }
  }
  for (const key of ["expectedWorkMinutes", "finishBufferMinutes", "opportunityMaxAgeMinutes", "timingHistoryDays"] as const) {
    if (input[key] !== undefined && (!Number.isFinite(input[key]) || input[key]! < (key === "finishBufferMinutes" ? 0 : 1) || input[key]! > (key === "timingHistoryDays" ? 3650 : 525600))) throw new Error("work-invalid-planning");
  }
  if (input.timingHistoryDays !== undefined && !Number.isInteger(input.timingHistoryDays)) throw new Error("work-invalid-planning");
  if (input.earlyResetQuantile !== undefined && input.earlyResetQuantile >= 1) throw new Error("work-invalid-probability");
  for (const key of ["earlyResetQuantile", "startProbability"] as const) if (input[key] !== undefined && (!Number.isFinite(input[key]) || input[key]! <= 0 || input[key]! > 1)) throw new Error("work-invalid-probability");
  if (input.personalDeadline !== undefined && (!Number.isFinite(input.personalDeadline) || input.personalDeadline <= 0)) throw new Error("work-invalid-deadline");
  if (input.usePersonalDeadlineForPlanning !== undefined && typeof input.usePersonalDeadlineForPlanning !== "boolean") throw new Error("work-invalid-planning");
  if (input.unknownForecastAction === "personal-deadline" && (!input.usePersonalDeadlineForPlanning || input.personalDeadline === undefined)) throw new Error("work-personal-deadline-required");
  if (input.usePersonalDeadlineForPlanning && input.personalDeadline === undefined) throw new Error("work-personal-deadline-required");
  if (input.activityMode !== undefined && !["unrestricted", "inherit", "custom"].includes(input.activityMode)) throw new Error("work-invalid-schedule");
  if (input.activityMode === "custom" && !input.activitySchedule) throw new Error("work-invalid-schedule");
  if (input.unknownForecastAction !== undefined && !["wait", "notify", "announcement", "personal-deadline"].includes(input.unknownForecastAction)) throw new Error("work-invalid-planning");
  if (input.activitySchedule) {
    const schedule = input.activitySchedule;
    if (!Array.isArray(schedule.days) || schedule.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.end)) throw new Error("work-invalid-schedule");
    new Intl.DateTimeFormat("en", { timeZone: schedule.timeZone });
  }
}
function validateResult(result: WorkResult) {
  if (!["turn-finished", "objective-completed", "needs-user-input", "quota-blocked", "activity-paused", "time-budget-ended", "failed", "uncertain"].includes(result.status)) throw new Error("work-invalid-result");
  if (result.durationSeconds !== undefined && (!Number.isFinite(result.durationSeconds) || result.durationSeconds < 0)) throw new Error("work-invalid-duration");
  if (result.status === "turn-finished" && !result.remainingWork?.trim()) throw new Error("work-remaining-work-required");
  if (result.status === "objective-completed" && (!result.evidenceRefs?.length || !result.completionAssessment)) throw new Error("work-completion-evidence-required");
}
