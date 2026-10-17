import { inspectManagedSession } from "./dots/managed-continuation";
import { planWork, workWindows as scopedWorkWindows } from "./work/admission";
import { evaluateWorkPerformance } from "./work/performance";
import { realpathSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { WorkStore } from "./work/store";
import { WorkController } from "./work/controller";
import { inspectWorkTarget, executeWorkTurn } from "./work/runtime";
import { executeCodexWork } from "./work/codex";
import type { WorkPolicyInput, WorkPolicy, WorkForecast } from "./work/types";
import { AccountBindingStore } from "./storage/account-binding-store";
import { HostGoalLinkStore, HostGoalLinkError, WorkHostGoalLinkStore, projectHostGoal,
  type HostGoalLink, type HostGoalLinkSummary, type HostGoalSnapshot, type WorkHostGoalLink } from "./host-goals";
import { readPoolPolicy } from "./account-pool";
import { explicitAccountReserve } from "./subscription-policy";
import { RecentWorkIndex, type RecentWorkSummary } from "./recent-work";
import { evaluateResumeGate, evaluateResumeWindows, resumeProfileKey } from "./resume-gate";
import { codexAccountDisplay } from "./account-display";
import { notificationAllowed, type NotificationPreferencesPatch } from "./notification-preferences";
import { buildWorkBoundary, defaultWorkBoundaryPath, writeWorkBoundary } from "./work-boundary";
import { JobStore } from "./storage/job-store";
import { ManagedJobRunner } from "./jobs/runner";
import { resetOpportunities, resetSignalClosed } from "./signals/opportunities";
import { ResetTimingStore } from "./storage/reset-timing-store";
import { buildResetTracking } from "./signals/correlation";
import { codexContextChange } from "./domain/codex-context";
import { ResetSignalStore } from "./storage/reset-signal-store";
import { ResetSignalCollector } from "./signals/collector";
import { signalDecision } from "./signals/presentation";
import { analyzeWindow, analysisHistoryStart, buildHeadline, groupStatuses } from "./analytics";
import { buildQuotaBoundary, cachedLeaderboard, collectionHealth, defaultBoundaryPath, writeQuotaBoundary } from "./boundary";
import type { AppConfig, CodexAccountConfig } from "./config";
import { codexProfileRoot, codexUsesFileCredentials, resolveUserPath } from "./config";
import { QuotaDatabase } from "./db";
import { selectClaudeConsensus } from "./domain/claude-consensus";
import { AlertStore } from "./storage/alert-store";
import { ClaudeSessionStore } from "./storage/claude-session-store";
import { CollectionStore } from "./storage/collection-store";
import type { QuotaStorage } from "./storage/database";
import { ResumeTaskStore, ResumeTaskStoreError } from "./storage/resume-task-store";
import { CodexAppServerClient, CodexSnapshotUnavailableError, CodexGoalUnsupportedError } from "./providers/codex-appserver";
import { ClaudeUsageError, fetchClaudeUsage, mapClaudeUsage, readClaudeCredentialsAsync } from "./providers/claude-oauth";
import { claudeProfileEnvironment } from "./providers/claude-profile";
import { resolveLocale, t } from "./i18n";
import type { Locale } from "./i18n";
import { nextWakeDelayMs } from "./scheduler";
import { alertScope, deliverTrigger, notificationAccountParams, planTriggers } from "./triggers";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  findClaudeResumeTarget,
  findCodexResumeTarget,
  normalizeSessionId,
  resumeTaskKey,
  resumeWorkingDirectoryAvailable,
} from "./session-discovery";
import { MACOS_NOTIFICATION_CHANNEL } from "./types";
import type {
  AccountState,
  AppNotificationClaim,
  AppNotificationDisposition,
  CollectionHealth,
  CollectionSourceState,
  Headline,
  Provider,
  ProviderStatus,
  QuotaEvent,
  QuotaObservation,
  ResumePlan,
  ResumeTask,
  ResumeTaskSummary,
  TriggerDecision,
  WindowAnalysis,
} from "./types";

export interface RegisterResumeTaskInput {
  provider: Provider;
  account?: string;
  nativeId: string;
  cwd?: string;
  projectLabel?: string;
  bucket?: string;
}

export class ResumeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeTargetError";
  }
}

export const CLAUDE_OAUTH_SOURCE = "claude-oauth";
export const CLAUDE_STATUSLINE_SOURCE = "claude-statusline";
export const CODEX_SOURCE = "codex-appserver";

const HEALTH_RANK: Record<CollectionHealth, number> = {
  "recent-success": 3,
  "stale-success": 2,
  "attempted-then-failed": 1,
  "never-attempted": 0,
};

// When both sources succeeded recently, which one is shown as active is not
// a matter of taste: it has to match the authority applied to the history.
// If the order values are accepted in differs from the order they are
// displayed in, the UI reports the wrong collection path.
const SOURCE_AUTHORITY: Record<string, number> = {
  [CLAUDE_OAUTH_SOURCE]: 2,
  [CODEX_SOURCE]: 2,
  [CLAUDE_STATUSLINE_SOURCE]: 1,
};

export interface ServiceBoundaryPaths {
  /** Explicit destinations; null disables this export. Relative paths bind now. */
  workState?: string | null;
  quota?: string | null;
}

export class QuotaPieService {
  readonly recentWork = new RecentWorkIndex();
  private recentWorkSnapshot: RecentWorkSummary[] = [];
  private recentWorkRefresh: Promise<void> | null = null;
  private recentWorkUpdatedAtMs = -Infinity;
  private recentWorkState: "loading" | "ready" | "error" = "loading";
  readonly db: QuotaDatabase;
  readonly storage: QuotaStorage;
  readonly alerts: AlertStore;
  readonly collection: CollectionStore;
  readonly claudeSessions: ClaudeSessionStore;
  readonly resumeTasks: ResumeTaskStore;
  readonly hostGoalLinks: HostGoalLinkStore;
  readonly workHostGoalLinks: WorkHostGoalLinkStore;
  private goalClients = new Map<string, CodexAppServerClient>();
  private hostGoalRefresh: Promise<void> | null = null;
  private goalLinkReads = new Map<string, Promise<void>>();
  readonly jobs: JobStore;
  readonly jobRunner: ManagedJobRunner;
  readonly work: WorkController;
  private jobsEnabled = false;
  private jobNotifications: Promise<void> | null = null;
  readonly resetSignals: ResetSignalStore;
  readonly resetTiming: ResetTimingStore;
  private resetTimingError: string | null = null;
  private readonly workForecastCache = new Map<string, { expiresAtMs: number; forecast: WorkForecast | null }>();
  readonly signalCollector: ResetSignalCollector;
  private signalTimer: ReturnType<typeof setInterval> | null = null;
  private signalWork: Promise<void> | null = null;
  private codexClients = new Map<string, CodexAppServerClient>();
  private codexAccountNames = new Map<string, string>();
  private stopped = false;
  private closing = false;
  private nativeNotificationTransportAvailable = false;
  private codexPollState = new Map<string, { count: number; error: string | null }>();
  private claudeOAuthLastPollMs = new Map<string, number>();
  // The official usage endpoint is rate limited on the provider side, so this
  // polls more loosely than Codex does.
  static readonly CLAUDE_OAUTH_MIN_INTERVAL_MS = 5 * 60_000;

  readonly locale: Locale;
  private readonly accountBindings: AccountBindingStore;
  private readonly workBoundaryPath: string | null;
  private readonly quotaBoundaryPath: string | null;

  constructor(
    readonly config: AppConfig,
    database?: QuotaDatabase,
    boundaryPaths: ServiceBoundaryPaths = {},
  ) {
    this.db = database ?? new QuotaDatabase();
    // An injected memory/fixture database does not own the installed app's
    // exports. Capture destinations once, before asynchronous collection; a
    // later process environment change must not redirect this service's writes.
    const filename = this.db.db.filename;
    const databaseRoot = filename && filename !== ":memory:" ? dirname(resolve(filename)) : null;
    const bindPath = (specified: string | null | undefined, fallback: string | null): string | null => {
      const path = specified === undefined ? fallback : specified;
      if (path === null) return null;
      if (!path.trim()) throw new Error("Boundary destination must be a non-empty path or null");
      return resolve(path);
    };
    this.workBoundaryPath = bindPath(boundaryPaths.workState, database
      ? databaseRoot ? join(databaseRoot, "work-state.json") : null : defaultWorkBoundaryPath());
    this.quotaBoundaryPath = bindPath(boundaryPaths.quota, database
      ? databaseRoot ? join(databaseRoot, "quota.json") : null : defaultBoundaryPath());
    // One connection, several collaborators. The service depends on each of
    // them directly rather than reaching through the database for everything.
    this.storage = this.db.storage;
    this.accountBindings = new AccountBindingStore(this.storage);
    this.alerts = new AlertStore(this.storage);
    this.collection = new CollectionStore(this.storage);
    this.claudeSessions = new ClaudeSessionStore(this.storage);
    this.resumeTasks = new ResumeTaskStore(this.storage);
    this.hostGoalLinks = new HostGoalLinkStore(this.storage);
    this.workHostGoalLinks = new WorkHostGoalLinkStore(this.storage);
    this.jobs = new JobStore(this.storage);
    this.work = new WorkController(new WorkStore(this.storage), config, {
      windows: () => this.workWindows(),
      inspect: p => this.inspectWork(p),
      execute: (p,id,authorized,signal) => {
        const planning = this.work.store.executions().find(e => e.id === id)?.planning;
        if (planning?.forecastId) this.resetTiming.recordExecutionDecision(planning.forecastId, p.revision, Date.now());
        return p.provider === "claude"
          ? executeWorkTurn(config,p,{claimId:id,policyRevision:p.revision,timeoutMs:p.maxDurationSeconds*1000,signal,stillAuthorized:authorized})
          : executeCodexWork(config,p,id,authorized,()=>this.workGate(p));
      },
      announcement: p => this.workOpportunity(p) !== undefined,
      announcementPublishedAtMs: p => {
        const opportunity = this.workOpportunity(p);
        return opportunity?.calendarBoundaryMs != null ? undefined : opportunity?.publishedAtMs;
      },
      forecast: (p, now) => this.workForecast(p, now),
      minimumReserveByBucket: p => Object.fromEntries(this.workWindows().filter(w => w.provider === p.provider && w.account === p.account)
        .map(w => [w.bucket, p.provider === "codex" ? explicitAccountReserve(p.account, readPoolPolicy()) : 0])),
      legacyBusy: p => this.legacyWorkBusy(p),
      hostGoalBlock: p => this.workHostGoalBlock(p),
      beforeDispatch: async p => {
        const link = this.workHostGoalLinks.get(p.id);
        if (link) await this.readWorkHostGoalLink(link);
      },
    });
    this.jobRunner = new ManagedJobRunner(this.jobs, config, {
      work: this.work,

      changed: () => { void this.deliverJobNotifications().catch(() => undefined); },
    });
    this.locale = resolveLocale(config.profile.locale);
    this.resetSignals = new ResetSignalStore(this.storage);
    this.resetTiming = new ResetTimingStore(this.storage);
    this.signalCollector = new ResetSignalCollector(this.resetSignals, config.resetSignals);
    if (!config.alerts.enabled || !config.alerts.macOSNotifications) {
      this.alerts.cancelAllAppNotifications();
    }
  }

  private workWindows(): WindowAnalysis[] {
    // Execution gates need the latest quota evidence, not historical burn-rate
    // analysis. Re-read it on every check so new/stale limits still take effect.
    return this.currentQuotaWindows(Date.now()).map(w => w.provider === "codex"
      ? {...w,reservePercent:Math.max(0,explicitAccountReserve(w.account,readPoolPolicy()))} : w);
  }
  private legacyWorkBusy(p: WorkPolicyInput): boolean {
    if(this.jobs.active().some(j=>j.spec.provider===p.provider && (j.spec.account===p.account || j.spec.profileKey===p.profileKey ||
      (p.provider==="codex" && this.config.accounts.codex.some(a=>a.id===j.spec.account && this.accountBindings.identityKey(codexProfileRoot(a))===p.accountKey))))) return true;
    const file=this.storage.db.filename;
    if(!file || file===":memory:") return false;
    const path=join(dirname(file),"dots.sqlite");
    if(!existsSync(path) || p.provider!=="codex") return false;
    let db:Database|undefined;
    try {
      db=new Database(path,{readonly:true});
      return db.query<{state:string},[]>("SELECT state FROM targets").all().some(row=>{
        const s=JSON.parse(row.state);
        return (s.policy.enabled || s.claimed) && (s.policy.account===p.account || s.policy.accountKey===p.accountKey);
      });
    } catch {return true;} finally {db?.close();}
  }
  private async inspectWork(p: WorkPolicyInput) {
    if(p.provider==="claude") return inspectWorkTarget(this.config,p);
    if(p.provider!=="codex") throw new Error("work-provider-unsupported");
    const profile=this.config.accounts.codex.find(a=>a.id===p.account&&a.enabled);
    if(!profile) throw new Error("account-unavailable");
    const plan=await this.buildResumePlan({provider:p.provider,account:p.account,taskKey:resumeTaskKey(p.provider,p.account,p.nativeSessionId)});
    const profileKey=resumeProfileKey(this.config,p.provider,p.account);
    const accountKey=this.accountBindings.identityKey(codexProfileRoot(profile));
    if(!profileKey||!accountKey) throw new Error("account-identity-unavailable");
    const original=inspectManagedSession(this.config,{account:p.account,threadId:p.nativeSessionId});
    if(original.cwd!==realpathSync(plan.workingDirectory)) throw new Error("thread-workspace-changed");
    return {profileKey,accountKey,cwd:original.cwd,model:original.model};
  }
  private workGate(p: WorkPolicy) {
    const nowMs=Date.now();
    const gate=this.resumeGate(p.provider,p.account,nowMs);
    const windows=scopedWorkWindows(p,this.workWindows());
    const state=this.accountStates(nowMs,windows).find(s=>s.provider===p.provider&&s.account===p.account);
    const scoped=state?{...state,windows:windows.map(w=>({...w,reservePercent:Math.max(w.reservePercent,p.budgetByBucket[w.bucket]?.reservePercent??0)}))}:undefined;
    return {...evaluateResumeGate(scoped,p.provider,p.account,nowMs,this.config.collection.staleAfterSeconds*1000),
      profileKey:gate.profileKey,accountKey:gate.accountKey,validUntilMs:gate.validUntilMs};
  }
  workStatus() {
    const accounts=this.accountStates().filter(a=>a.provider==="codex"||a.provider==="claude").map(a=>({
      provider:a.provider,account:a.account,label:a.accountLabel,buckets:a.windows.map(w=>w.bucket),
      reserveByBucket:Object.fromEntries(a.windows.map(w=>[w.bucket,w.reservePercent])),
    }));
    const executions=this.work.store.executions();
    return {policies:this.work.list().map(p=>({...p,hostGoal:this.workHostGoalStatus(p),performance:evaluateWorkPerformance(p,executions)})),executions:executions.slice(-200),accounts,defaults:{timeZone:this.config.profile.timeZone}};
  }
  resetAutomationStatus(nowMs = Date.now()) {
    const policies = this.work.store.list();
    return (["codex", "claude"] as const).filter(provider => this.config.accounts[provider].some(a => a.enabled)).map(provider => {
      const registered = policies.filter(p => p.provider === provider && p.trigger !== "notify-only");
      const enabled = registered.filter(p => p.enabled && p.expiresAtMs > nowMs &&
        (p.workDeadline === undefined || p.workDeadline > nowMs));
      const runningCount = registered.filter(p => p.state.activeExecutionId !== null).length;
      return { provider, registeredCount: registered.length, enabledCount: enabled.length, runningCount,
        state: runningCount ? "running" : enabled.length ? "waiting" : "not-configured" };
    });
  }
  async workTargets(provider:string,account:string) {
    const summaries=(await this.recentWork.summaries(this.config)).filter(s=>s.provider===provider&&s.account===account).slice(0,30);
    const targets=[];
    for(const s of summaries) {
      try {
        const plan=await this.buildResumePlan({provider:s.provider,account:s.account,taskKey:s.id});
        targets.push({nativeSessionId:plan.arguments.at(-1)!,title:s.projectLabel,cwd:plan.workingDirectory,lastActiveAtMs:s.lastActiveAtMs});
      }catch{}
    }
    return {targets};
  }

  private workGoalBinding(policy: WorkPolicyInput): string {
    return createHash("sha256").update(JSON.stringify([policy.provider, policy.account, policy.profileKey,
      policy.accountKey, policy.nativeSessionId])).digest("hex");
  }

  private workGoalAccountMatches(policy: WorkPolicyInput): boolean {
    if (policy.provider !== "codex") return false;
    const profile = this.config.accounts.codex.find(p => p.id === policy.account && p.enabled);
    return !!profile && policy.profileKey === resumeProfileKey(this.config, "codex", policy.account) &&
      policy.accountKey === this.accountBindings.identityKey(codexProfileRoot(profile));
  }

  async previewWorkHostGoal(provider: string, account: string, nativeId: string): Promise<HostGoalSnapshot> {
    if (provider !== "codex") throw new HostGoalLinkError("work-host-goal-codex-only");
    let threadId: string;
    try { threadId = normalizeSessionId(nativeId); } catch { throw new HostGoalLinkError("work-host-goal-session-invalid"); }
    const profile = this.config.accounts.codex.find(p => p.id === account && p.enabled);
    if (!profile) throw new HostGoalLinkError("work-host-goal-account-unavailable");
    const accountKey = this.accountBindings.identityKey(codexProfileRoot(profile));
    const profileKey = resumeProfileKey(this.config, "codex", account);
    const same = () => !!accountKey && !!profileKey && this.config.accounts.codex.includes(profile) && profile.enabled &&
      accountKey === this.accountBindings.identityKey(codexProfileRoot(profile)) &&
      profileKey === resumeProfileKey(this.config, "codex", account);
    const empty = (readState: HostGoalSnapshot["readState"]): HostGoalSnapshot =>
      ({readState, objective:null, hostStatus:null, observedAtMs:null, expiresAtMs:null});
    if (!same()) return empty("account_changed");
    try {
      const client = this.goalClient(profile);
      const target = await findCodexResumeTarget(client, account, resumeTaskKey("codex", account, threadId));
      if (!target || target.nativeId !== threadId) throw new Error("session-unavailable");
      const goal = await client.readThreadGoal(threadId);
      if (goal && goal.threadId !== threadId) throw new Error("session-mismatch");
      if (!same()) return empty("account_changed");
      const now = Date.now();
      return {readState:goal ? "ready" : "no_goal", objective:goal?.objective ?? null, hostStatus:goal?.status ?? null,
        observedAtMs:now, expiresAtMs:now + this.config.collection.staleAfterSeconds * 1000};
    } catch (error) {
      return empty(!same() ? "account_changed" : error instanceof CodexGoalUnsupportedError ? "unsupported" : "error");
    }
  }

  workHostGoalStatus(policy: WorkPolicy, nowMs = Date.now()): HostGoalSnapshot | null {
    const link = this.workHostGoalLinks.get(policy.id);
    if (!link) return null;
    const matches = link.binding_key === this.workGoalBinding(policy) && link.thread_id === policy.nativeSessionId && this.workGoalAccountMatches(policy);
    const snapshot = projectHostGoal(link, matches, nowMs, this.config.collection.staleAfterSeconds * 1000);
    return {...snapshot, objectiveChanged:matches && link.linked_objective != null && link.objective != null && link.linked_objective !== link.objective};
  }

  private workHostGoalBlock(policy: WorkPolicy): string | null {
    const goal = this.workHostGoalStatus(policy);
    if (!goal) return null;
    if (goal.readState !== "ready") return "host-goal-" + goal.readState.replaceAll("_", "-");
    if (goal.objectiveChanged) return "host-goal-objective-changed";
    return goal.hostStatus === "active" || goal.hostStatus === "usageLimited" ? null :
      "host-goal-" + (goal.hostStatus === "budgetLimited" ? "budget-limited" : goal.hostStatus ?? "unknown");
  }

  private serializeGoalRead(key: string, read: () => Promise<void>): Promise<void> {
    const previous = this.goalLinkReads.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(read);
    this.goalLinkReads.set(key, next);
    void next.finally(() => { if (this.goalLinkReads.get(key) === next) this.goalLinkReads.delete(key); }).catch(() => {});
    return next;
  }

  private readWorkHostGoalLink(link: WorkHostGoalLink): Promise<void> {
    return this.serializeGoalRead("work:" + link.task_id, () => this.readWorkHostGoalLinkOnce(link));
  }

  private async readWorkHostGoalLinkOnce(link: WorkHostGoalLink): Promise<void> {
    if (this.closing) return;
    if (this.workHostGoalLinks.get(link.task_id)?.revision !== link.revision) return;
    const policy = this.work.store.get(link.task_id);
    if (!policy) { this.workHostGoalLinks.unlink(link.task_id); return; }
    const matches = () => {
      const current = this.work.store.get(link.task_id);
      return !!current && this.workGoalBinding(current) === link.binding_key && current.nativeSessionId === link.thread_id && this.workGoalAccountMatches(current);
    };
    if (!matches()) { this.workHostGoalLinks.record(link, "account_changed", Date.now()); return; }
    let snapshot: HostGoalSnapshot;
    try { snapshot = await this.previewWorkHostGoal("codex", policy.account, link.thread_id); }
    catch { snapshot = {readState:"error", objective:null, hostStatus:null, observedAtMs:null, expiresAtMs:null}; }
    if (this.closing) return;
    if (!matches()) { this.workHostGoalLinks.record(link, "account_changed", Date.now()); return; }
    this.workHostGoalLinks.record(link, snapshot.readState, snapshot.observedAtMs ?? Date.now(),
      snapshot.objective && snapshot.hostStatus ? {objective:snapshot.objective,status:snapshot.hostStatus} : null);
  }

  private reviewedHostObjective(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value.length > 20_000) throw new HostGoalLinkError("work-host-goal-review-required");
    return value;
  }

  async saveWorkPolicy(input: WorkPolicyInput, expectedRevision: number | null, requestId: string, hostGoalLinked?: boolean, reviewedObjective?: string) {
    const existing = this.work.store.get(input.id);
    if (existing && this.workHostGoalLinks.get(input.id) && !this.workGoalAccountMatches(existing)) throw new HostGoalLinkError("work-host-goal-account-changed");
    if (hostGoalLinked !== undefined && typeof hostGoalLinked !== "boolean") throw new HostGoalLinkError("work-host-goal-invalid-link");
    if (hostGoalLinked === true) {
      this.reviewedHostObjective(reviewedObjective);
      if (input.provider !== "codex") throw new HostGoalLinkError("work-host-goal-codex-only");
      try { normalizeSessionId(input.nativeSessionId); } catch { throw new HostGoalLinkError("work-host-goal-session-invalid"); }
      if (!this.workHostGoalLinks.get(input.id) && this.workHostGoalLinks.list().length >= 50) throw new HostGoalLinkError("work-host-goal-link-limit");
    }
    let linked: WorkHostGoalLink | undefined;
    // The link intent and loading gate commit in the same idempotent transaction
    // as the policy. Retrying a save cannot resurrect a subsequently removed link.
    const policy = await this.work.save(input, expectedRevision, requestId, {
      context:hostGoalLinked === undefined ? undefined : {hostGoalLinked,...(hostGoalLinked ? {reviewedObjective} : {})},
      saved: saved => {
        if (hostGoalLinked === false) this.workHostGoalLinks.unlink(saved.id);
        if (hostGoalLinked === true) linked = this.workHostGoalLinks.link(saved.id, saved.nativeSessionId, this.workGoalBinding(saved), reviewedObjective!);
      },
    });
    // Saving is complete once policy and gate are durable. Host reads may take
    // longer than an HTTP client timeout; the loading state is pollable and the
    // tracked read never turns a successful save into an ambiguous response.
    if (linked) void this.readWorkHostGoalLink(linked).catch(() => {});
    const latest = this.work.store.get(policy.id)!;
    return {policy:{...latest,hostGoal:this.workHostGoalStatus(latest)}};
  }

  async changeWorkHostGoal(id: string, expectedRevision: number, action: string, reviewedObjective?: string): Promise<{hostGoal:HostGoalSnapshot|null;revision:number}> {
    const policy = this.work.store.get(id);
    if (!policy || policy.revision !== expectedRevision) throw new HostGoalLinkError("work-revision-conflict");
    if (!["link", "refresh", "unlink"].includes(action)) throw new HostGoalLinkError("work-host-goal-action-invalid");
    if (action === "unlink") {
      const updated = this.storage.transaction(() => {
        const next = this.work.store.advanceRevision(id, expectedRevision);
        this.workHostGoalLinks.unlink(id);
        return next;
      });
      this.work.interruptPolicy(id);
      return {hostGoal:null,revision:updated.revision};
    }
    if (!this.workGoalAccountMatches(policy)) throw new HostGoalLinkError("work-host-goal-account-changed");
    let link = this.workHostGoalLinks.get(id);
    if (action === "link") {
      this.reviewedHostObjective(reviewedObjective);
      try { normalizeSessionId(policy.nativeSessionId); } catch { throw new HostGoalLinkError("work-host-goal-session-invalid"); }
      link = this.storage.transaction(() => {
        this.work.store.advanceRevision(id, expectedRevision);
        return this.workHostGoalLinks.link(id, policy.nativeSessionId, this.workGoalBinding(policy), reviewedObjective!);
      });
      // A changed link is new execution authority. The previous claim keeps its
      // old policy revision forever, even after a refreshed link becomes ready.
      this.work.interruptPolicy(id);
    }
    if (!link) throw new HostGoalLinkError("work-host-goal-not-linked");
    // Refresh preserves a still-fresh observation while reading. A harmless
    // status request must not revoke an in-flight execution's authorization.
    if (action === "link") this.workHostGoalLinks.record(link, "loading", Date.now());
    void this.readWorkHostGoalLink(link).catch(() => {});
    return {hostGoal:this.workHostGoalStatus(this.work.store.get(id)!),revision:this.work.store.get(id)!.revision};
  }

  ingest(observations: QuotaObservation[]): QuotaEvent[] {
    const emitted: QuotaEvent[] = [];
    for (const observation of observations) {
      emitted.push(...this.db.ingestObservation(observation, this.config));
    }
    return emitted;
  }

  ingestCodexSnapshot(observations: QuotaObservation[]): QuotaEvent[] {
    if (!observations.length) return [];
    const emitted: QuotaEvent[] = [];
    const grouped = new Map<string, QuotaObservation[]>();
    for (const observation of observations) {
      const list = grouped.get(observation.account) ?? [];
      list.push(observation);
      grouped.set(observation.account, list);
    }
    for (const [account, accountObservations] of grouped) {
      const observedAtMs = Math.max(...accountObservations.map((item) => item.observedAtMs));
      // Codex can switch the period of the same limit lane between 7 and 30
      // days. The period is part of the bucket identity, so normally this
      // only surfaces as the old bucket retiring on the second miss after
      // the new one appears. Catch it as a lane switch on the first full
      // response instead.
      const previousLaneWindows = this.db.latestAll().filter((item) =>
        item.provider === "codex" && item.account === account
      );
      const orderedPrevious = [...previousLaneWindows].sort((a, b) => b.observedAtMs - a.observedAtMs);
      // Retained buckets from an older full response belong to its old context.
      const previousSnapshot = orderedPrevious.filter(item => item.observedAtMs === orderedPrevious[0]?.observedAtMs);
      const previousContext = previousSnapshot.find(item => item.metadata?.limitId === "codex") ?? previousSnapshot[0];
      const previousEpoch = previousContext?.metadata?.collectorEpoch;
      const currentSnapshot = accountObservations.filter(item => item.observedAtMs === observedAtMs);
      const nextContext = currentSnapshot.find(item => item.metadata?.limitId === "codex") ?? currentSnapshot[0]!;
      const nextEpoch = nextContext.metadata?.collectorEpoch;
      const newCollection = nextEpoch != null && nextEpoch !== previousEpoch;
      const contextChange = codexContextChange(previousContext, nextContext);
      // Reset tickets belong to the account. Their canonical observation may
      // be the five-hour window while the weekly window is the one recovered.
      // Share that snapshot evidence without copying the balance itself, so a
      // single ticket change produces one event and is never called an external grant.
      const previousTickets = previousSnapshot.find(item => item.resetCreditsAvailable != null);
      const nextTickets = currentSnapshot.find(item => item.resetCreditsAvailable != null);
      const comparable = !newCollection && !contextChange && previousTickets != null && nextTickets != null &&
        previousTickets.source === nextTickets.source && previousTickets.quality === "authoritative" &&
        nextTickets.quality === "authoritative" && observedAtMs > previousTickets.observedAtMs;
      const accountResetCreditDecreased = comparable && nextTickets.resetCreditsAvailable! < previousTickets.resetCreditsAvailable!;
      const accountQuotaRecovered = accountResetCreditDecreased && currentSnapshot.some(next => {
        const previous = previousSnapshot.find(item => item.bucket === next.bucket);
        return previous?.usedPercent != null && next.usedPercent != null && next.usedPercent < previous.usedPercent;
      });
      const contextualObservations = accountObservations.map(item => ({ ...item,
        metadata: { ...item.metadata, accountResetCreditDecreased, accountQuotaRecovered },
      }));
      const result = this.db.ingestFullSnapshot(
        "codex",
        account,
        contextualObservations,
        this.config,
      );
      emitted.push(...result.events);
      if (!result.accepted) continue;
      if (contextChange) {
        const details: QuotaEvent["details"] = contextChange === "plan_changed" ? {
          fromPlan: String(previousContext!.metadata!.planType), toPlan: String(nextContext.metadata!.planType),
        } : {};
        const value: QuotaEvent = { provider: "codex", account, bucket: nextContext.bucket,
          kind: contextChange, severity: "info", occurredAtMs: observedAtMs, confidence: "high",
          displayText: t(`event.${contextChange}`, details, this.locale), details };
        if (this.db.insertEvent(value)) emitted.push(value);
      }
      // Collector restarts also create an epoch. A new baseline alone must
      // not re-send an already displayed low-quota warning; observed recovery
      // below re-arms those thresholds.
      for (const next of accountObservations) {
        if (newCollection || contextChange) break;
        const limitId = next.metadata?.limitId;
        const lane = next.metadata?.lane;
        if (typeof limitId !== "string" || typeof lane !== "string") continue;
        const previous = previousLaneWindows
          .filter((item) =>
            item.metadata?.limitId === limitId &&
            item.metadata?.lane === lane
          )
          .sort((left, right) => right.observedAtMs - left.observedAtMs)[0];
        // A missing bucket is retained for two reads. Compare with the latest
        // lane reading, or the retained old bucket re-announces the same change.
        if (!previous || previous.bucket === next.bucket) continue;
        const value: QuotaEvent = {
          provider: next.provider,
          account: next.account,
          bucket: next.bucket,
          kind: "window_changed",
          severity: "info",
          occurredAtMs: next.observedAtMs,
          confidence: "high",
          displayText: t("event.window_changed", {
            limitId,
            lane,
            fromLabel: previous.label,
            toLabel: next.label,
          }, this.locale),
          details: {
            limitId,
            lane,
            fromLabel: previous.label,
            toLabel: next.label,
            previousBucket: previous.bucket,
            nextBucket: next.bucket,
            previousWindowSeconds: previous.windowSeconds,
            nextWindowSeconds: next.windowSeconds,
          },
        };
        if (this.db.insertEvent(value)) emitted.push(value);
      }
      for (const previous of result.retired) {
        const value: QuotaEvent = {
          provider: previous.provider,
          account: previous.account,
          bucket: previous.bucket,
          kind: "bucket_retired",
          severity: "info",
          occurredAtMs: observedAtMs,
          confidence: "high",
          displayText: t("event.bucket_retired", { label: previous.label }, this.locale),
          details: { label: previous.label, lastObservedAtMs: previous.observedAtMs, fullReadsMissed: 2 },
        };
        if (this.db.insertEvent(value)) emitted.push(value);
      }
    }
    return emitted;
  }

  ingestClaudeSessions(observations: QuotaObservation[], nowMs = Date.now()): QuotaEvent[] {
    const consensus = this.reconcileClaudeSessions(observations);
    const accepted: QuotaObservation[] = [];
    for (const observation of consensus) {
      this.collection.recordAttempt(
        "claude",
        observation.account,
        CLAUDE_STATUSLINE_SOURCE,
        observation.observedAtMs,
        null,
        null,
      );
      // The status line is a fallback. For accounts where OAuth recently
      // succeeded its values stay out of the history, which stops the two
      // sources from alternating and manufacturing source-change and
      // meter-correction noise.
      if (!this.oauthIsAuthoritative(observation.account, nowMs)) accepted.push(observation);
    }
    return this.ingest(accepted);
  }

  /// Persistence and decision, kept apart: the store writes and reads rows, and
  /// selectClaudeConsensus decides which of them wins.
  private reconcileClaudeSessions(observations: QuotaObservation[]): QuotaObservation[] {
    const valid = observations.filter((observation) =>
      observation.provider === "claude" && typeof observation.metadata?.sessionHash === "string"
    );
    if (!valid.length) return [];
    const ttlMs = this.config.collection.claudeSessionTtlSeconds * 1_000;
    const referenceMs = Math.max(...valid.map((observation) => observation.observedAtMs));
    const affected = [
      ...new Map(
        valid.map((observation) => [
          `${observation.account}\u0000${observation.bucket}`,
          { account: observation.account, bucket: observation.bucket },
        ]),
      ).values(),
    ];
    return this.storage.transaction(() => {
      this.claudeSessions.upsertSessionRows(valid);
      const rows = this.claudeSessions.activeSessionRowsSince(referenceMs - ttlMs);
      return selectClaudeConsensus(rows, affected, ttlMs, referenceMs);
    });
  }

  private oauthIsAuthoritative(account: string, nowMs: number): boolean {
    const state = this.collection
      .sourceStates()
      .find((row) =>
        row.provider === "claude" && row.account === account && row.source === CLAUDE_OAUTH_SOURCE
      );
    if (state?.lastSuccessMs == null) return false;
    return nowMs - state.lastSuccessMs <= this.config.collection.staleAfterSeconds * 1_000;
  }

  private recordCodexRead(account: string, observations: QuotaObservation[]) {
    // Polls and validated push refreshes must agree on collection health.
    // Empty reads keep the last snapshot but do not establish fresh quota.
    if (!observations.length) {
      const message = "rate limit response contained no windows";
      this.codexPollState.set(account, { count: 0, error: message });
      this.collection.recordAttempt("codex", account, CODEX_SOURCE, Date.now(), message, "no-windows");
      return { ok: false as const, events: [] as QuotaEvent[], message };
    }
    this.codexPollState.set(account, { count: observations.length, error: null });
    this.collection.recordAttempt("codex", account, CODEX_SOURCE, Date.now(), null, null);
    const events = this.closing ? [] : this.ingestCodexSnapshot(observations);
    if (!this.closing) {
      // Routing protection needs each accepted account update immediately. Do
      // not wait for another account, Claude, historical analysis or alerts.
      const nowMs = Date.now();
      this.publishWorkBoundary(nowMs, this.currentQuotaWindows(nowMs));
    }
    return {
      ok: true as const,
      events,
    };
  }

  async pollCodex(): Promise<QuotaEvent[]> {
    if (!this.config.collection.codexEnabled) return [];
    const profiles = this.config.accounts.codex.filter((profile) => profile.enabled);
    if (!profiles.length) return [];
    const requireFileCredentials = profiles.length > 1;
    const outcomes = await Promise.all(profiles.map(async (profile) => {
      if (requireFileCredentials && !codexUsesFileCredentials(profile)) {
        const message = "multi-account Codex requires cli_auth_credentials_store = \"file\" in this profile's config.toml";
        this.codexPollState.set(profile.id, { count: 0, error: message });
        this.collection.recordAttempt(
          "codex", profile.id, CODEX_SOURCE, Date.now(), message, "isolation-unsafe",
        );
        console.error(`[quotapie] Codex account ${profile.id} skipped: ${message}`);
        return { ok: false as const, events: [] as QuotaEvent[], message };
      }
      let client = this.codexClients.get(profile.id);
      if (!client) {
        client = this.createCodexClient(profile);
        this.codexClients.set(profile.id, client);
      }
      try {
        const observations = await client.readRateLimits();
        if (observations.length) {
          if (client.accountEmail) this.codexAccountNames.set(profile.id, client.accountEmail);
          else this.codexAccountNames.delete(profile.id);
        }
        return this.recordCodexRead(profile.id, observations);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.codexPollState.set(profile.id, { count: 0, error: message });
        this.collection.recordAttempt("codex", profile.id, CODEX_SOURCE, Date.now(), message, "provider-error");
        if (!(error instanceof CodexSnapshotUnavailableError)) {
          await client.close().catch(() => undefined);
          this.codexClients.delete(profile.id);
        }
        console.error(`[quotapie] Codex account ${profile.id} refresh failed: ${message}`);
        return { ok: false as const, events: [] as QuotaEvent[], message };
      }
    }));
    if (!outcomes.some((outcome) => outcome.ok)) {
      throw new Error(`all configured Codex accounts failed (${profiles.map((profile) => profile.id).join(", ")})`);
    }
    return outcomes.flatMap((outcome) => outcome.events);
  }

  // force exists for doctor: a diagnostic has to see the state now rather
  // than wait for the next polling interval. fetchImpl is the seam tests use
  // to reproduce provider failures.
  async pollClaudeOAuth(
    nowMs = Date.now(),
    force = false,
    fetchImpl: typeof fetch = fetch,
  ): Promise<QuotaEvent[]> {
    // force skips the polling interval, not the configuration gate. A
    // diagnostic must never quietly read credentials the user has opted out
    // of sharing.
    if (!this.config.collection.claudeOAuthEnabled) return [];
    const emitted: QuotaEvent[] = [];
    for (const profile of this.config.accounts.claude.filter((item) => item.enabled)) {
      const lastPollMs = this.claudeOAuthLastPollMs.get(profile.id) ?? 0;
      if (!force && nowMs - lastPollMs < QuotaPieService.CLAUDE_OAUTH_MIN_INTERVAL_MS) continue;
      this.claudeOAuthLastPollMs.set(profile.id, nowMs);
      const credentials = await readClaudeCredentialsAsync(profile.configDir ?? "~/.claude", profile.keychainService);
      if (!credentials.accessToken) {
        this.collection.recordAttempt(
          "claude",
          profile.id,
          CLAUDE_OAUTH_SOURCE,
          Date.now(),
          credentials.error,
          credentials.errorCategory,
        );
        continue;
      }
      try {
        const payload = await fetchClaudeUsage(credentials.accessToken, fetchImpl);
        const observations = mapClaudeUsage(payload, profile.id, Date.now());
        if (!observations.length) {
          throw new ClaudeUsageError("usage response contained no rate windows", "no-windows");
        }
        this.collection.recordAttempt("claude", profile.id, CLAUDE_OAUTH_SOURCE, Date.now(), null, null);
        if (this.closing) continue;
        const result = this.db.ingestFullSnapshot("claude", profile.id, observations, this.config);
        emitted.push(...result.events);
        if (result.accepted) {
          const observedAtMs = Math.max(...observations.map((item) => item.observedAtMs));
          for (const previous of result.retired) {
            const value: QuotaEvent = {
              provider: previous.provider,
              account: previous.account,
              bucket: previous.bucket,
              kind: "bucket_retired",
              severity: "info",
              occurredAtMs: observedAtMs,
              confidence: "high",
              displayText: t("event.bucket_retired", { label: previous.label }, this.locale),
              details: { label: previous.label, lastObservedAtMs: previous.observedAtMs, fullReadsMissed: 2 },
            };
            if (this.db.insertEvent(value)) emitted.push(value);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const category = error instanceof ClaudeUsageError ? error.category : "provider-error";
        this.collection.recordAttempt(
          "claude",
          profile.id,
          CLAUDE_OAUTH_SOURCE,
          Date.now(),
          message,
          category,
        );
        console.error(`[quotapie] Claude OAuth poll failed (${profile.id}): ${message}`);
      }
    }
    return emitted;
  }

  private createCodexClient(profile: CodexAccountConfig): CodexAppServerClient {
    const client = new CodexAppServerClient(
      this.config.collection.codexCommand,
      profile.id,
      12_000,
      profile.codexHome ? resolveUserPath(profile.codexHome) : null,
    );
    client.onUpdate((observations) => {
      if (this.closing) return;
      this.recordCodexRead(profile.id, observations);
    });
    return client;
  }

  private codexClient(profile: CodexAccountConfig): CodexAppServerClient {
    let client = this.codexClients.get(profile.id);
    if (!client) {
      client = this.createCodexClient(profile);
      this.codexClients.set(profile.id, client);
    }
    return client;
  }

  codexPollResults(): Array<{ account: string; count: number; error: string | null }> {
    return this.config.accounts.codex
      .filter((profile) => profile.enabled)
      .map((profile) => ({ account: profile.id, ...(this.codexPollState.get(profile.id) ?? { count: 0, error: null }) }));
  }

  private currentObservations(provider?: Provider): QuotaObservation[] {
    const latestWindows = this.db.latestAll();
    const codexEpochs = new Map<string, unknown>();
    for (const item of [...latestWindows].sort((a, b) => b.observedAtMs - a.observedAtMs)) {
      if (item.provider === "codex" && !codexEpochs.has(item.account)) {
        codexEpochs.set(item.account, item.metadata?.collectorEpoch);
      }
    }
    return latestWindows.filter((latest) => (
      (provider == null || latest.provider === provider) &&
      (latest.provider !== "codex" || latest.metadata?.collectorEpoch === codexEpochs.get(latest.account)) &&
      this.isEnabledAccount(latest.provider, latest.account)
    ));
  }

  private currentQuotaWindows(nowMs: number): WindowAnalysis[] {
    return this.currentObservations().map(latest => analyzeWindow(latest, [], this.config, nowMs));
  }

  analyses(nowMs = Date.now(), provider?: Provider): WindowAnalysis[] {
    const sinceMs = analysisHistoryStart(this.config, nowMs);
    const recentRawSinceMs = nowMs - Math.max(this.config.profile.recentLookbackMinutes, this.config.alerts.rapidWindowMinutes) * 60_000;
    return this.currentObservations(provider).map((latest) => {
      const history = this.db.analysisHistory(
        latest.provider,
        latest.account,
        latest.bucket,
        sinceMs,
        recentRawSinceMs,
      );
      return analyzeWindow(latest, history, this.config, nowMs);
    });
  }

  statuses(nowMs = Date.now(), analysed?: WindowAnalysis[]): ProviderStatus[] {
    return groupStatuses(
      analysed ?? this.analyses(nowMs),
      (provider, account) => this.accountLabel(provider, account),
    ).sort((left, right) => {
      const providerDifference = (left.provider === "codex" ? 0 : 1) - (right.provider === "codex" ? 0 : 1);
      if (providerDifference !== 0) return providerDifference;
      return this.accountOrder(left.provider, left.account) - this.accountOrder(right.provider, right.account);
    });
  }

  // Returns every enabled configured account whether or not it has
  // snapshots. Rather than a Claude account vanishing from the list, why it
  // is empty should be visible as state.
  accountStates(nowMs = Date.now(), analysed?: WindowAnalysis[]): AccountState[] {
    const windows = analysed ?? this.analyses(nowMs);
    const sourceStates = this.collection.sourceStates();
    const staleAfterMs = this.config.collection.staleAfterSeconds * 1_000;
    const profiles: Array<{ provider: Provider; id: string; label: string; enabled: boolean }> = [
      ...this.config.accounts.codex.map((profile) => ({
        provider: "codex" as const,
        id: profile.id,
        label: profile.label,
        enabled: profile.enabled,
      })),
      ...this.config.accounts.claude.map((profile) => ({
        provider: "claude" as const,
        id: profile.id,
        label: profile.label,
        enabled: profile.enabled,
      })),
    ];
    return profiles.filter((profile) => profile.enabled).map((profile) => {
      const accountWindows = windows
        .filter((window) => window.provider === profile.provider && window.account === profile.id)
        .sort((left, right) => (left.windowSeconds ?? 0) - (right.windowSeconds ?? 0));
      const rows = sourceStates.filter((row) =>
        row.provider === profile.provider && row.account === profile.id
      );
      const sources: CollectionSourceState[] = rows.map((row) => ({
        source: row.source,
        health: collectionHealth(row, nowMs, staleAfterMs),
        lastAttemptAtMs: row.lastAttemptMs,
        lastSuccessAtMs: row.lastSuccessMs,
        errorCategory: row.lastErrorCategory,
        errorDetail: row.lastError,
      })).sort((left, right) => {
        const health = HEALTH_RANK[right.health] - HEALTH_RANK[left.health];
        if (health !== 0) return health;
        const authority = (SOURCE_AUTHORITY[right.source] ?? 0) - (SOURCE_AUTHORITY[left.source] ?? 0);
        if (authority !== 0) return authority;
        return (right.lastSuccessAtMs ?? 0) - (left.lastSuccessAtMs ?? 0);
      });
      // Account health follows the best of its sources. The point of the rule
      // is that an OAuth failure cannot overwrite a status-line collection
      // that just succeeded.
      const best = sources[0] ?? null;
      const failing = sources.find((source) => source.errorCategory != null) ?? null;
      // OAuth off with no fallback samples is not broken, it is unconfigured.
      // The user has to be pointed at one of the two routes, so it gets its
      // own category.
      const optedOut = profile.provider === "claude" &&
        !this.config.collection.claudeOAuthEnabled &&
        best == null;
      const bottleneck = [...accountWindows].sort((left, right) =>
        right.bottleneckScore - left.bottleneckScore
      )[0];
      return {
        provider: profile.provider,
        account: profile.id,
        accountLabel: this.accountLabel(profile.provider, profile.id),
        nickname: this.config.accounts[profile.provider].find(item => item.id === profile.id)?.nickname,
        enabled: profile.enabled,
        collection: {
          health: best?.health ?? "never-attempted",
          activeSource: best && best.lastSuccessAtMs != null ? best.source : null,
          lastSuccessAtMs: best?.lastSuccessAtMs ?? null,
          // For a healthy account, a past error on the fallback source is not
          // worth surfacing.
          errorCategory: best?.health === "recent-success"
            ? null
            : optedOut
              ? "not-configured"
              : failing?.errorCategory ?? null,
          errorDetail: best?.health === "recent-success"
            ? null
            : optedOut
              ? "set collection.claudeOAuthEnabled = true, or configure the Claude status line"
              : failing?.errorDetail ?? null,
          sources,
        },
        windows: accountWindows,
        bottleneckBucket: bottleneck?.bucket ?? null,
        updatedAtMs: accountWindows.length
          ? Math.max(...accountWindows.map((window) => window.observedAtMs))
          : null,
      };
    });
  }

  headline(nowMs = Date.now()): Headline {
    return buildHeadline(this.accountStates(nowMs), nowMs, this.locale);
  }

  private accountLabel(provider: Provider, account: string): string {
    const profiles = provider === "codex" ? this.config.accounts.codex : this.config.accounts.claude;
    const profile = profiles.find((profile) => profile.id === account);
    const label = profile?.label;
    if (profile?.nickname !== undefined) {
      return profile.nickname.trim() || (provider === "codex" ? this.codexAccountNames.get(account) : undefined) || label || account;
    }
    return provider === "codex" ? codexAccountDisplay(label, account, this.codexAccountNames.get(account)) : label ?? account;
  }

  private notificationConfig(): AppConfig {
    return { ...this.config, accounts: { ...this.config.accounts,
      codex: this.config.accounts.codex.map(profile => ({ ...profile, label: this.accountLabel("codex", profile.id) })) } };
  }

  private accountOrder(provider: Provider, account: string): number {
    const profiles = provider === "codex" ? this.config.accounts.codex : this.config.accounts.claude;
    const index = profiles.findIndex((profile) => profile.id === account);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  }

  private isEnabledAccount(provider: Provider, account: string): boolean {
    const profiles = provider === "codex" ? this.config.accounts.codex : this.config.accounts.claude;
    return profiles.some((profile) => profile.id === account && profile.enabled);
  }

  registerResumeTask(input: RegisterResumeTaskInput, nowMs = Date.now(), reuseExisting = false): ResumeTaskSummary {
    // Explicit QuotaPie opt-in only; observing another host's session or quota
    // must never call this as an automatic transfer of execution ownership.
    const account = input.account ?? "default";
    if (!this.isEnabledAccount(input.provider, account)) {
      throw new Error(`unknown or disabled ${input.provider} account alias: ${account}`);
    }
    const nativeId = normalizeSessionId(input.nativeId);
    if (reuseExisting) {
      const key = resumeTaskKey(input.provider, account, nativeId);
      const row = this.storage.db.query<{id:string},[string]>("SELECT id FROM resume_tasks WHERE task_key=? AND state IN ('waiting','ready','approved') LIMIT 1").get(key);
      const existing = row ? this.resumeTasks.get(row.id) : null;
      if (existing) {
        if (!this.resumeAccountMatches(existing)) throw new HostGoalLinkError("host_goal_account_changed");
        return this.resumeTaskSummary(existing);
      }
    }
    const cwd = resolve(input.cwd ?? process.cwd());
    const projectLabel = (input.projectLabel ?? basename(cwd) ?? "").trim();
    if (!projectLabel || projectLabel.length > 160 || /[\u0000-\u001f\u007f]/.test(projectLabel)) {
      throw new Error("label must be 1-160 characters without control characters");
    }
    const candidates = this.analyses(nowMs, input.provider)
      .filter((window) =>
        window.account === account &&
        window.remainingPercent != null &&
        (input.bucket == null || window.bucket === input.bucket)
      )
      .sort((left, right) => {
        const remaining = left.remainingPercent! - right.remainingPercent!;
        if (remaining !== 0) return remaining;
        return (left.resetsAtMs ?? Number.MAX_SAFE_INTEGER) -
          (right.resetsAtMs ?? Number.MAX_SAFE_INTEGER);
      });
    const blocking = candidates[0];
    if (!blocking) {
      const suffix = input.bucket ? ` for bucket ${input.bucket}` : "";
      throw new Error(`no current quota window with a remaining value${suffix}`);
    }
    const created = this.storage.transaction(() => {
      const created = this.resumeTasks.create({
        id: randomUUID(),
        taskKey: resumeTaskKey(input.provider, account, nativeId),
        provider: input.provider,
        account,
        projectLabel,
        bucket: blocking.bucket,
        registeredAtMs: nowMs,
        registeredRemainingPercent: blocking.remainingPercent!,
        expectedResetAtMs: blocking.resetsAtMs,
      });
      if (input.provider === "codex") {
        const profile = this.config.accounts.codex.find(p => p.id === account && p.enabled)!;
        this.accountBindings.bind("resume", created.id, codexProfileRoot(profile));
      }
      return created;
    });
    return this.resumeTaskSummary(created);
  }

  resumeTaskSummaries(limit = 100, nowMs = Date.now()): ResumeTaskSummary[] {
    return this.resumeTasks.active(limit).map((task) => {
      const summary = this.resumeTaskSummary(task);
      if (task.state === "ready" && (!this.resumeAccountMatches(task) || !this.hasFreshResumeCapacity(task, nowMs))) summary.state = "waiting";
      return summary;
    });
  }

  private resumeTaskSummary(task: ResumeTask): ResumeTaskSummary {
    return {
      id: task.id,
      provider: task.provider,
      account: task.account,
      accountLabel: this.accountLabel(task.provider, task.account),
      projectLabel: task.projectLabel,
      state: task.state,
      registeredAtMs: task.registeredAtMs,
      expectedResetAtMs: task.expectedResetAtMs,
      readyAtMs: task.readyAtMs,
      errorDetail: task.errorDetail,
    };
  }

  private resumeAccountMatches(task: ResumeTask): boolean {
    if (task.provider !== "codex") return true;
    const profile = this.config.accounts.codex.find(p => p.id === task.account && p.enabled);
    return !!profile && this.accountBindings.matches("resume", task.id, codexProfileRoot(profile));
  }

  private goalClient(profile: CodexAccountConfig): CodexAppServerClient {
    let client = this.goalClients.get(profile.id);
    if (!client) {
      // Goal lookups cannot hold up the quota collector, and a caller's
      // inherited CODEX_HOME must not redefine the configured default profile.
      client = new CodexAppServerClient(this.config.collection.codexCommand, profile.id, 8_000, codexProfileRoot(profile));
      this.goalClients.set(profile.id, client);
    }
    return client;
  }

  async linkHostGoal(taskId: string, nativeId: string): Promise<HostGoalLinkSummary> {
    const task = this.resumeTasks.get(taskId);
    if (!task || task.provider !== "codex" || !["waiting", "ready", "approved"].includes(task.state)) {
      throw new HostGoalLinkError("host_goal_active_codex_task_required");
    }
    const threadId = normalizeSessionId(nativeId);
    if (resumeTaskKey("codex", task.account, threadId) !== task.taskKey) {
      throw new HostGoalLinkError("host_goal_session_mismatch");
    }
    if (!this.resumeAccountMatches(task)) throw new HostGoalLinkError("host_goal_account_changed");
    const profile = this.config.accounts.codex.find(p => p.id === task.account && p.enabled)!;
    let target;
    try { target = await findCodexResumeTarget(this.goalClient(profile), task.account, task.taskKey); }
    catch { throw new HostGoalLinkError("host_goal_session_unavailable"); }
    if (!target || target.nativeId !== threadId) throw new HostGoalLinkError("host_goal_session_unavailable");
    if (!this.resumeAccountMatches(task)) throw new HostGoalLinkError("host_goal_account_changed");
    const current = this.resumeTasks.get(taskId);
    if (!current || !["waiting", "ready", "approved"].includes(current.state)) {
      throw new HostGoalLinkError("host_goal_active_codex_task_required");
    }
    const link = this.hostGoalLinks.link(taskId, threadId);
    await this.readHostGoalLink(link);
    const summary = this.hostGoalStatus().items.find(item => item.taskId === taskId);
    if (this.hostGoalLinks.get(taskId)?.revision !== link.revision || !summary) {
      throw new HostGoalLinkError("host_goal_link_changed");
    }
    return summary;
  }

  unlinkHostGoal(taskId: string): void {
    this.hostGoalLinks.unlink(taskId);
  }

  private readHostGoalLink(link: HostGoalLink): Promise<void> {
    return this.serializeGoalRead("resume:" + link.task_id, () => this.readHostGoalLinkOnce(link));
  }

  private async readHostGoalLinkOnce(link: HostGoalLink): Promise<void> {
    if (this.closing) return;
    if (this.hostGoalLinks.get(link.task_id)?.revision !== link.revision) return;
    const task = this.resumeTasks.get(link.task_id);
    if (!task) return;
    if (!this.resumeAccountMatches(task)) {
      this.hostGoalLinks.record(link, "account_changed", Date.now());
      return;
    }
    const profile = this.config.accounts.codex.find(p => p.id === task.account && p.enabled)!;
    try {
      const goal = await this.goalClient(profile).readThreadGoal(link.thread_id);
      // A null goal alone cannot establish that the linked thread still exists.
      if (goal === null && !await findCodexResumeTarget(this.goalClient(profile), task.account, task.taskKey)) {
        throw new HostGoalLinkError("host_goal_session_unavailable");
      }
      if (this.closing) return;
      if (!this.resumeAccountMatches(task)) {
        this.hostGoalLinks.record(link, "account_changed", Date.now());
        return;
      }
      this.hostGoalLinks.record(link, goal ? "ready" : "no_goal", Date.now(), goal);
    } catch (error) {
      if (this.closing) return;
      this.hostGoalLinks.record(link, !this.resumeAccountMatches(task) ? "account_changed" :
        error instanceof CodexGoalUnsupportedError ? "unsupported" : "error", Date.now());
    }
  }

  refreshHostGoals(force = false): Promise<void> {
    if (this.hostGoalRefresh) return this.hostGoalRefresh;
    const work = (async () => {
      this.hostGoalLinks.prune();
      for (const link of this.hostGoalLinks.list()) {
        if (this.closing) break;
        const task = this.resumeTasks.get(link.task_id);
        if (!task || !["waiting", "ready", "approved", "resumed"].includes(task.state)) continue;
        const interval = link.read_state === "unsupported" ? 300_000 : Math.max(30_000, this.config.collection.pollSeconds * 1_000);
        if (!force && link.attempted_at_ms != null && Date.now() - link.attempted_at_ms < interval) continue;
        await this.readHostGoalLink(link);
      }
      for (const link of this.workHostGoalLinks.list()) {
        if (this.closing) break;
        const interval = link.read_state === "unsupported" ? 300_000 : Math.max(30_000, this.config.collection.pollSeconds * 1_000);
        if (!force && link.attempted_at_ms != null && Date.now() - link.attempted_at_ms < interval) continue;
        await this.readWorkHostGoalLink(link);
      }
    })();
    this.hostGoalRefresh = work;
    void work.finally(() => { if (this.hostGoalRefresh === work) this.hostGoalRefresh = null; }).catch(() => {});
    return work;
  }

  hostGoalStatus(nowMs = Date.now()): { items: HostGoalLinkSummary[] } {
    return { items: this.hostGoalLinks.list().flatMap(link => {
      const task = this.resumeTasks.get(link.task_id);
      if (!task) return [];
      const accountMatches = this.resumeAccountMatches(task);
      const expiresAtMs = link.observed_at_ms == null ? null :
        link.observed_at_ms + this.config.collection.staleAfterSeconds * 1_000;
      const stale = expiresAtMs != null && (nowMs >= expiresAtMs || link.observed_at_ms! > nowMs);
      const readState = !accountMatches ? "account_changed" :
        stale && ["ready", "no_goal"].includes(link.read_state) ? "stale" : link.read_state;
      return [{ id: task.id, taskId: task.id, provider: "codex" as const,
        account: task.account, accountLabel: this.accountLabel("codex", task.account), projectLabel: task.projectLabel,
        readState, objective: accountMatches ? link.objective : null,
        hostStatus: accountMatches ? link.host_status : null,
        observedAtMs: accountMatches ? link.observed_at_ms : null,
        expiresAtMs: accountMatches ? expiresAtMs : null,
        resumeState: !accountMatches || (task.state === "ready" && !this.hasFreshResumeCapacity(task, nowMs))
          ? "unknown" : task.state } satisfies HostGoalLinkSummary];
    }) };
  }

  async approveResumeTask(id: string, nowMs?: number): Promise<{
    task: ResumeTaskSummary;
    plan: ResumePlan;
  }> {
    const initialNowMs = nowMs ?? Date.now();
    const task = this.resumeTasks.get(id);
    if (!task) throw new ResumeTaskStoreError("not-found", "resume task not found");
    if (task.state !== "ready") {
      throw new ResumeTaskStoreError(
        "state-conflict",
        `resume task is ${task.state}; expected ready`,
      );
    }
    if (!this.resumeAccountMatches(task)) {
      this.resumeTasks.markWaiting(id, initialNowMs);
      this.rearmResumeReadyNotification(task, initialNowMs);
      this.resumeTasks.setError(id, "account-binding-changed", initialNowMs);
      throw new ResumeTargetError("login account changed or could not be verified");
    }
    if (!this.hasFreshResumeCapacity(task, initialNowMs)) {
      this.resumeTasks.markWaiting(id, initialNowMs);
      this.rearmResumeReadyNotification(task, initialNowMs);
      throw new ResumeTargetError("fresh quota is no longer available; waiting for provider confirmation");
    }
    try {
      const plan = await this.buildResumePlan(task);
      const finalNowMs = nowMs ?? Date.now();
      if (!this.resumeAccountMatches(task)) {
        this.resumeTasks.markWaiting(id, finalNowMs);
        this.rearmResumeReadyNotification(task, finalNowMs);
        this.resumeTasks.setError(id, "account-binding-changed", finalNowMs);
        throw new ResumeTargetError("login account changed during resume discovery");
      }
      if (!this.hasFreshResumeCapacity(task, finalNowMs)) {
        this.resumeTasks.markWaiting(id, finalNowMs);
        this.rearmResumeReadyNotification(task, finalNowMs);
        throw new ResumeTargetError("fresh quota is no longer available; waiting for provider confirmation");
      }
      // Discovery is asynchronous. This final guarded transition both closes
      // a concurrent dismiss race and makes a second approval lose cleanly.
      const approved = this.storage.transaction(() => {
        const value = this.resumeTasks.approve(id, finalNowMs);
        this.alerts.cancelAppNotificationsForAlert(`resume:${id}:ready`, finalNowMs);
        return value;
      });
      return { task: this.resumeTaskSummary(approved), plan };
    } catch (error) {
      if (error instanceof ResumeTaskStoreError) throw error;
      const detail = error instanceof ResumeTargetError
        ? error.message
        : "could not resolve the provider session metadata";
      if (this.resumeTasks.get(id)?.state === "ready") {
        this.resumeTasks.setError(id, detail, Date.now());
      }
      if (error instanceof ResumeTargetError) throw error;
      throw new ResumeTargetError(detail);
    }
  }

  markResumeTaskResumed(id: string, nowMs = Date.now()): ResumeTaskSummary {
    return this.resumeTaskSummary(this.storage.transaction(() => {
      const task = this.resumeTasks.markResumed(id, nowMs);
      this.alerts.cancelAppNotificationsForAlert(`resume:${id}:ready`, nowMs);
      return task;
    }));
  }

  retryResumeTask(id: string, nowMs = Date.now()): ResumeTaskSummary {
    return this.resumeTaskSummary(this.resumeTasks.retry(id, nowMs));
  }

  dismissResumeTask(id: string, nowMs = Date.now()): ResumeTaskSummary {
    return this.resumeTaskSummary(this.storage.transaction(() => {
      const task = this.resumeTasks.dismiss(id, nowMs);
      this.alerts.cancelAppNotificationsForAlert(`resume:${id}:ready`, nowMs);
      return task;
    }));
  }

  recentWorkStatus(nowMs = Date.now(), refresh = true): { recentWork: RecentWorkSummary[]; recentWorkState: "loading" | "ready" | "error" } {
    if (refresh && !this.closing && !this.recentWorkRefresh && nowMs - this.recentWorkUpdatedAtMs >= 30_000) {
      this.recentWorkState = "loading";
      this.recentWorkRefresh = this.recentWork.summaries(this.config, nowMs).then(items => {
        this.recentWorkSnapshot = items;
        this.recentWorkState = "ready";
      }).catch(() => {
        this.recentWorkState = "error";
      }).finally(() => {
        this.recentWorkUpdatedAtMs = nowMs;
        this.recentWorkRefresh = null;
      });
    }
    // Keep normal quota polling responsive even during the first inventory scan.
    return { recentWork: this.recentWorkSnapshot, recentWorkState: this.recentWorkState };
  }

  async recentWorkOpenPlan(id: string, nowMs = Date.now()): Promise<ResumePlan> {
    const target = await this.recentWork.target(id, this.config, nowMs);
    if (!target) throw new ResumeTargetError("the session is no longer available in recent work");
    return this.buildResumePlan(target);
  }

  private async buildResumePlan(task: Pick<ResumeTask, "provider" | "account" | "taskKey">): Promise<ResumePlan> {
    let target;
    if (task.provider === "codex") {
      const profile = this.config.accounts.codex.find((item) => item.id === task.account && item.enabled);
      if (!profile) throw new ResumeTargetError("the Codex account is disabled or no longer configured");
      if (
        this.config.accounts.codex.filter((item) => item.enabled).length > 1 &&
        !codexUsesFileCredentials(profile)
      ) {
        throw new ResumeTargetError("the Codex account credentials are not safely isolated");
      }
      if (basename(this.config.collection.codexCommand) !== "codex") {
        throw new ResumeTargetError("the configured Codex command must have the executable name codex");
      }
      target = await findCodexResumeTarget(this.codexClient(profile), task.account, task.taskKey);
      if (!target) throw new ResumeTargetError("the Codex task is no longer available in this account");
      if (!await resumeWorkingDirectoryAvailable(target.cwd)) {
        throw new ResumeTargetError("the task working directory is no longer available");
      }
      return {
        executable: this.config.collection.codexCommand,
        arguments: ["resume", "-C", target.cwd, target.nativeId],
        environment: { CODEX_HOME: codexProfileRoot(profile) },
        workingDirectory: target.cwd,
      };
    }
    const profile = this.config.accounts.claude.find((item) => item.id === task.account && item.enabled);
    if (!profile) throw new ResumeTargetError("the Claude account is disabled or no longer configured");
    const configDir = resolveUserPath(profile.configDir);
    target = await findClaudeResumeTarget(configDir, task.account, task.taskKey);
    if (!target) throw new ResumeTargetError("the Claude task is no longer available in this account");
    if (!await resumeWorkingDirectoryAvailable(target.cwd)) {
      throw new ResumeTargetError("the task working directory is no longer available");
    }
    return {
      executable: "claude",
      arguments: ["--resume", target.nativeId],
      environment: claudeProfileEnvironment(configDir),
      workingDirectory: target.cwd,
    };
  }

  async updateResumeReadiness(
    windows: WindowAnalysis[],
    nowMs = Date.now(),
  ): Promise<ResumeTaskSummary[]> {
    for (const task of this.resumeTasks.active().filter((item) => item.state === "ready")) {
      if (this.resumeAccountMatches(task) && this.hasFreshResumeCapacity(task, nowMs, windows)) continue;
      try {
        this.resumeTasks.markWaiting(task.id, nowMs);
        this.rearmResumeReadyNotification(task, nowMs);
      } catch (error) {
        if (error instanceof ResumeTaskStoreError && (
          error.kind === "state-conflict" || error.kind === "not-found"
        )) continue;
        throw error;
      }
    }
    const ready: ResumeTask[] = [];
    for (let task of this.resumeTasks.waiting()) {
      if (!this.resumeAccountMatches(task)) {
        if (task.errorDetail !== "account-binding-changed") this.resumeTasks.setError(task.id, "account-binding-changed", nowMs);
        continue;
      }
      if (task.errorDetail === "account-binding-changed") task = this.resumeTasks.setError(task.id, "", nowMs);
      const current = windows.find((window) =>
        window.provider === task.provider &&
        window.account === task.account &&
        window.bucket === task.bucket
      );
      if (current && current.resetsAtMs !== task.expectedResetAtMs) {
        try {
          task = this.resumeTasks.updateExpectedReset(task.id, current.resetsAtMs, nowMs);
        } catch (error) {
          if (error instanceof ResumeTaskStoreError && (
            error.kind === "state-conflict" || error.kind === "not-found"
          )) continue;
          throw error;
        }
      }
      const recovered = this.resumeAccountMatches(task) && this.hasFreshResumeCapacity(task, nowMs, windows) &&
        current?.remainingPercent != null &&
        (task.registeredRemainingPercent >= 100 || current.remainingPercent > task.registeredRemainingPercent + 0.01);
      if (!recovered) continue;
      try {
        ready.push(this.resumeTasks.markReady(task.id, nowMs));
      } catch (error) {
        // An HTTP action may have dismissed it after waiting() returned. The
        // guarded update is the authority; a lost race is not a failed tick.
        if (error instanceof ResumeTaskStoreError && (
          error.kind === "state-conflict" || error.kind === "not-found"
        )) continue;
        throw error;
      }
    }
    await this.deliverResumeReadyNotifications();
    return ready.map((task) => this.resumeTaskSummary(task));
  }

  private rearmResumeReadyNotification(task: ResumeTask, nowMs = Date.now()): void {
    if (!this.config.alerts.enabled) return;
    const key = `resume:${task.id}:ready`;
    const state = this.alerts.state(key);
    if (state) this.rearmAlertNotification(key, state.lastFiredAtMs, nowMs);
  }

  private rearmAlertNotification(key: string, lastFiredAtMs: number, nowMs = Date.now()): void {
    this.alerts.setState(key, lastFiredAtMs, true, nowMs);
  }

  private async deliverDecision(
    decision: TriggerDecision,
    deliveryKey: string,
    rememberChannels = true,
  ) {
    const nativeConsumerAvailable = this.nativeNotificationTransportAvailable &&
      this.alerts.hasNativeNotificationConsumer();
    return deliverTrigger(decision, this.config, {
      alreadyDelivered: rememberChannels ? this.alerts.deliveredChannels(deliveryKey) : [],
      deliveryKey,
      onChannelSuccess: rememberChannels
        ? (channel) => this.alerts.markChannelDelivered(deliveryKey, channel, Date.now())
        : undefined,
      queueMacOSNotification: nativeConsumerAvailable
        ? (notification, key) => this.alerts.queueMacOSNotification(notification, key)
        : undefined,
    });
  }

  notificationPreferences() {
    return { enabled: this.config.alerts.enabled, topics: { ...this.config.alerts.topics },
      usageSpeed: this.config.profile.showUsageSpeed, paceForecasts: this.config.alerts.paceForecasts,
      desktopEnabled: this.config.alerts.macOSNotifications, resetCollectionEnabled: this.config.resetSignals.enabled };
  }

  resumeGate(provider: Provider, account: string, nowMs = Date.now(), requiredBucket?: string) {
    let state = this.accountStates(nowMs, this.currentQuotaWindows(nowMs)).find(item => item.provider === provider && item.account === account);
    const maxAgeMs = this.config.collection.staleAfterSeconds * 1000;
    if (state && provider === "codex") {
      let cutoff = NaN;
      try { cutoff = explicitAccountReserve(account, readPoolPolicy()); } catch { /* Invalid execution policy cannot admit work. */ }
      // Forecast reserves remain presentation inputs. Only an explicit enabled
      // execution cutoff stops available subscription quota. A transient failed
      // poll does not invalidate the still-fresh authoritative sample below.
      state = { ...state, windows: state.windows.map(window => ({ ...window, reservePercent: cutoff })),
        collection: state.collection.health === "attempted-then-failed" &&
          ["provider-error", "network"].includes(state.collection.errorCategory ?? "")
          ? { ...state.collection, health: "recent-success", errorCategory: null } : state.collection };
    }
    const gate = evaluateResumeGate(state, provider, account, nowMs, maxAgeMs, requiredBucket);
    if (gate.windows.length) gate.validUntilMs = Math.min(...gate.windows.map(window => window.observedAtMs + maxAgeMs));
    gate.profileKey = resumeProfileKey(this.config, provider, account);
    const profile = provider === "codex" ? this.config.accounts.codex.find(p => p.id === account && p.enabled) : null;
    gate.accountKey = profile ? this.accountBindings.identityKey(codexProfileRoot(profile)) : null;
    if (!gate.profileKey) { gate.ready = false; gate.reason = "account-unavailable"; }
    gate.resetOpportunities = this.resetOpportunities(provider, account, nowMs);
    return gate;
  }

  resetPlanning(accounts: Array<{ provider: Provider; account: string }>, nowMs = Date.now()) {
    const signals = this.resetSignals.list(1000), events = this.db.recentEvents(2000);
    const cases = this.resetTimingCases();
    return accounts.map(account => {
      const accountEvents = events.filter(e => e.account === account.account);
      return { ...account,
        opportunities: resetOpportunities(signals, events, account.provider, account.account, nowMs, {cases}),
        closedSignalIDs: signals.filter(s => (s.provider ?? "codex") === account.provider &&
          resetSignalClosed(s, signals, accountEvents, nowMs)).map(s => s.id),
      };
    });
  }

  resetOpportunities(provider: Provider, account: string, nowMs = Date.now(), options: {maxAgeMinutes?: number; bucket?: string} = {}) {
    return resetOpportunities(this.resetSignals.list(1000), this.db.recentEvents(2000), provider, account, nowMs,
      {...options, cases: this.resetTimingCases()});
  }

  private workOpportunity(policy: WorkPolicy, nowMs = Date.now()) {
    return this.resetOpportunities(policy.provider, policy.account, nowMs,
      {maxAgeMinutes: policy.opportunityMaxAgeMinutes, bucket: policy.resetBucket})
      .filter(o => o.actionableFromMs <= nowMs && o.expiresAtMs > nowMs)
      .sort((a,b) => b.publishedAtMs - a.publishedAtMs)[0];
  }

  private workForecast(policy: WorkPolicy, nowMs: number): WorkForecast | null {
    if (!policy.resetBucket) return null;
    const opportunity = this.workOpportunity(policy, nowMs);
    if (!opportunity) return null;
    const key = `${policy.id}:${policy.revision}:${opportunity.signalId}`;
    const cached = this.workForecastCache.get(key);
    if (cached && cached.expiresAtMs > nowMs) return cached.forecast;
    const estimatedWorkMinutes = this.work.estimatedWorkMinutes(policy);
    const horizonAtMs = planWork(policy, nowMs, {estimatedWorkMinutes}).horizonAtMs;
    if (horizonAtMs <= nowMs) return null;
    const signal = this.resetSignals.list(1000).find(s => s.id === opportunity.signalId);
    const publication = this.resetTiming.issueForecast({signalId: signal?.sourcePostId ?? opportunity.signalId,
      provider: policy.provider, account: policy.account, bucket: policy.resetBucket, horizonAtMs, now: nowMs,
      policyId: policy.id, policyVersion: policy.revision, earlyResetQuantile: policy.earlyResetQuantile, historyDays: policy.timingHistoryDays});
    const forecast: WorkForecast | null = publication ? {id: publication.id, eventId: publication.eventId,
      actionProbabilityEstimate: publication.actionProbabilityEstimate, quantileAtMs: publication.actionProbabilityEstimate === null ? null : publication.quantileAtMs,
      horizonAtMs: publication.horizonAtMs, calibrationStatus: publication.calibrationStatus} : null;
    for (const [id,value] of this.workForecastCache) if (value.expiresAtMs <= nowMs) this.workForecastCache.delete(id);
    this.workForecastCache.set(key, {expiresAtMs: Math.min(horizonAtMs, nowMs + 60_000), forecast});
    return forecast;
  }

  resetTimingStatus() {
    try { return { ...this.resetTiming.summary(), error: this.resetTimingError }; }
    catch { return { cases: [], evaluation: null, error: "timing-history-unavailable" }; }
  }

  private resetTimingCases() {
    try { return this.resetTiming.list(); }
    catch { return []; }
  }

  refreshResetTiming(nowMs = Date.now()): void {
    try {
    const contexts = this.storage.db.query<{provider:Provider; account:string; at:number}, []>(
      "SELECT provider,account,MAX(occurred_at_ms) AS at FROM events WHERE kind IN ('account_changed','plan_changed') GROUP BY provider,account"
    ).all();
    const accounts = [...new Map(this.db.latestAll().map(o => [`${o.provider}:${o.account}`, { provider: o.provider, account: o.account,
      contextAtMs: contexts.find(c=>c.provider===o.provider&&c.account===o.account)?.at ?? 0 }])).values()];
    const policyDays = this.work.store.list().map(p => p.timingHistoryDays ?? 365);
    // A task learning window must never shorten the shared application history.
    const retentionDays = Math.max(365, ...policyDays);
    const events = this.storage.db.query<{provider: Provider; account: string; bucket: string; kind: QuotaEvent["kind"]; occurred_at_ms: number; details_json: string}, [number]>(
      "SELECT provider,account,bucket,kind,occurred_at_ms,details_json FROM events WHERE kind IN ('external_relief','allowance_relief') AND occurred_at_ms >= ? ORDER BY occurred_at_ms DESC LIMIT 5000"
    ).all(nowMs - retentionDays * 86400000).map(r => ({ provider:r.provider, account:r.account, bucket:r.bucket, kind:r.kind,
      occurredAtMs:r.occurred_at_ms, details:JSON.parse(r.details_json), severity:"info" as const, confidence:"high" as const, displayText:"" }));
    this.resetTiming.setRetentionDays(retentionDays);
    for (const observation of this.db.latestAll()) {
      this.resetTiming.recordCoverage({id: `${observation.provider}:${observation.account}:${observation.bucket}:${observation.observedAtMs}`,
        provider: observation.provider, account: observation.account, bucket: observation.bucket, observedAtMs: observation.observedAtMs,
        success: observation.quality === "authoritative", resetDetectable: false});
    }
    for (const state of this.collection.sourceStates()) if (state.lastAttemptMs != null && state.lastError) {
      for (const observation of this.db.latestAll().filter(o => o.provider === state.provider && o.account === state.account))
        this.resetTiming.recordCoverage({id: `failure:${state.provider}:${state.account}:${state.source}:${state.lastAttemptMs}:${observation.bucket}`,
          provider: state.provider, account: state.account, bucket: observation.bucket, observedAtMs: state.lastAttemptMs,
          success: false, resetDetectable: false});
    }
    this.resetTiming.sync(this.resetSignals.list(1000), events, accounts, nowMs);
    this.resetTimingError = null;
    } catch {
      // Advisory measurement must not interrupt collection, quota publication or work.
      this.resetTimingError = "timing-history-update-failed";
      console.error("[quotapie] reset timing history update failed");
    }
  }

  applyNotificationPreferences(patch: NotificationPreferencesPatch): void {
    if (patch.enabled != null) this.config.alerts.enabled = patch.enabled;
    if (patch.usageSpeed != null) this.config.profile.showUsageSpeed = patch.usageSpeed;
    if (patch.paceForecasts != null) this.config.alerts.paceForecasts = patch.paceForecasts;
    Object.assign(this.config.alerts.topics, patch.topics);
    this.cancelMutedNotifications();
  }

  private cancelMutedNotifications(nowMs = Date.now()): void {
    this.alerts.cancelAppNotificationsWhere(item => !notificationAllowed(item, this.config.alerts), nowMs);
  }

  claimNextAppNotification(nowMs = Date.now()): AppNotificationClaim | null {
    this.cancelMutedNotifications(nowMs);
    this.cancelObsoleteJobNotifications(nowMs);
    this.cancelObsoleteWorkNotifications(nowMs);
    if (!this.config.alerts.enabled || !this.config.alerts.macOSNotifications) {
      this.alerts.cancelAllAppNotifications(nowMs);
      return null;
    }
    return this.alerts.claimNextAppNotification(nowMs);
  }

  async retrySuppressedNotifications(nowMs = Date.now()): Promise<void> {
    if (!this.config.alerts.enabled || !this.config.alerts.macOSNotifications) return;
    const suppressed = new Set(this.alerts.suppressedThresholdKeys());
    if (!suppressed.size) return;
    const windows = this.analyses(nowMs);
    const active = planTriggers(windows, [], this.notificationConfig(), nowMs, nowMs);
    let retry = false;
    for (const decision of active) {
      const state = this.alerts.state(decision.key);
      if (suppressed.has(decision.key) && state && !state.armed) {
        // Suppression never reached the user, so its old cooldown must not
        // postpone the first visible warning after permission is restored.
        this.rearmAlertNotification(decision.key, 0, nowMs);
        retry = true;
      }
    }
    if (retry) await this.evaluateTriggers(nowMs, windows);
  }

  completeAppNotification(
    id: string,
    claimToken: string,
    disposition: AppNotificationDisposition,
    nowMs = Date.now(),
  ): boolean {
    return this.alerts.completeAppNotification(id, claimToken, disposition, nowMs);
  }

  releaseAppNotification(id: string, claimToken: string): boolean {
    return this.alerts.releaseAppNotification(id, claimToken);
  }

  renewAppNotification(id: string, claimToken: string, nowMs = Date.now()): boolean {
    this.cancelMutedNotifications(nowMs);
    this.cancelObsoleteJobNotifications(nowMs);
    this.cancelObsoleteWorkNotifications(nowMs);
    return this.alerts.renewAppNotification(id, claimToken, nowMs);
  }

  setNativeNotificationTransportAvailable(available: boolean): void {
    this.nativeNotificationTransportAvailable = available;
  }

  async deliverTestAlert(): Promise<{
    complete: boolean;
    nativeAppQueued: boolean;
  }> {
    const decision: TriggerDecision = {
      key: `manual:test:${randomUUID()}`,
      title: t("alert.test.title", {}, this.locale),
      message: t("alert.test.message", {}, this.locale),
      presentation: {
        title: { key: "alert.test.title", params: {} },
        message: { key: "alert.test.message", params: {} },
      },
      severity: "info",
    };
    const nativeConsumerAvailable = this.nativeNotificationTransportAvailable &&
      this.alerts.hasNativeNotificationConsumer();
    const result = await this.deliverDecision(decision, decision.key, false);
    return {
      complete: result.complete,
      nativeAppQueued: nativeConsumerAvailable && result.succeededChannels.includes(MACOS_NOTIFICATION_CHANNEL),
    };
  }

  private async deliverResumeReadyNotifications(): Promise<void> {
    const hasChannel = (
      this.config.alerts.macOSNotifications && process.platform === "darwin"
    ) || Boolean(this.config.alerts.command?.length);
    if (!hasChannel) return;
    for (const task of this.resumeTasks.active().filter((item) => item.state === "ready")) {
      const titleParams = notificationAccountParams(this.notificationConfig(), task.provider, task.account);
      const messageParams = { label: task.projectLabel };
      const decision: TriggerDecision = {
        key: `resume:${task.id}:ready`,
        title: t("alert.resume.ready.title", titleParams, this.locale),
        message: t("alert.resume.ready.message", messageParams, this.locale),
        presentation: {
          title: { key: "alert.resume.ready.title", params: titleParams },
          message: { key: "alert.resume.ready.message", params: messageParams },
        },
        severity: "info",
      };
      const claim = this.alerts.claim(decision.key, Date.now(), 0);
      if (!claim) continue;
      const deliveryKey = `threshold:${decision.key}:${claim.generation}`;
      let complete = false;
      let suppressed = false;
      try {
        const result = await this.deliverDecision(decision, deliveryKey);
        complete = result.complete;
        suppressed = result.suppressed ?? false;
      } catch (error) {
        console.error(`[quotapie] Resume-ready notification error: ${String(error)}`);
      }
      if (complete) {
        if (!this.alerts.completeClaim(decision.key, claim.token, Date.now(), suppressed ? "suppressed" : "delivered")) {
          console.error(`[quotapie] Resume-ready notification claim expired: ${task.id}`);
        }
      } else {
        this.alerts.releaseClaim(decision.key, claim.token);
        console.error(`[quotapie] Resume-ready notification failed: ${task.id}`);
      }
    }
  }

  /** Uses the existing durable outbox and the user's resume notification preference. */
  async deliverJobNotifications(): Promise<void> {
    if (this.jobNotifications) return this.jobNotifications;
    this.jobNotifications = (async () => {
      this.cancelObsoleteJobNotifications();
      const undelivered = new Set(this.alerts.suppressedThresholdKeys(true));
      for (const job of this.jobs.notificationSummaries()) {
        const state = job.state;
        if (state !== "ready" && state !== "succeeded" && state !== "failed" && state !== "review") continue;
        if (state === "ready" && (job.policy.mode === "auto" || this.jobs.get(job.id)?.approvalValid)) continue;
        const messageKey = `alert.jobs.${state}.message` as const;
        const decision: TriggerDecision = {
          key: `jobs:${job.id}:${state}:${job.attemptCount}:${job.updatedAtMs}`,
          title: t("alert.jobs.title", { label: job.label }, this.locale),
          message: t(messageKey, {}, this.locale),
          presentation: { title: { key: "alert.jobs.title", params: { label: job.label } }, message: { key: messageKey, params: {} } },
          severity: state === "failed" || state === "review" ? "warning" : "info",
        };
        if (!notificationAllowed(decision, this.config.alerts)) continue;
        // A denied OS permission or muted native outbox is not delivery. Only
        // the exact current state is eligible, and topic mute is checked above.
        if (undelivered.has(decision.key)) {
          this.rearmAlertNotification(decision.key, 0);
        }
        const claim = this.alerts.claim(decision.key, Date.now(), 0);
        if (!claim) continue;
        try {
          const result = await this.deliverDecision(decision, `threshold:${decision.key}:${claim.generation}`);
          if (result.complete) this.alerts.completeClaim(decision.key, claim.token, Date.now(), result.suppressed ? "suppressed" : "delivered");
          else this.alerts.releaseClaim(decision.key, claim.token);
        } catch { this.alerts.releaseClaim(decision.key, claim.token); }
      }
    })().finally(() => { this.jobNotifications = null; });
    return this.jobNotifications;
  }

  /** A notification policy never claims a model turn. The durable outbox keeps
   * polling and restarts from repeating the same policy/event notification. */
  async deliverWorkNotifications(): Promise<void> {
    if (!this.work.store.list().length) return;
    this.cancelObsoleteWorkNotifications();
    const undelivered = new Set(this.alerts.suppressedThresholdKeys(true));
    for (const policy of this.work.list()) {
      if (!policy.enabled) continue;
      const reason = policy.admission.reason;
      if (!["notification-only", "forecast-unavailable-notify"].includes(reason)) continue;
      const opportunity = this.workOpportunity(policy);
      if (!opportunity) continue;
      const messageKey = reason === "notification-only" ? "alert.work.notice.message" : "alert.work.forecastUnavailable.message";
      const decision: TriggerDecision = {
        key: `work:${policy.id}:${policy.revision}:${opportunity.signalId}:${reason}`,
        title: t("alert.jobs.title", {label: policy.objective}, this.locale), message: t(messageKey, {}, this.locale),
        presentation: {title: {key: "alert.jobs.title", params: {label: policy.objective}}, message: {key: messageKey, params: {}}}, severity: "info",
      };
      if (!notificationAllowed(decision, this.config.alerts)) continue;
      if (undelivered.has(decision.key)) this.rearmAlertNotification(decision.key, 0);
      const claim = this.alerts.claim(decision.key, Date.now(), 0);
      if (!claim) continue;
      try {
        const result = await this.deliverDecision(decision, `threshold:${decision.key}:${claim.generation}`);
        if (result.complete) this.alerts.completeClaim(decision.key, claim.token, Date.now(), result.suppressed ? "suppressed" : "delivered");
        else this.alerts.releaseClaim(decision.key, claim.token);
      } catch { this.alerts.releaseClaim(decision.key, claim.token); }
    }
  }

  private cancelObsoleteWorkNotifications(nowMs = Date.now()): void {
    const policies = this.work.store.list().length ? this.work.list() : [];
    const validKeys = new Set(policies.filter(p => p.enabled).flatMap(p => {
      const opportunity = this.workOpportunity(p, nowMs);
      return opportunity && ["notification-only", "forecast-unavailable-notify"].includes(p.admission.reason)
        ? [`work:${p.id}:${p.revision}:${opportunity.signalId}:${p.admission.reason}`] : [];
    }));
    this.alerts.cancelAppNotificationsWhere(item => item.alertKey.startsWith("work:") && !validKeys.has(item.alertKey), nowMs);
  }

  private cancelObsoleteJobNotifications(nowMs = Date.now()): void {
    this.alerts.cancelAppNotificationsWhere(item => {
      if (!item.alertKey.startsWith("jobs:")) return false;
      const [, id, state, attempt, updatedAt] = item.alertKey.split(":");
      const job = id ? this.jobs.get(id, nowMs) : null;
      return !job || job.state !== state || String(job.attemptCount) !== attempt || String(job.updatedAtMs) !== updatedAt ||
        (state === "ready" && (job.spec.policy.mode === "auto" || job.approvalValid));
    }, nowMs);
  }

  private hasFreshResumeCapacity(task: ResumeTask, nowMs: number, windows = this.analyses(nowMs, task.provider)): boolean {
    let reserve = 0;
    if (task.provider === "codex") {
      try { reserve = explicitAccountReserve(task.account, readPoolPolicy()); }
      catch { return false; }
    }
    const scoped = windows.filter(w => w.provider === task.provider && w.account === task.account)
      .map(w => ({ ...w, reservePercent: reserve }));
    const gate = evaluateResumeWindows(scoped, task.provider, task.account, nowMs,
      this.config.collection.staleAfterSeconds * 1000, task.bucket);
    return gate.ready && gate.windows.some(w => w.bucket === task.bucket && w.observedAtMs > task.registeredAtMs);
  }

  recentEvents(limit = 50): QuotaEvent[] {
    return this.db.recentEvents(limit);
  }

  resetTracking(nowMs = Date.now(), accounts = this.accountStates(nowMs)) {
    return buildResetTracking(this.db, accounts, this.resetSignals.list(200), nowMs,
      this.config.collection.staleAfterSeconds * 1000);
  }

  private rearmRecovered(windows: WindowAnalysis[], nowMs = Date.now()): void {
    for (const window of windows) {
      if (window.freshness === "fresh") {
        const staleKey = `${alertScope(window.provider, window.account, window.bucket)}:stale`;
        const staleState = this.alerts.state(staleKey);
        if (staleState) {
          this.rearmAlertNotification(staleKey, staleState.lastFiredAtMs, nowMs);
        }
      }
      if (window.freshness === "fresh" && window.remainingPercent != null) {
        for (const threshold of this.config.alerts.remainingThresholds) {
          const key = `${alertScope(window.provider, window.account, window.bucket)}:remaining:${threshold}`;
          const state = this.alerts.state(key);
          if (state && !state.armed && window.remainingPercent > threshold + 5) {
            this.rearmAlertNotification(key, 0, nowMs);
          }
        }
      }
      const paceKey = `${alertScope(window.provider, window.account, window.bucket)}:pace`;
      const paceState = this.alerts.state(paceKey);
      if (paceState && (!this.config.alerts.paceForecasts || window.paceRatio == null || window.paceRatio < 0.9 || !window.recentBurnPerHour)) {
        this.rearmAlertNotification(paceKey, paceState.lastFiredAtMs, nowMs);
      }
      const rapidKey = `${alertScope(window.provider, window.account, window.bucket)}:rapid`;
      const rapidState = this.alerts.state(rapidKey);
      if (rapidState && !rapidState.armed && window.freshness === "fresh" &&
          (window.rapidDropPercent ?? 0) < this.config.alerts.rapidDropPercent / 2) {
        this.rearmAlertNotification(rapidKey, 0, nowMs);
      }
    }
  }

  async evaluateTriggers(nowMs = Date.now(), analysed?: WindowAnalysis[]): Promise<TriggerDecision[]> {
    const windows = analysed ?? this.analyses(nowMs);
    this.rearmRecovered(windows, nowMs);
    const decisions = planTriggers(
      windows,
      this.alerts.pendingEvents().filter((event) => this.isEnabledAccount(event.provider, event.account)),
      this.notificationConfig(),
      0,
      nowMs,
    );
    const delivered: TriggerDecision[] = [];
    const cooldownMs = this.config.alerts.cooldownMinutes * 60_000;
    for (const decision of decisions) {
      const claimAtMs = Date.now();
      const eventClaimToken = decision.eventId != null
        ? this.alerts.claimEvent(decision.eventId, decision.key, claimAtMs, cooldownMs)
        : null;
      const thresholdClaim = decision.eventId == null
        ? this.alerts.claim(decision.key, claimAtMs, cooldownMs)
        : null;
      const claimToken = eventClaimToken ?? thresholdClaim?.token ?? null;
      if (claimToken == null) continue;
      const deliveryKey = decision.eventId != null
        ? `event:${decision.eventId}`
        : `threshold:${decision.key}:${thresholdClaim!.generation}`;
      let deliveryComplete = false;
      let suppressed = false;
      try {
        const result = await this.deliverDecision(decision, deliveryKey);
        deliveryComplete = result.complete;
        suppressed = result.suppressed ?? false;
      } catch (error) {
        console.error(`[quotapie] Trigger delivery error: ${String(error)}`);
      }
      if (deliveryComplete) {
        const completedAtMs = Date.now();
        const disposition = suppressed ? "suppressed" : "delivered";
        const completed = decision.eventId != null
          ? this.alerts.completeEvent(decision.eventId, decision.key, claimToken, completedAtMs, disposition)
          : this.alerts.completeClaim(decision.key, claimToken, completedAtMs, disposition);
        if (completed && !suppressed) delivered.push(decision);
        else if (!completed) console.error(`[quotapie] Trigger claim expired before completion: ${decision.key}`);
      } else {
        if (decision.eventId != null) {
          this.alerts.releaseEvent(decision.eventId, decision.key, claimToken);
        } else {
          this.alerts.releaseClaim(decision.key, claimToken);
        }
        console.error(`[quotapie] Trigger delivery failed: ${decision.key}`);
      }
    }
    return delivered;
  }

  async tick(evaluationTimeMs?: number): Promise<{
    events: QuotaEvent[];
    triggers: TriggerDecision[];
    windows: WindowAnalysis[];
    collected: boolean;
  }> {
    const collectionStartedAtMs = evaluationTimeMs ?? Date.now();
    let events: QuotaEvent[] = [];
    try {
      events = await this.pollCodex();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[quotapie] Codex refresh failed: ${message}`);
    }
    events = events.concat(await this.pollClaudeOAuth(collectionStartedAtMs));
    // Asynchronous provider reads timestamp their observations when they finish.
    // Evaluate against the post-read clock, preserving an explicitly supplied
    // clock for deterministic callers.
    const nowMs = evaluationTimeMs ?? Date.now();
    const collected = this.anyProviderCollectedRecently(nowMs);
    this.refreshResetTiming(Date.now());
    this.db.maybePrune(nowMs, this.config.profile.historyDays);
    this.resumeTasks.pruneTerminal(nowMs - this.config.profile.historyDays * 86_400_000);
    // One analysis pass per tick. It feeds the triggers, the boundary file, and
    // the wake schedule, all of which used to recompute it independently.
    const windows = this.analyses(nowMs);
    await this.updateResumeReadiness(windows, nowMs);
    // Only explicitly linked sessions are read. Goal failures are isolated from
    // quota readiness and never dispatch or complete a host turn.
    void this.refreshHostGoals().catch(() => {});
    // Provider observations are timestamped when their asynchronous reads finish.
    // Never compare them with the time captured before those reads began.
    const jobsNowMs = Date.now();
    if (this.jobsEnabled) this.jobRunner.tick(windows, jobsNowMs);
    else this.jobRunner.evaluate(windows, jobsNowMs);
    await this.deliverJobNotifications();
    await this.deliverWorkNotifications();
    const triggers = await this.evaluateTriggers(nowMs, windows);
    await this.publishBoundary(nowMs, windows);
    return { events, triggers, windows, collected };
  }

  /// Whether any source produced a sample recently enough for this tick to
  /// count as having reached a provider. Judged from the same heartbeat every
  /// other surface reads, rather than from whether a poll call happened to
  /// return without throwing.
  private anyProviderCollectedRecently(nowMs: number): boolean {
    const staleAfterMs = this.config.collection.staleAfterSeconds * 1_000;
    return this.collection.sourceStates().some((row) =>
      row.lastSuccessMs != null && nowMs - row.lastSuccessMs <= staleAfterMs
    );
  }

  publishWorkBoundary(nowMs = Date.now(), analysed?: WindowAnalysis[]): void {
    if (this.workBoundaryPath === null) return;
    try {
      writeWorkBoundary(buildWorkBoundary(this.accountStates(nowMs, analysed ?? this.currentQuotaWindows(nowMs)), this.resumeTasks.active(), this.config, nowMs), this.workBoundaryPath);
    } catch (error) {
      console.error(`[quotapie] work-state.json publish failed: ${String(error)}`);
    }
  }

  async publishBoundary(nowMs = Date.now(), analysed?: WindowAnalysis[]): Promise<void> {
    // A push can arrive while this tick awaits alerts/jobs. Never overwrite its
    // routing protection with the older analysis captured at tick start.
    this.publishWorkBoundary();
    if (this.quotaBoundaryPath === null) return;
    try {
      const accounts = this.accountStates(nowMs, analysed);
      const document = buildQuotaBoundary(
        accounts,
        buildHeadline(accounts, nowMs, this.locale),
        nowMs,
        await cachedLeaderboard(nowMs),
      );
      writeQuotaBoundary(document, this.quotaBoundaryPath);
    } catch (error) {
      // A failed boundary write must not kill the collection and alert tick
      // that is this loop's actual job.
      console.error(`[quotapie] quota.json publish failed: ${String(error)}`);
    }
  }

  /// A failing provider must not turn this into a busy loop.
  ///
  /// The wake schedule is computed from the windows this tick already analysed
  /// rather than by analysing everything a second time, and a tick that reached
  /// no provider at all backs off instead of retrying a second later. Without
  /// the backoff, an account whose credentials have gone stale spins this loop
  /// once a second, and each pass rescans the whole snapshot history — enough
  /// to starve the HTTP server that the menu bar app depends on.
  static readonly FAILURE_BACKOFF_MS = [5_000, 15_000, 30_000];

  static collectionRetryDelay(scheduled: number, failures: number): number {
    if (failures <= 0) return scheduled;
    // Failure recovery must not inherit a long normal poll interval. Preserve
    // backoff against busy loops, but discover restored connectivity promptly.
    return QuotaPieService.FAILURE_BACKOFF_MS[
      Math.min(failures - 1, QuotaPieService.FAILURE_BACKOFF_MS.length - 1)
    ]!;
  }

  async collectResetSignals(): Promise<void> {
    if (this.signalWork) return this.signalWork;
    this.signalWork = (async () => {
      const evidenceVersion = () => (this.resetSignals.health().sources ?? [])
        .map(source => `${source.id}:${source.lastEvidenceMs ?? ""}`).sort().join("|");
      const before = evidenceVersion();
      await this.signalCollector.poll();
      if (this.closing || !this.config.resetSignals.enabled) return;
      this.refreshResetTiming(Date.now());
      if (evidenceVersion() !== before) {
        this.workForecastCache.clear();
        // Wake the quota loop so newly collected announcements reach the
        // runner promptly, with fresh account checks before dispatch.
        if (this.jobsEnabled) this.requestCollection();
      }
      for (const signal of this.resetSignals.pending(Date.now())) {
        if (this.closing) break;
        const remaining = this.accountStates(Date.now(), this.currentQuotaWindows(Date.now()))
          .filter(account => account.provider === (signal.provider ?? "codex"))
          .flatMap(account => account.windows.filter(window => window.freshness === "fresh" && window.remainingPercent != null)
            .map(window => `${account.accountLabel} · ${window.label}: ${Math.round(window.remainingPercent!)}% ${this.locale === "ko" ? "남음" : "remaining"}`));
        const decision = signalDecision(signal, this.locale, this.config.profile.timeZone, remaining);
        const claim = this.alerts.claim(decision.key, Date.now(), 0);
        if (!claim) continue;
        try {
          const result = await this.deliverDecision(decision, decision.key);
          if (result.complete) {
            this.resetSignals.delivered(signal.fingerprint);
            this.alerts.completeClaim(decision.key, claim.token, Date.now(), result.suppressed ? "suppressed" : "delivered");
          } else this.alerts.releaseClaim(decision.key, claim.token);
        } catch { this.alerts.releaseClaim(decision.key, claim.token); }
      }
    })().finally(() => { this.signalWork = null; });
    return this.signalWork;
  }

  private refreshRequested = false;
  private wakeCollection: (() => void) | null = null;

  requestCollection(): void {
    this.refreshRequested = true;
    this.wakeCollection?.();
  }

  async watch(): Promise<void> {
    this.stopped = false;
    this.jobsEnabled = true;
    if (this.config.resetSignals.enabled && !this.signalTimer) {
      const collect = () => { void this.collectResetSignals().catch(() => undefined); };
      collect();
      this.signalTimer = setInterval(collect, 30_000);
    }
    let consecutiveFailures = 0;
    while (!this.stopped) {
      this.refreshRequested = false;
      const { collected, windows } = await this.tick();
      consecutiveFailures = collected ? 0 : consecutiveFailures + 1;
      if (this.stopped) break;
      const scheduled = nextWakeDelayMs(windows, this.config);
      const delay = QuotaPieService.collectionRetryDelay(scheduled, consecutiveFailures);
      if (this.refreshRequested) continue;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); this.wakeCollection = null; resolve(); };
        const timer = setTimeout(finish, delay);
        this.wakeCollection = finish;
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.wakeCollection?.();
    if (this.signalTimer) clearInterval(this.signalTimer);
    this.signalTimer = null;
  }

  async close(): Promise<void> {
    this.stop();
    this.closing = true;
    this.nativeNotificationTransportAvailable = false;
    await Promise.all([...this.goalClients.values()].map(client => client.close().catch(() => undefined)));
    await this.hostGoalRefresh?.catch(() => undefined);
    await Promise.allSettled([...this.goalLinkReads.values()]);
    this.goalClients.clear();
    await this.jobRunner.close();
    await this.jobNotifications;
    await this.signalWork;
    await this.recentWorkRefresh;
    await this.signalCollector.settle();
    await Promise.all([...this.codexClients.values()].map((client) => client.close().catch(() => undefined)));
    this.codexClients.clear();
    this.db.close();
  }
}
