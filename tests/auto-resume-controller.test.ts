import { afterEach, expect, test } from "bun:test";
import { AutoResumeController, type AutoResumeAccount, type AutoResumeDependencies, type QuotaResumeIncident } from "../src/quota-resume/controller";
import { QuotaResumeEvidenceUnavailableError, type QuotaResumeEvidence } from "../src/quota-resume/evidence";
import type { CodexThreadTurnSummary } from "../src/providers/codex-appserver";
import { QuotaStorage } from "../src/storage/database";
import { WorkStore } from "../src/work/store";
import type { WorkPolicyInput } from "../src/work/types";

const threadId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const nextThreadId = "33333333-3333-4333-8333-333333333333";
const nextTurnId = "44444444-4444-4444-8444-444444444444";
const resources: Array<{ db: QuotaStorage; controllers: AutoResumeController[] }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await Promise.all(resource.controllers.map(controller => controller.close()));
    resource.db.close();
  }
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function policyInput(incident: QuotaResumeIncident): WorkPolicyInput {
  return { id: incident.policyId, provider: "codex", account: incident.account, profileKey: incident.profileKey,
    accountKey: incident.accountKey, nativeSessionId: incident.threadId, cwd: incident.evidence.cwd,
    purpose: "quota-resume", quotaResume: { turnId: incident.evidence.turnId, stamp: incident.evidence.stamp },
    prompt: "Continue the original request once", objective: "One continuation", completionCriteria: ["One turn ended"],
    dispatchOwner: "local", enabled: true, trigger: "quota-ready", resetWithinMinutes: 0,
    budgetByBucket: { weekly: { reservePercent: 0, maxUsagePercent: 100 } },
    maxTurns: 1, maxDurationSeconds: 60, maxTotalDurationSeconds: 60, expiresAtMs: 100_000,
    priority: 0, onReset: "continue" };
}
function fixture() {
  const db = new QuotaStorage(":memory:"), work = new WorkStore(db), controllers: AutoResumeController[] = [];
  resources.push({ db, controllers });
  const state = {
    now: 1_000,
    accounts: [{ account: "plus", label: "Personal", accountKey: "account-a", profileKey: "profile-a" }] as AutoResumeAccount[],
    threads: [{ id: threadId, name: "Project", cwd: "/tmp/project", updatedAtMs: 1_500 }],
    evidence: { threadId, turnId, failedAtMs: 1_500, stamp: "terminal-snapshot", cwd: "/tmp/project", model: "gpt-6.1-sol" } as QuotaResumeEvidence | null,
    latest: { threadId, turnId, status: "failed", errorCode: "usageLimitExceeded", completedAtMs: 1_000 } as CodexThreadTurnSummary | null,
    listCalls: [] as Array<string | null>, evidenceCalls: 0, registrationCalls: 0, disableCalls: [] as string[],
  };
  const deps: AutoResumeDependencies = {
    accounts: () => state.accounts,
    now: () => state.now,
    listThreads: async (_account, cursor) => { state.listCalls.push(cursor); return { data: state.threads, nextCursor: null }; },
    evidence: async () => { state.evidenceCalls++; return state.evidence; },
    latestTurn: async () => state.latest,
    register: async incident => { state.registrationCalls++; work.save(policyInput(incident), null, incident.id); },
    policy: id => work.get(id),
    disable: async id => {
      state.disableCalls.push(id);
      const policy = work.get(id);
      if (policy?.enabled) work.setEnabled(id, false, policy.revision, `disable-${id}-${policy.revision}`);
    },
    admissionReason: () => "quota-recovery-unconfirmed",
  };
  const create = () => { const controller = new AutoResumeController(db, deps); controllers.push(controller); return controller; };
  const controller = create();
  const enroll = async () => { await controller.setEnabled("plus", true); state.now = 2_000; await controller.poll(); return controller.incidents()[0]!; };
  return { db, work, state, deps, controller, create, enroll };
}

test("auto resume starts off and reads no sessions until explicitly enabled", async () => {
  const f = fixture();
  expect(f.controller.status().accounts[0]?.enabled).toBe(false);
  await f.controller.poll();
  expect(f.state.listCalls).toEqual([]);
  expect(f.state.evidenceCalls).toBe(0);
  expect(f.work.list()).toHaveLength(0);
  await expect(f.controller.setEnabled("missing", true)).rejects.toThrow("account-unavailable");
  f.state.accounts[0]!.accountKey = null;
  await expect(f.controller.setEnabled("plus", true)).rejects.toThrow("account-identity-unavailable");
});

test("authorization timestamp excludes historical and future failures but enrolls a later verified quota turn", async () => {
  const f = fixture(); await f.controller.setEnabled("plus", true); f.state.now = 2_000;
  f.state.evidence!.failedAtMs = 999;
  await f.controller.poll(); expect(f.work.list()).toHaveLength(0);
  f.state.evidence!.failedAtMs = 2_001;
  await f.controller.poll(); expect(f.work.list()).toHaveLength(0);
  f.state.evidence!.failedAtMs = 1_500;
  await f.controller.poll();
  expect(f.controller.incidents()).toHaveLength(1);
  expect(f.state.registrationCalls).toBe(1);
  const policy = f.work.list()[0]!;
  expect(policy.quotaResume).toEqual({ turnId, stamp: "terminal-snapshot" });
  expect(policy.accountKey).toBe("account-a"); expect(policy.profileKey).toBe("profile-a");
  expect(f.controller.status().accounts[0]).toMatchObject({ enabled: true, enabledAtMs: 1_000, lastScanAtMs: 2_000 });
});

test("an unavailable candidate marks the scan incomplete while other verified threads continue and later recovery clears the error", async () => {
  const f = fixture();
  f.state.threads.push({ id: nextThreadId, name: "Another project", cwd: "/tmp/project", updatedAtMs: 1_500 });
  let unavailable = true;
  f.deps.evidence = async (_account, id) => {
    if (id === threadId && unavailable) throw new QuotaResumeEvidenceUnavailableError();
    return { ...f.state.evidence!, threadId: id, turnId: id === threadId ? turnId : nextTurnId };
  };
  await f.controller.setEnabled("plus", true); f.state.now = 2_000;
  await f.controller.poll();
  expect(f.controller.status().accounts[0]).toMatchObject({ enabled: true, lastScanAtMs: 2_000, lastError: "scan-unavailable" });
  expect(f.controller.incidents().map(i => i.threadId)).toEqual([nextThreadId]);
  expect(f.work.list()).toHaveLength(1); expect(f.work.executions()).toHaveLength(0);
  await f.controller.poll();
  expect(f.controller.status().accounts[0]?.lastError).toBe("scan-unavailable");
  expect(f.state.registrationCalls).toBe(1);
  unavailable = false; f.state.now = 3_000; await f.controller.poll();
  expect(f.controller.status().accounts[0]).toMatchObject({ lastScanAtMs: 3_000, lastError: null });
  expect(f.controller.incidents()).toHaveLength(2); expect(f.state.registrationCalls).toBe(2);
  expect(f.work.executions()).toHaveLength(0);
});

test("a verified non-candidate is a successful scan and does not create a recovery incident", async () => {
  const f = fixture(); f.state.evidence = null;
  await f.controller.setEnabled("plus", true); f.state.now = 2_000; await f.controller.poll();
  expect(f.controller.status().accounts[0]).toMatchObject({ lastScanAtMs: 2_000, lastError: null });
  expect(f.controller.incidents()).toHaveLength(0); expect(f.work.list()).toHaveLength(0);
});

test("simultaneous scans share one discovery and registration, and later scans do not duplicate it", async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  const original = f.deps.listThreads;
  f.deps.listThreads = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  await f.controller.setEnabled("plus", true); f.state.now = 2_000;
  const first = f.controller.poll(); await entered.promise;
  const second = f.controller.poll(); expect(second).toBe(first);
  release.resolve(); await Promise.all([first, second]);
  await f.controller.poll();
  expect(f.state.registrationCalls).toBe(1);
  expect(f.controller.incidents()).toHaveLength(1);
  expect(f.work.list()).toHaveLength(1);
});

test("collector recreation uses the durable incident and never registers it twice", async () => {
  const f = fixture(), incident = await f.enroll();
  await f.controller.close();
  const restarted = f.create(); await restarted.poll();
  expect(restarted.status().accounts[0]?.enabled).toBe(true);
  expect(restarted.incidents().map(value => value.id)).toEqual([incident.id]);
  expect(f.state.registrationCalls).toBe(1);
  expect(f.work.list()).toHaveLength(1);
});

test("a native writer keeps the incident visibly waiting and registration retries cannot duplicate execution", async () => {
  const f = fixture(), register = f.deps.register;
  let writerPresent = true, attempts = 0;
  f.deps.register = async incident => {
    attempts++;
    if (writerPresent) throw new Error("native-writer-present");
    await register(incident);
  };
  const incident = await f.enroll();
  expect(f.controller.status().incidents[0]).toMatchObject({ state: "waiting", reason: "native-writer-present" });
  expect(f.work.list()).toHaveLength(0); expect(f.work.executions()).toHaveLength(0);
  await f.controller.poll();
  expect(attempts).toBe(2);
  expect(f.controller.status().incidents[0]).toMatchObject({ state: "waiting", reason: "native-writer-present" });
  writerPresent = false;
  await Promise.all([f.controller.poll(), f.controller.poll()]);
  expect(attempts).toBe(3); expect(f.state.registrationCalls).toBe(1);
  expect(f.controller.incidents()).toHaveLength(1); expect(f.work.list()).toHaveLength(1);
  expect(f.controller.incidents()[0]?.reason).toBeUndefined();
  const execution = f.work.claim(incident.policyId, "local", 1, 2_001)!;
  f.work.markDispatched(execution.id, 2_002);
  f.work.finish(execution.id, { status: "turn-finished", remainingWork: "Goal completion is unverified" }, 2_003);
  await f.controller.poll();
  const policy = f.work.get(incident.policyId)!;
  expect(f.work.claim(policy.id, "local", policy.revision, 3_000)).toBeNull();
  expect(f.work.executions()).toHaveLength(1); expect(attempts).toBe(3);
});

test("skip is a durable tombstone through rescans, re-enabling and controller recreation", async () => {
  const f = fixture(), incident = await f.enroll();
  await f.controller.skip(incident.id);
  expect(f.work.get(incident.policyId)?.enabled).toBe(false);
  expect(f.controller.blockPolicy(f.work.get(incident.policyId)!)).toBe("auto-resume-disabled");
  await f.controller.poll();
  await f.controller.setEnabled("plus", false);
  await f.controller.setEnabled("plus", true);
  await f.controller.close(); const restarted = f.create(); await restarted.poll();
  expect(restarted.status().incidents[0]).toMatchObject({ state: "skipped", reason: "skipped" });
  expect(f.state.registrationCalls).toBe(1);
  expect(f.work.get(incident.policyId)?.enabled).toBe(false);
});

test("turning off while evidence is awaited prevents a newly discovered registration", async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  f.deps.evidence = async () => { entered.resolve(); await release.promise; return f.state.evidence; };
  await f.controller.setEnabled("plus", true); f.state.now = 2_000;
  const scan = f.controller.poll(); await entered.promise;
  await f.controller.setEnabled("plus", false); release.resolve(); await scan;
  expect(f.controller.incidents()).toHaveLength(0);
  expect(f.work.list()).toHaveLength(0); expect(f.state.registrationCalls).toBe(0);
});

test("turning off revokes a registration in flight before its delayed save can authorize work", async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  const register = f.deps.register;
  f.deps.register = async incident => { entered.resolve(); await release.promise; await register(incident); };
  await f.controller.setEnabled("plus", true); f.state.now = 2_000;
  const scan = f.controller.poll(); await entered.promise;
  const incident = f.controller.incidents()[0]!;
  await f.controller.setEnabled("plus", false);
  expect(f.controller.blockPolicy({ ...policyInput(incident), revision: 1, state: {
    spentByBucket: {}, baselines: {}, turns: 0, totalDurationSeconds: 0, status: "waiting", activeExecutionId: null,
  } })).toBe("auto-resume-disabled");
  release.resolve(); await scan;
  expect(f.work.get(incident.policyId)?.enabled).toBe(false);
  expect(f.controller.status().incidents[0]?.state).toBe("skipped");
});

test("account or profile changes revoke existing permission and prevent new discovery", async () => {
  for (const field of ["accountKey", "profileKey"] as const) {
    const f = fixture(), incident = await f.enroll(), count = f.state.listCalls.length;
    f.state.accounts[0]![field] = "different-identity";
    expect(f.controller.blockPolicy(f.work.get(incident.policyId)!)).toBe("auto-resume-disabled");
    await expect(f.controller.validatePolicy(f.work.get(incident.policyId)!)).rejects.toThrow("auto-resume-disabled");
    await f.controller.poll();
    expect(f.state.listCalls).toHaveLength(count);
    expect(f.controller.status().accounts[0]?.lastError).toBe("account-binding-changed");
    expect(f.state.registrationCalls).toBe(1);
  }
});

test("an observed account switch permanently revokes the old consent even after switching back", async () => {
  const f = fixture(), incident = await f.enroll();
  f.state.accounts[0]!.accountKey = "account-b";
  const observed = f.controller.status();
  expect(observed.accounts[0]).toMatchObject({ enabled: false, lastError: "account-binding-changed" });
  expect(observed.incidents[0]).toMatchObject({ state: "skipped", reason: "account-binding-changed" });
  f.state.accounts[0]!.accountKey = "account-a";
  f.state.evidence = { ...f.state.evidence!, turnId: nextTurnId, failedAtMs: 2_100 };
  f.state.now = 3_000;
  await f.controller.poll();
  expect(f.controller.status().accounts[0]).toMatchObject({ enabled: false, lastError: "account-binding-changed" });
  expect(f.state.registrationCalls).toBe(1);
  expect(f.work.get(incident.policyId)?.enabled).toBe(false);
  expect(f.controller.blockPolicy(f.work.get(incident.policyId)!)).toBe("auto-resume-disabled");
  await f.controller.close(); const restarted = f.create(); await restarted.poll();
  expect(restarted.status().accounts[0]?.enabled).toBe(false);
  expect(f.state.registrationCalls).toBe(1);
  await restarted.setEnabled("plus", true);
  await restarted.poll(); expect(f.state.registrationCalls).toBe(1);
  f.state.now = 4_000; f.state.evidence!.failedAtMs = 3_500; f.state.threads[0]!.updatedAtMs = 3_500;
  await restarted.poll();
  expect(f.state.registrationCalls).toBe(2);
  expect(restarted.status().accounts[0]).toMatchObject({ enabled: true, enabledAtMs: 3_000, lastError: null });
});

test("binding revocation closes authority synchronously while delayed cleanup runs, and retries cleanup failure", async () => {
  const f = fixture(), incident = await f.enroll(), entered = deferred<void>(), release = deferred<void>();
  const disable = f.deps.disable; let fail = true;
  f.deps.disable = async id => { entered.resolve(); await release.promise; if(fail) throw new Error("temporary-write-failure"); await disable(id); };
  f.state.accounts[0]!.profileKey = "profile-b";
  expect(f.controller.status().accounts[0]?.enabled).toBe(false);
  expect(f.controller.blockPolicy(f.work.get(incident.policyId)!)).toBe("auto-resume-disabled");
  await entered.promise;
  f.state.accounts[0]!.profileKey = "profile-a";
  expect(f.controller.status().accounts[0]?.enabled).toBe(false);
  release.resolve(); await f.controller.poll();
  expect(f.work.get(incident.policyId)?.enabled).toBe(true);
  expect(f.controller.status().accounts[0]?.lastError).toBe("account-binding-changed");
  fail=false; await f.controller.poll();
  expect(f.work.get(incident.policyId)?.enabled).toBe(false);
  expect(f.state.registrationCalls).toBe(1);
});

test("transient missing evidence with the same failed turn remains waiting and can later validate", async () => {
  const f = fixture(), incident = await f.enroll(), original = f.state.evidence;
  const policy = f.work.get(incident.policyId)!;
  f.state.evidence = null;
  await expect(f.controller.validatePolicy(policy)).rejects.toThrow("quota-resume-evidence-unavailable");
  expect(f.controller.incidents()[0]?.state).toBe("waiting");
  expect(f.controller.blockPolicy(policy)).toBeNull();
  f.state.latest = null;
  await expect(f.controller.validatePolicy(policy)).rejects.toThrow("quota-resume-evidence-unavailable");
  expect(f.controller.incidents()[0]?.state).toBe("waiting");
  f.deps.latestTurn = async () => { throw new Error("temporary-api-failure"); };
  await expect(f.controller.validatePolicy(policy)).rejects.toThrow("temporary-api-failure");
  expect(f.controller.incidents()[0]?.state).toBe("waiting");
  f.state.evidence = original;
  await f.controller.validatePolicy(policy);
  expect(f.controller.incidents()[0]?.state).toBe("waiting");
  expect(f.state.registrationCalls).toBe(1);
});

test("confirmed latest completed, interrupted, active or different turns supersede the quota incident", async () => {
  for (const latest of [
    { status: "completed", errorCode: null }, { status: "interrupted", errorCode: null },
    { status: "inProgress", errorCode: null }, { turnId: nextTurnId },
  ] satisfies Partial<CodexThreadTurnSummary>[]) {
    const f = fixture(), incident = await f.enroll();
    f.state.evidence = null; Object.assign(f.state.latest!, latest);
    await expect(f.controller.validatePolicy(f.work.get(incident.policyId)!)).rejects.toThrow("auto-resume-superseded");
    expect(f.controller.status().incidents[0]).toMatchObject({ state: "skipped", reason: "superseded" });
    expect(f.controller.blockPolicy(f.work.get(incident.policyId)!)).toBe("auto-resume-disabled");
    expect(f.work.get(incident.policyId)?.enabled).toBe(false);
  }
});

test("an uncertain execution retains its fence but is presented for review, never as running", async () => {
  const f = fixture(), incident = await f.enroll();
  const execution = f.work.claim(incident.policyId, "local", 1, 2_001)!;
  f.work.markDispatched(execution.id, 2_002);
  expect(f.controller.status().incidents[0]?.state).toBe("running");
  f.work.finish(execution.id, { status: "uncertain", reason: "response-unverified" }, 2_003);
  expect(f.work.get(incident.policyId)?.state.activeExecutionId).toBe(execution.id);
  expect(f.controller.status().incidents[0]).toMatchObject({ state: "needs-review", reason: "response-unverified" });
  await expect(f.controller.skip(incident.id)).rejects.toThrow("auto-resume-already-attempted");
  await f.controller.close(); const restarted = f.create(); await restarted.poll();
  expect(restarted.status().incidents[0]?.state).toBe("needs-review");
  expect(f.state.registrationCalls).toBe(1);
});

test("successful one-turn resumption is distinct from objective completion and remains single-use", async () => {
  const f = fixture(), incident = await f.enroll();
  const execution = f.work.claim(incident.policyId, "local", 1, 2_001)!;
  f.work.markDispatched(execution.id, 2_002);
  f.work.finish(execution.id, { status: "turn-finished", remainingWork: "Objective completion remains unverified" }, 2_003);
  expect(f.controller.status().incidents[0]?.state).toBe("resumed");
  expect(f.work.get(incident.policyId)?.state.status).toBe("turn-finished");
  expect(f.work.get(incident.policyId)?.enabled).toBe(false);
  await f.controller.poll(); expect(f.state.registrationCalls).toBe(1);
  await expect(f.controller.skip(incident.id)).rejects.toThrow("auto-resume-already-attempted");
});

test("a failed automatic turn creates one new incident in the same session across repeated recovery and restart", async () => {
  const f=fixture(), first=await f.enroll();
  const fail=(incident:QuotaResumeIncident,atMs:number)=>{
    const policy=f.work.get(incident.policyId)!;
    const execution=f.work.claim(policy.id,"local",policy.revision,atMs)!;
    f.work.markDispatched(execution.id,atMs+1);
    f.work.finish(execution.id,{status:"quota-blocked",reason:"host-queue-quota-blocked"},atMs+500);
  };
  fail(first,2_001);
  expect(f.controller.status().incidents[0]).toMatchObject({state:"waiting",reason:"quota-recovery-unconfirmed"});
  f.state.now=3_000;
  f.state.evidence={...first.evidence,turnId:nextTurnId,failedAtMs:2_500,stamp:"second-failure",recoveryIncidentId:first.id};
  await f.controller.poll();
  const second=f.controller.incidents()[0]!;
  expect(second.id).not.toBe(first.id);
  expect(second.evidence.recoveryIncidentId).toBe(first.id);
  expect(second.threadId).toBe(threadId);
  expect(f.state.registrationCalls).toBe(2);
  expect(f.controller.status().incidents.map(i=>i.id)).toEqual([second.id]);
  await f.controller.poll(); expect(f.state.registrationCalls).toBe(2);
  fail(second,3_001);
  f.state.now=4_000;
  const thirdTurn="55555555-5555-4555-8555-555555555555";
  f.state.evidence={...second.evidence,turnId:thirdTurn,failedAtMs:3_500,stamp:"third-failure",recoveryIncidentId:second.id};
  await f.controller.close(); const restarted=f.create(); await restarted.poll();
  expect(f.state.registrationCalls).toBe(3);
  const third=restarted.incidents()[0]!;
  expect(third.evidence.recoveryIncidentId).toBe(second.id);
  expect(restarted.status().incidents.map(i=>i.id)).toEqual([third.id]);
  expect(f.work.executions()).toHaveLength(2);
  expect(f.work.claim(first.id,"local",f.work.get(first.id)!.revision,4_001)).toBeNull();
  expect(f.work.claim(second.id,"local",f.work.get(second.id)!.revision,4_001)).toBeNull();
});

test("recovery lineage rejects unknown parents, another session and non-new failures", async () => {
  for(const patch of [{recoveryIncidentId:"invented"},{threadId:nextThreadId},{turnId},{failedAtMs:1_500}]) {
    const f=fixture(), parent=await f.enroll();
    const execution=f.work.claim(parent.id,"local",1,2_001)!;
    f.work.markDispatched(execution.id,2_002);
    f.work.finish(execution.id,{status:"quota-blocked"},2_500);
    f.state.now=3_000;
    f.state.evidence={...parent.evidence,turnId:nextTurnId,failedAtMs:2_500,stamp:"new",recoveryIncidentId:parent.id,...patch};
    expect(f.controller.authorizedRecoveryParent("plus",f.state.evidence)).toBeNull();
    await f.controller.poll();
    expect(f.state.registrationCalls).toBe(1);
  }
});

test("an older disabled parent's reset observation cannot erase its proven quota failure", async () => {
  const f=fixture(), parent=await f.enroll();
  f.work.observe(parent.id,{id:"before",atMs:2_000,buckets:{weekly:{remainingPercent:10,epoch:"2500"}}});
  const execution=f.work.claim(parent.id,"local",1,2_001)!;
  f.work.markDispatched(execution.id,2_002);
  f.work.finish(execution.id,{status:"quota-blocked"},2_500);
  f.work.observe(parent.id,{id:"reset",atMs:3_000,buckets:{weekly:{remainingPercent:100,epoch:"5000"}}});
  f.state.now=3_000;
  f.state.evidence={...parent.evidence,turnId:nextTurnId,failedAtMs:2_500,stamp:"new",recoveryIncidentId:parent.id};
  expect(f.controller.authorizedRecoveryParent("plus",f.state.evidence)?.id).toBe(parent.id);
  await f.controller.poll(); expect(f.state.registrationCalls).toBe(2);
});

test("running, uncertain, completed and user-paused parents cannot authorize another automatic message", async () => {
  for(const status of ["running","uncertain","turn-finished","activity-paused","failed"] as const) {
    const f=fixture(), parent=await f.enroll();
    const execution=f.work.claim(parent.id,"local",1,2_001)!;
    f.work.markDispatched(execution.id,2_002);
    if(status!=="running") f.work.finish(execution.id,{status,remainingWork:"Completion remains unverified"},2_500);
    f.state.now=3_000;
    f.state.evidence={...parent.evidence,turnId:nextTurnId,failedAtMs:2_500,stamp:"new",recoveryIncidentId:parent.id};
    await f.controller.poll();
    expect(f.state.registrationCalls).toBe(1);
    expect(f.controller.authorizedRecoveryParent("plus",f.state.evidence)).toBeNull();
  }
});

test("disabling or replacing consent ends the whole recovery chain without historical re-enrollment", async () => {
  const f=fixture(), parent=await f.enroll();
  const execution=f.work.claim(parent.id,"local",1,2_001)!;
  f.work.markDispatched(execution.id,2_002);
  f.work.finish(execution.id,{status:"quota-blocked"},2_500);
  f.state.now=3_000;
  f.state.evidence={...parent.evidence,turnId:nextTurnId,failedAtMs:2_500,stamp:"new",recoveryIncidentId:parent.id};
  await f.controller.poll(); const child=f.controller.incidents()[0]!;
  await f.controller.setEnabled("plus",false);
  expect(f.controller.blockPolicy(f.work.get(child.id)!)).toBe("auto-resume-disabled");
  expect(f.controller.authorizedRecoveryParent("plus",f.state.evidence)).toBeNull();
  await f.controller.setEnabled("plus",true);
  // Even a later fabricated marker cannot revive the old opt-in revision.
  f.state.now=4_000; f.state.evidence.failedAtMs=3_500;
  await f.controller.poll();
  expect(f.state.registrationCalls).toBe(2);
  expect(f.controller.authorizedRecoveryParent("plus",f.state.evidence)).toBeNull();
});

test("a restarted collector cannot describe an unowned durable execution as still running", async () => {
  const f = fixture(), incident = await f.enroll();
  const execution = f.work.claim(incident.policyId, "local", 1, 2_001)!;
  f.work.markDispatched(execution.id, 2_002);
  f.deps.ownsExecution = id => id === execution.id;
  expect(f.controller.status().incidents[0]?.state).toBe("running");
  await f.controller.close();
  f.deps.ownsExecution = () => false;
  const restarted = f.create(); await restarted.poll();
  expect(restarted.status().incidents[0]).toMatchObject({ state: "needs-review", reason: "execution-unverified" });
  expect(f.work.get(incident.policyId)?.state.activeExecutionId).toBe(execution.id);
  expect(f.work.getExecution(execution.id)?.status).toBe("dispatched");
  expect(f.work.claim(incident.policyId, "local", 1, 3_000)).toBeNull();
  expect(f.state.registrationCalls).toBe(1);
  await expect(restarted.skip(incident.id)).rejects.toThrow("auto-resume-already-attempted");
});

test("every scan checks latest threads while bounded backfill cannot hide a new quota incident", async () => {
  const f = fixture(); let scans = 0;
  f.deps.listThreads = async (_account, cursor) => {
    f.state.listCalls.push(cursor);
    if (cursor === null) {
      scans++;
      return { data: scans === 1 ? f.state.threads : [{ id: nextThreadId, name: "New", cwd: "/tmp/new", updatedAtMs: 1_700 }], nextCursor: "older-page" };
    }
    return { data: [], nextCursor: "still-older" };
  };
  f.deps.evidence = async (_account, id) => ({ ...f.state.evidence!, threadId: id, ...(id === nextThreadId ? { turnId: nextTurnId } : {}) });
  await f.controller.setEnabled("plus", true); f.state.now = 2_000;
  await f.controller.poll(); const firstScanCalls = f.state.listCalls.length;
  await f.controller.poll();
  expect(f.state.listCalls.slice(firstScanCalls)[0]).toBeNull();
  expect(f.state.listCalls.slice(firstScanCalls).length).toBeLessThanOrEqual(2);
  expect(f.controller.incidents().map(value => value.threadId).sort()).toEqual([threadId, nextThreadId].sort());
  expect(f.state.registrationCalls).toBe(2);
});
