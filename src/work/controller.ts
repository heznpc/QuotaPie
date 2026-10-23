import {randomUUID} from "node:crypto";
import type { AppConfig } from "../config";
import type { WindowAnalysis } from "../types";
import { WorkStore } from "./store";
import type { WorkPolicy, WorkPolicyInput, WorkResult, WorkOwner, WorkForecast, WorkExecutionTarget } from "./types";
import { executionQuotaPolicy, validExecutionTarget } from "./execution-target";
import { evaluateWorkAdmission, workObservation, workWindows } from "./admission";

export interface WorkControllerDependencies {
  windows(): WindowAnalysis[];
  inspect(input: WorkPolicyInput): Promise<{profileKey:string;accountKey:string;cwd:string;model?:string}>;
  execute(policy: WorkPolicy, executionId: string, authorized: () => boolean, signal: AbortSignal, executionTarget?: WorkExecutionTarget): Promise<WorkResult>;
  releaseExecutionTarget?(executionId:string,reason:string):void;
  prepareExecutionTarget?(policy: WorkPolicy, executionId: string, target: WorkExecutionTarget, authorized:()=>boolean, signal:AbortSignal): Promise<void>;
  forecast?(policy: WorkPolicy, nowMs: number): WorkForecast | null;
  announcementPublishedAtMs?(policy: WorkPolicy): number | undefined;
  minimumReserveByBucket?(policy: WorkPolicy): Record<string,number>;
  announcement(policy: WorkPolicy): boolean;
  legacyBusy(policy: WorkPolicyInput): boolean;
  /** Selection runs only before a claim. Running executions use their durable target. */
  executionTarget?(policy: WorkPolicy): WorkExecutionTarget | null;
  validateExecutionTarget?(policy: WorkPolicy, target: WorkExecutionTarget): string | null;
  hostGoalBlock?(policy: WorkPolicy, target?: WorkExecutionTarget): string | null;
  beforeDispatch?(policy: WorkPolicy, target?: WorkExecutionTarget): Promise<void>;
  now?: () => number;
}
/** Settings and execution are owned by the collector. Dots is a client of the
 * same controller that the existing local job runner invokes. */
export class WorkController {
  private running = new Map<string, {controller: AbortController; promise: Promise<unknown>}>();
  private closed = false;
  private holds = new Map<string,{reason:string;atMs:number}>();
  private now: () => number;
  constructor(readonly store: WorkStore, readonly config: AppConfig, readonly deps: WorkControllerDependencies) {
    this.now = deps.now ?? Date.now;
  }
  observe() {
    const windows = this.deps.windows();
    for (const policy of this.store.list()) {
      const execution = policy.state.activeExecutionId ? this.store.getExecution(policy.state.activeExecutionId) : this.store.executions(policy.id)
        .filter(e => e.executionTarget && Object.keys(e.targetAccounting?.pendingAccountingByBucket ?? {}).length).at(-1);
      const quota = execution?.executionTarget ? executionQuotaPolicy(policy, execution.executionTarget, execution.targetAccounting) : policy;
      const observation = workObservation(quota, windows, this.now());
      if (observation) this.store.observe(policy.id, observation);
    }
  }
  admission(policy: WorkPolicy, running = false) {
    const execution = policy.state.activeExecutionId ? this.store.getExecution(policy.state.activeExecutionId) : null;
    const target = execution?.executionTarget ?? (!policy.state.activeExecutionId && !running ? this.deps.executionTarget?.(policy) ?? undefined : undefined);
    if (target) {
      if (!validExecutionTarget(policy, target, this.now())) return {ready:false,reason:"execution-target-expired",timeoutSeconds:0};
      const block = this.deps.validateExecutionTarget?.(policy, target) ?? (this.deps.validateExecutionTarget ? null : "execution-target-unverified");
      if (block) return {ready:false,reason:block,timeoutSeconds:0};
    }
    const quota = target ? executionQuotaPolicy(policy, target, execution?.targetAccounting) : policy;
    const goalBlock = this.deps.hostGoalBlock?.(policy, target);
    if (goalBlock) return {ready:false,reason:goalBlock,timeoutSeconds:0};
    if (this.closed || this.deps.legacyBusy(policy) || target && this.deps.legacyBusy(quota)) return {ready:false,reason:"legacy-work-active",timeoutSeconds:0};
    const hold=this.holds.get(policy.id);
    if(!running && hold && this.now()-hold.atMs<30000) return {ready:false,reason:hold.reason,timeoutSeconds:0};
    const effective=execution?.dispatchedAtMs!==undefined?{...quota,state:{...quota.state,totalDurationSeconds:quota.state.totalDurationSeconds+Math.max(0,(this.now()-execution.dispatchedAtMs)/1000)}}:quota;
    // A running turn has passed its start trigger. Quota-ready and scheduled
    // work also do not use public announcements to decide admission.
    const needsAnnouncement = !running && (policy.trigger === "public-announcement" ||
      policy.trigger === "forecast-probability" && policy.unknownForecastAction === "announcement");
    const result = evaluateWorkAdmission(effective, this.deps.windows(), this.now(), {
      maxAgeMs:this.config.collection.staleAfterSeconds*1000,
      publicAnnouncementEligible:needsAnnouncement && this.deps.announcement(policy), ignoreTrigger:running, running,
      minimumReserveByBucket:this.deps.minimumReserveByBucket?.(quota) ?? {},
      forecast:execution?.planning ? undefined : this.deps.forecast?.(policy,this.now()),
      frozenPlanning:execution?.planning,
      announcementPublishedAtMs:needsAnnouncement ? this.deps.announcementPublishedAtMs?.(policy) : undefined,
      estimatedWorkMinutes:this.estimatedWorkMinutes(policy),
      inheritedActivitySchedules:this.inheritedActivitySchedules(),
    });
    return {...result, ...(target ? {executionTarget:target} : {})};
  }
  estimatedWorkMinutes(policy:WorkPolicy):number|undefined {
    const samples=this.store.executions(policy.id).filter(e=>e.status==="finished"&&e.dispatchedAtMs!==undefined&&e.finishedAtMs!==undefined&&e.result?.status!=="failed")
      .map(e=>Math.max(0,(e.finishedAtMs!-e.dispatchedAtMs!)/60000)).filter(n=>n>0).sort((a,b)=>a-b);
    return samples.length?samples[Math.floor(samples.length/2)]:undefined;
  }
  private inheritedActivitySchedules() {
    return (["weekday","weekend"] as const).flatMap(kind=>this.config.profile.workSchedule[kind].map(range=>({
      ...range,timeZone:this.config.profile.timeZone,days:kind==="weekday"?[1,2,3,4,5]:[0,6],
    })));
  }
  list() {
    this.observe();
    return this.store.list().map(p => ({...p, admission:this.admission(p), effectivePreferences:{
      activityMode:p.activityMode??(p.activitySchedule?"custom":"unrestricted"),
      activitySource:p.activityMode==="inherit"?"profile.workSchedule":"task",
      activitySchedules:p.activityMode==="inherit"?this.inheritedActivitySchedules():p.activitySchedule?[p.activitySchedule]:[],
      reserveSource:p.preferenceSources?.budgetByBucket??"task",fieldSources:p.preferenceSources??{},minimumReserveByBucket:this.deps.minimumReserveByBucket?.(p)??{},
    }}));
  }
  async save(input: WorkPolicyInput, expectedRevision:number|null, requestId:string,
    options?: {context?:unknown;saved?(policy:WorkPolicy):void}) {
    const prior=this.store.get(input.id);
    // Resolve the original session model before choosing model-specific defaults.
    // The submitted model is never an override, including when inspection has no
    // model to report: it must not select defaults for an unrelated quota lane.
    const binding = await this.deps.inspect(input);
    const trusted = {...input,...binding,model:binding.model};
    // Defaults are copied at registration. Editing or clearing a saved preference
    // must not silently reintroduce it from a newer global/account default.
    const inherited=expectedRevision===null?this.store.resolvePreferences(trusted):{input:trusted,effectivePreferences:Object.fromEntries(Object.keys(trusted).map(key=>[
      key,prior && JSON.stringify(prior[key as keyof WorkPolicy])===JSON.stringify(trusted[key as keyof WorkPolicyInput])?prior.preferenceSources?.[key]??"task":"task",
    ]))};
    const resolved = {...inherited.input, ...binding,model:binding.model};
    if (resolved.enabled && this.deps.legacyBusy(resolved)) throw new Error("legacy-work-active");
    // Account-wide limits apply to every selected model. A policy must budget
    // each observed window so unbudgeted usage cannot evade the common ledger.
    const windows = this.deps.windows().filter(w=>w.provider===input.provider && w.account===input.account);
    const general = workWindows(resolved,windows);
    if (!general.length || general.some(w=>!resolved.budgetByBucket?.[w.bucket])) throw new Error("work-general-budget-required");
    const policy = this.store.save(resolved,expectedRevision,requestId,inherited.effectivePreferences,options);
    this.holds.delete(policy.id);
    this.observe();
    return this.store.get(policy.id)!;
  }
  async setEnabled(id:string,enabled:boolean,expectedRevision:number,requestId:string) {
    if(typeof enabled!=="boolean") throw new Error("work-invalid-enabled");
    const policy=this.store.get(id);
    if (!policy) throw new Error("work-policy-not-found");
    if (enabled) {
      const binding=await this.deps.inspect(policy);
      if (binding.profileKey!==policy.profileKey || binding.accountKey!==policy.accountKey || binding.cwd!==policy.cwd)
        throw new Error("work-binding-changed");
      if (this.deps.legacyBusy(policy)) throw new Error("legacy-work-active");
    }
    const result=this.store.setEnabled(id,enabled,expectedRevision,requestId);
    this.holds.delete(id);
    if (!enabled && policy.state.activeExecutionId) this.running.get(policy.state.activeExecutionId)?.controller.abort();
    return result;
  }
  interruptPolicy(id: string): void {
    const policy = this.store.get(id);
    if (policy?.state.activeExecutionId) this.running.get(policy.state.activeExecutionId)?.controller.abort();
    this.holds.delete(id);
  }
  async dispatch(id:string, owner:WorkOwner, revision:number, requestId:string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new Error("work-request-id-required");
    // Request-to-claim association is durable; retrying after a dropped HTTP
    // response returns the first record rather than starting another turn.
    const previous=this.store.getClaimRequest(id,owner,revision,requestId);
    if(previous) return previous;
    this.observe();
    const policy=this.store.get(id);
    if(!policy || policy.revision!==revision) throw new Error("work-revision-conflict");
    const admission=this.admission(policy);
    if(!admission.ready) throw new Error(admission.reason);
    const binding=await this.deps.inspect(policy).catch(error=>{
      const reason=error instanceof Error && /^[a-z-]{3,100}$/.test(error.message)?error.message:"work-preflight-unavailable";
      this.holds.set(id,{reason,atMs:this.now()});throw new Error(reason);
    });
    if(binding.profileKey!==policy.profileKey || binding.accountKey!==policy.accountKey || binding.cwd!==policy.cwd || binding.model!==policy.model)
      throw new Error("work-binding-changed");
    await this.deps.beforeDispatch?.(policy, "executionTarget" in admission ? admission.executionTarget : undefined);
    const raced=this.store.getClaimRequest(id,owner,revision,requestId);
    if(raced) return raced;
    const latest=this.store.get(id)!;
    const finalAdmission=this.admission(latest);
    if(!finalAdmission.ready) throw new Error("work-admission-changed");
    const target = "executionTarget" in finalAdmission ? finalAdmission.executionTarget : undefined;
    const ordered=this.store.list().sort((a,b)=>b.priority-a.priority);
    const position=ordered.findIndex(p=>p.id===id);
    if(ordered.slice(0,position).some(other=>other.provider===latest.provider &&
      (other.account===latest.account||other.accountKey===latest.accountKey||other.profileKey===latest.profileKey) && this.admission(other).ready))
      throw new Error("higher-priority-work");
    const claimed=this.store.claimRequest(id,owner,revision,requestId,this.now(),target);
    const execution=claimed.execution;
    if(execution && !claimed.created) return execution;
    if(!execution) throw new Error("work-already-claimed-or-held");
    const planned=finalAdmission;
    const quotaPlanning=target?executionQuotaPolicy(latest,target):latest;
    if ("planning" in planned && planned.planning) this.store.recordPlanning(execution.id,planned.planning,this.now(),Object.fromEntries(Object.entries(quotaPlanning.budgetByBucket).map(([bucket,budget])=>[bucket,Math.max(budget.reservePercent,this.deps.minimumReserveByBucket?.(quotaPlanning)[bucket]??0)])));
    const controller=new AbortController();
    const authorized=()=>{
      this.observe();
      const current=this.store.get(id);
      return !this.closed && !controller.signal.aborted && !!current && current.enabled && current.revision===revision &&
        current.state.activeExecutionId===execution.id && this.admission(current,true).ready;
    };
    const promise=(async()=>{
      let result:WorkResult;
      let dispatched=false;
      try {
        if(!authorized()) result={status:"activity-paused",reason:"dispatch-precondition-changed"};
        else {
          if(execution.executionTarget) {
            if(!this.deps.prepareExecutionTarget) throw new Error("execution-target-relay-unavailable");
            await this.deps.prepareExecutionTarget(this.store.get(id)!,execution.id,execution.executionTarget,authorized,controller.signal);
            if(!authorized()) throw new Error("execution-target-authorization-changed");
          }
          this.store.markDispatched(execution.id,this.now());
          dispatched=true;
          const executionPolicy=this.store.get(id)!;
          const limit=this.admission(executionPolicy,true).timeoutSeconds;
          result=await this.deps.execute({...executionPolicy,maxDurationSeconds:Math.min(executionPolicy.maxDurationSeconds,limit)},execution.id,authorized,controller.signal,execution.executionTarget);
        }
      } catch(error) {
        const reason=error instanceof Error && /^execution-target-[a-z-]{1,80}$/.test(error.message)?error.message:"execution-result-unverified";
        if(!dispatched && execution.executionTarget) {
          this.holds.set(id,{reason,atMs:this.now()});
          this.deps.releaseExecutionTarget?.(execution.id,reason);
          return this.store.releaseUnsentTargetClaim(execution.id,reason,this.now());
        }
        result={status:dispatched?"uncertain":"activity-paused",reason};
      }
      if(!dispatched && execution.executionTarget) {
        this.holds.set(id,{reason:result.reason??"execution-target-authorization-changed",atMs:this.now()});
        this.deps.releaseExecutionTarget?.(execution.id,result.reason??"execution-target-authorization-changed");
        return this.store.releaseUnsentTargetClaim(execution.id,result.reason??"execution-target-authorization-changed",this.now());
      }
      this.observe();
      return this.store.finish(execution.id,result,this.now());
    })().catch(()=>{
      // Keep the durable lease if recording failed; never replay unknown work.
      this.holds.set(id,{reason:"execution-record-unavailable",atMs:this.now()});
    }).finally(()=>this.running.delete(execution.id));
    this.running.set(execution.id,{controller,promise});
    // The durable record is returned promptly. Dots and UI poll the same record.
    return this.store.getExecution(execution.id)!;
  }
  tick() {
    if(this.closed) return;
    this.observe();
    for(const policy of this.store.list().filter(p=>p.dispatchOwner==="local").sort((a,b)=>b.priority-a.priority)) {
      if(!this.admission(policy).ready) continue;
      void this.dispatch(policy.id,"local",policy.revision,randomUUID())
        .catch(()=>undefined);
    }
  }
  async settle(){ await Promise.all([...this.running.values()].map(r=>r.promise)); }
  ownsExecution(id: string): boolean { return this.running.has(id); }
  async close(){this.closed=true;for(const r of this.running.values())r.controller.abort();await this.settle();}
}
