import {randomUUID} from "node:crypto";
import type { AppConfig } from "../config";
import type { WindowAnalysis } from "../types";
import { WorkStore } from "./store";
import type { WorkPolicy, WorkPolicyInput, WorkResult, WorkOwner, WorkForecast } from "./types";
import { evaluateWorkAdmission, workObservation, workWindows } from "./admission";

export interface WorkControllerDependencies {
  windows(): WindowAnalysis[];
  inspect(input: WorkPolicyInput): Promise<{profileKey:string;accountKey:string;cwd:string;model?:string}>;
  execute(policy: WorkPolicy, executionId: string, authorized: () => boolean, signal: AbortSignal): Promise<WorkResult>;
  forecast?(policy: WorkPolicy, nowMs: number): WorkForecast | null;
  announcementPublishedAtMs?(policy: WorkPolicy): number | undefined;
  minimumReserveByBucket?(policy: WorkPolicy): Record<string,number>;
  announcement(policy: WorkPolicy): boolean;
  legacyBusy(policy: WorkPolicyInput): boolean;
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
      const observation = workObservation(policy, windows, this.now());
      if (observation) this.store.observe(policy.id, observation);
    }
  }
  admission(policy: WorkPolicy, running = false) {
    if (this.closed || this.deps.legacyBusy(policy)) return {ready:false,reason:"legacy-work-active",timeoutSeconds:0};
    const hold=this.holds.get(policy.id);
    if(!running && hold && this.now()-hold.atMs<30000) return {ready:false,reason:hold.reason,timeoutSeconds:0};
    const execution=running&&policy.state.activeExecutionId?this.store.getExecution(policy.state.activeExecutionId):null;
    const effective=execution?.dispatchedAtMs!==undefined?{...policy,state:{...policy.state,totalDurationSeconds:policy.state.totalDurationSeconds+Math.max(0,(this.now()-execution.dispatchedAtMs)/1000)}}:policy;
    return evaluateWorkAdmission(effective, this.deps.windows(), this.now(), {
      maxAgeMs:this.config.collection.staleAfterSeconds*1000,
      publicAnnouncementEligible:this.deps.announcement(policy), ignoreTrigger:running, running,
      minimumReserveByBucket:this.deps.minimumReserveByBucket?.(policy) ?? {},
      forecast:execution?.planning ? undefined : this.deps.forecast?.(policy,this.now()),
      frozenPlanning:execution?.planning,
      announcementPublishedAtMs:this.deps.announcementPublishedAtMs?.(policy),
      estimatedWorkMinutes:this.estimatedWorkMinutes(policy),
      inheritedActivitySchedules:this.inheritedActivitySchedules(),
    });
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
  async save(input: WorkPolicyInput, expectedRevision:number|null, requestId:string) {
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
    const policy = this.store.save(resolved,expectedRevision,requestId,inherited.effectivePreferences);
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
    const raced=this.store.getClaimRequest(id,owner,revision,requestId);
    if(raced) return raced;
    const latest=this.store.get(id)!;
    if(!this.admission(latest).ready) throw new Error("work-admission-changed");
    const ordered=this.store.list().sort((a,b)=>b.priority-a.priority);
    const position=ordered.findIndex(p=>p.id===id);
    if(ordered.slice(0,position).some(other=>other.provider===latest.provider &&
      (other.account===latest.account||other.accountKey===latest.accountKey||other.profileKey===latest.profileKey) && this.admission(other).ready))
      throw new Error("higher-priority-work");
    const claimed=this.store.claimRequest(id,owner,revision,requestId,this.now());
    const execution=claimed.execution;
    if(execution && !claimed.created) return execution;
    if(!execution) throw new Error("work-already-claimed-or-held");
    const planned=admission;
    if ("planning" in planned && planned.planning) this.store.recordPlanning(execution.id,planned.planning,this.now(),Object.fromEntries(Object.entries(latest.budgetByBucket).map(([bucket,budget])=>[bucket,Math.max(budget.reservePercent,this.deps.minimumReserveByBucket?.(latest)[bucket]??0)])));
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
          this.store.markDispatched(execution.id,this.now());
          dispatched=true;
          const executionPolicy=this.store.get(id)!;
          const limit=this.admission(executionPolicy,true).timeoutSeconds;
          result=await this.deps.execute({...executionPolicy,maxDurationSeconds:Math.min(executionPolicy.maxDurationSeconds,limit)},execution.id,authorized,controller.signal);
        }
      } catch { result={status:dispatched?"uncertain":"activity-paused",reason:"execution-result-unverified"}; }
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
  async close(){this.closed=true;for(const r of this.running.values())r.controller.abort();await this.settle();}
}
