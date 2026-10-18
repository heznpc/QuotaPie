import { createHash } from "node:crypto";
import type { QuotaStorage } from "../storage/database";
import type { WorkPolicy } from "../work/types";
import type { QuotaResumeEvidence } from "./evidence";
import type { CodexThreadTurnSummary } from "../providers/codex-appserver";

export interface AutoResumeAccount { account: string; label: string; profileKey: string | null; accountKey: string | null }
interface Preference {
  account: string; enabled: boolean; enabledAtMs: number; revision: number;
  profileKey: string; accountKey: string; lastScanAtMs: number | null; lastError: string | null;
}
export interface QuotaResumeIncident {
  id: string; account: string; profileKey: string; accountKey: string; authorizationRevision: number;
  threadId: string; projectLabel: string; detectedAtMs: number; evidence: QuotaResumeEvidence;
  state: "waiting" | "skipped" | "needs-review"; reason?: string; policyId: string;
}
export interface AutoResumeDependencies {
  accounts(): AutoResumeAccount[];
  listThreads(account: string, cursor: string | null): Promise<{ data: Array<{id:string;name:string|null;cwd:string;updatedAtMs?:number}>; nextCursor:string|null }>;
  evidence(account: string, threadId: string): Promise<QuotaResumeEvidence | null>;
  latestTurn(account: string, threadId: string): Promise<CodexThreadTurnSummary | null>;
  register(incident: QuotaResumeIncident): Promise<void>;
  policy(id: string): WorkPolicy | null;
  disable(id: string): Promise<void>;
  admissionReason(policy: WorkPolicy): string;
  ownsExecution?(id: string): boolean;
  now?: () => number;
}

/** This is discovery and consent metadata, not a second execution queue.
 * Every inference is claimed and accounted for by the existing WorkStore. */
export class AutoResumeController {
  private scan: Promise<void> | null = null;
  private cursors = new Map<string,string|null>();
  private bindingDisables = new Map<string,Promise<void>>();
  private closed = false;
  private now: () => number;
  constructor(private readonly storage: QuotaStorage, private readonly deps: AutoResumeDependencies) {
    this.now = deps.now ?? Date.now;
    storage.db.exec(`CREATE TABLE IF NOT EXISTS quota_resume_preferences (account TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quota_resume_incidents (id TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  private preference(account: string): Preference | null {
    const row = this.storage.db.query<{value:string},[string]>("SELECT value FROM quota_resume_preferences WHERE account=?").get(account);
    return row ? JSON.parse(row.value) : null;
  }
  private savePreference(p: Preference): void {
    this.storage.db.query("INSERT INTO quota_resume_preferences(account,value) VALUES (?,?) ON CONFLICT(account) DO UPDATE SET value=excluded.value")
      .run(p.account,JSON.stringify(p));
  }
  incidents(): QuotaResumeIncident[] {
    return this.storage.db.query<{value:string},[]>("SELECT value FROM quota_resume_incidents ORDER BY rowid DESC").all().map(row=>JSON.parse(row.value));
  }
  private incident(id: string): QuotaResumeIncident | null {
    const row=this.storage.db.query<{value:string},[string]>("SELECT value FROM quota_resume_incidents WHERE id=?").get(id);
    return row?JSON.parse(row.value):null;
  }
  failedAtMs(id: string): number | null { return this.incident(id)?.evidence.failedAtMs ?? null; }
  private saveIncident(value: QuotaResumeIncident): void {
    this.storage.db.query("INSERT INTO quota_resume_incidents(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
      .run(value.id,JSON.stringify(value));
  }
  private matches(p: Preference): boolean {
    const current=this.deps.accounts().find(a=>a.account===p.account);
    return !!current && !!p.accountKey && current.accountKey===p.accountKey && current.profileKey===p.profileKey;
  }
  private disableRevokedPolicy(id: string): void {
    if(this.bindingDisables.has(id)) return;
    const work=Promise.resolve().then(()=>this.deps.disable(id)).catch(()=>{
      // Consent is already revoked durably. A later poll retries policy cleanup.
    }).finally(()=>this.bindingDisables.delete(id));
    this.bindingDisables.set(id,work);
  }
  private checkedPreference(account: string): Preference | null {
    const p=this.preference(account);
    if(!p?.enabled || this.matches(p)) return p;
    p.enabled=false; p.revision++; p.lastError="account-binding-changed";
    this.savePreference(p); this.cursors.delete(account);
    for(const incident of this.incidents().filter(i=>i.account===account && i.state==="waiting")) {
      incident.state="skipped"; incident.reason="account-binding-changed"; this.saveIncident(incident);
      this.disableRevokedPolicy(incident.policyId);
    }
    return p;
  }
  private revokeChangedBindings(): void {
    const accounts=this.storage.db.query<{account:string},[]>("SELECT account FROM quota_resume_preferences").all();
    for(const row of accounts) this.checkedPreference(row.account);
  }
  private authorized(incident: QuotaResumeIncident): boolean {
    const p=this.checkedPreference(incident.account);
    return !this.closed && incident.state==="waiting" && !!p?.enabled && p.revision===incident.authorizationRevision &&
      this.matches(p) && incident.accountKey===p.accountKey && incident.profileKey===p.profileKey &&
      incident.evidence.failedAtMs>=p.enabledAtMs;
  }
  async setEnabled(account: string, enabled: boolean): Promise<void> {
    if(typeof enabled!=="boolean") throw new Error("auto-resume-invalid-enabled");
    const current=this.deps.accounts().find(a=>a.account===account);
    if(!current) throw new Error("account-unavailable");
    const prior=this.checkedPreference(account);
    if(enabled && (!current.accountKey || !current.profileKey)) throw new Error("account-identity-unavailable");
    if(prior?.enabled===enabled && (!enabled || this.matches(prior))) return;
    const next:Preference={account,enabled,enabledAtMs:this.now(),revision:(prior?.revision??0)+1,
      profileKey:current.profileKey??prior?.profileKey??"",accountKey:current.accountKey??prior?.accountKey??"",lastScanAtMs:null,lastError:null};
    // Revoke permission before any await, so a concurrent discovery/claim loses authorization.
    this.savePreference(next); this.cursors.delete(account);
    for(const incident of this.incidents().filter(i=>i.account===account && i.state==="waiting")) {
      incident.state="skipped"; incident.reason="auto-resume-disabled"; this.saveIncident(incident);
      await this.deps.disable(incident.policyId);
    }
  }
  async skip(id: string): Promise<void> {
    const incident=this.incident(id);
    if(!incident) throw new Error("auto-resume-incident-not-found");
    const policy=this.deps.policy(incident.policyId);
    if(policy?.state.activeExecutionId || (policy?.state.turns??0)>0) throw new Error("auto-resume-already-attempted");
    incident.state="skipped"; incident.reason="skipped"; this.saveIncident(incident);
    await this.deps.disable(incident.policyId);
  }
  /** Synchronous permission check is used throughout the owned turn. */
  blockPolicy(policy: WorkPolicy): string | null {
    if(policy.purpose!=="quota-resume") return null;
    const incident=this.incident(policy.id);
    if(!incident || !this.authorized(incident)) return "auto-resume-disabled";
    if(policy.account!==incident.account || policy.profileKey!==incident.profileKey || policy.accountKey!==incident.accountKey ||
      policy.nativeSessionId!==incident.threadId || policy.quotaResume?.turnId!==incident.evidence.turnId || policy.quotaResume.stamp!==incident.evidence.stamp)
      return "auto-resume-binding-changed";
    return null;
  }
  /** A stale failure must never authorize another message after the user continued. */
  async validatePolicy(policy: WorkPolicy): Promise<void> {
    if(policy.purpose!=="quota-resume") return;
    const block=this.blockPolicy(policy); if(block) throw new Error(block);
    const evidence=await this.deps.evidence(policy.account,policy.nativeSessionId);
    if(this.blockPolicy(policy)) throw new Error("auto-resume-disabled");
    if(!evidence) {
      const latest=await this.deps.latestTurn(policy.account,policy.nativeSessionId);
      if(!latest || latest.turnId===policy.quotaResume?.turnId && latest.status==="failed" && latest.errorCode==="usageLimitExceeded")
        throw new Error("quota-resume-evidence-unavailable");
    }
    if(!evidence || evidence.turnId!==policy.quotaResume?.turnId) {
      const incident=this.incident(policy.id)!;
      incident.state="skipped"; incident.reason="superseded"; this.saveIncident(incident);
      await this.deps.disable(policy.id);
      throw new Error("auto-resume-superseded");
    }
    if(evidence.stamp!==policy.quotaResume.stamp) throw new Error("quota-resume-evidence-changed");
  }
  status() {
    this.revokeChangedBindings();
    const accounts=this.deps.accounts().map(account=>{
      const p=this.preference(account.account);
      return {account:account.account,label:account.label,enabled:p?.enabled??false,enabledAtMs:p?.enabledAtMs??null,
        lastScanAtMs:p?.lastScanAtMs??null,lastError:p?.enabled&&!this.matches(p)?"account-binding-changed":p?.lastError??null};
    });
    const incidents=this.incidents().slice(0,100).map(i=>{
      const policy=this.deps.policy(i.policyId);
      let state:string=i.state,reason=i.reason;
      if(policy?.state.status==="uncertain") {state="needs-review";reason=policy.state.lastResult?.reason;}
      else if(policy?.state.activeExecutionId) {
        state=this.deps.ownsExecution?.(policy.state.activeExecutionId)===false?"needs-review":"running";
        reason=state==="needs-review"?"execution-unverified":undefined;
      }
      else if((policy?.state.turns??0)>0) {
        state=policy?.state.status==="turn-finished"?"resumed":"needs-review";
        reason=policy?.state.lastResult?.reason;
      } else if(i.state==="waiting" && policy) reason=this.deps.admissionReason(policy);
      return {id:i.id,account:i.account,threadId:i.threadId,projectLabel:i.projectLabel,state,reason,detectedAtMs:i.detectedAtMs,policyId:i.policyId};
    });
    return {accounts,incidents};
  }
  private async register(incident: QuotaResumeIncident): Promise<void> {
    if(!this.authorized(incident) || this.deps.policy(incident.policyId)) return;
    try {
      await this.deps.register(incident);
      if(!this.authorized(this.incident(incident.id)!)) await this.deps.disable(incident.policyId);
      else { const fresh=this.incident(incident.id)!; delete fresh.reason; this.saveIncident(fresh); }
    } catch (error) {
      const fresh=this.incident(incident.id);
      if(fresh?.state==="waiting") {
        fresh.reason=error instanceof Error && ["native-writer-present","native-turn-active","host-goal-not-active","host-goal-unavailable"].includes(error.message)
          ? error.message : "registration-unavailable";
        this.saveIncident(fresh);
      }
    }
  }
  poll(): Promise<void> {
    if(this.scan) return this.scan;
    if(this.closed) return Promise.resolve();
    this.scan=this.pollOnce().finally(()=>{this.scan=null;});
    return this.scan;
  }
  private async pollOnce(): Promise<void> {
    this.revokeChangedBindings();
    for(const incident of this.incidents().filter(i=>i.state==="skipped" && i.reason==="account-binding-changed"))
      if(this.deps.policy(incident.policyId)?.enabled) this.disableRevokedPolicy(incident.policyId);
    await Promise.all(this.bindingDisables.values());
    for(const account of this.deps.accounts()) {
      const preference=this.checkedPreference(account.account);
      if(!preference?.enabled || !this.matches(preference) || this.closed) continue;
      try {
        for(const incident of this.incidents().filter(i=>i.account===account.account && i.state==="waiting" && !this.deps.policy(i.policyId)))
          await this.register(incident);
        // Always inspect the newest page. An old pagination cursor must not
        // delay a newly blocked conversation behind weeks of historical pages.
        const latestPage=await this.deps.listThreads(account.account,null);
        const cursor=this.cursors.get(account.account);
        const historyPage=cursor ? await this.deps.listThreads(account.account,cursor) : null;
        const lastPage=historyPage??latestPage;
        const oldest=lastPage.data.at(-1);
        this.cursors.set(account.account,oldest?.updatedAtMs!==undefined && oldest.updatedAtMs+1000<preference.enabledAtMs ? null : lastPage.nextCursor);
        const threads=[...new Map([...latestPage.data,...(historyPage?.data??[])].map(t=>[t.id,t])).values()];
        for(const thread of threads) {
          const current=this.checkedPreference(account.account);
          if(this.closed || !current?.enabled || current.revision!==preference.revision || !this.matches(current)) break;
          if(thread.updatedAtMs!==undefined && thread.updatedAtMs+1000<preference.enabledAtMs) continue;
          const evidence=await this.deps.evidence(account.account,thread.id);
          if(!evidence || evidence.failedAtMs<preference.enabledAtMs || evidence.failedAtMs>this.now()) continue;
          const id="quota-resume-"+createHash("sha256").update(JSON.stringify([preference.profileKey,preference.accountKey,thread.id,evidence.turnId])).digest("hex").slice(0,48);
          if(this.incident(id)) continue;
          const label=(thread.name?.trim() || thread.cwd.split("/").filter(Boolean).at(-1) || "ChatGPT").replace(/[\u0000-\u001f\u007f]/g," ").slice(0,160);
          const incident:QuotaResumeIncident={id,policyId:id,account:account.account,profileKey:preference.profileKey,accountKey:preference.accountKey,
            authorizationRevision:preference.revision,threadId:thread.id,projectLabel:label,detectedAtMs:this.now(),evidence,state:"waiting"};
          if(!this.authorized(incident)) continue;
          this.saveIncident(incident);
          await this.register(incident);
        }
        const latest=this.preference(account.account);
        if(latest?.revision===preference.revision) {latest.lastScanAtMs=this.now();latest.lastError=null;this.savePreference(latest);}
      } catch {
        const latest=this.preference(account.account);
        if(latest?.revision===preference.revision) {latest.lastScanAtMs=this.now();latest.lastError="scan-unavailable";this.savePreference(latest);}
      }
    }
  }
  async close(): Promise<void> { this.closed=true; await this.scan; await Promise.all(this.bindingDisables.values()); }
}
