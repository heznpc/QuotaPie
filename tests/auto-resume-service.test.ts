import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";
import type { CodexThreadGoal, CodexThreadListParams, CodexThreadTurnSummary } from "../src/providers/codex-appserver";
import type { QuotaObservation } from "../src/types";
import { fakeCodexLogin } from "./helpers/account";

const THREAD = "11111111-2222-4333-8444-555555555555", TURN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACCOUNT = "plus", BUCKET = "codex:primary:300";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function fixture(persistent = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quotapie-auto-resume-service-")));
  const profile = join(root, "profile"); fakeCodexLogin(profile);
  mkdirSync(join(profile, "sessions")); mkdirSync(join(profile, "thread-writer-locks"));
  const rollout = join(profile, "sessions", "rollout.jsonl");
  const native = new Database(join(profile, "state_5.sqlite"));
  native.exec("CREATE TABLE threads (id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT)");
  native.query("INSERT INTO threads VALUES (?,?,?)").run(THREAD, rollout, root); native.close();
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: ACCOUNT, label: "Fixture Plus", enabled: true, codexHome: profile }];
  config.accounts.claude = []; config.collection.codexEnabled = false; config.alerts.enabled = false;
  config.collection.codexCommand = join(root, "never-execute", "codex");
  config.dashboard.host = "127.0.0.1"; config.dashboard.port = 0;
  const databasePath = persistent ? join(root, "quota.sqlite3") : ":memory:";
  let service = new QuotaPieService(config, new QuotaDatabase(databasePath), { workState: null, quota: null });
  let failedAtMs = Date.now() - 2000, runs = 0, listReads = 0, turnReads = 0;
  let goal: CodexThreadGoal | null = null, goalError = false;
  const writeFailure = (at: number) => {
    failedAtMs = at;
    const record = (type: string, payload: Record<string, unknown>, timestamp = at) =>
      JSON.stringify({ timestamp: new Date(timestamp).toISOString(), type, payload });
    writeFileSync(rollout, [record("session_meta", { id: THREAD, cwd: root }),
      record("event_msg", { type: "task_started", turn_id: TURN }, at - 1000),
      record("turn_context", { model: "gpt-6.1-sol", effort: "high" }, at - 900),
      record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic unfinished request" }] }, at - 800),
      record("event_msg", { type: "task_complete", turn_id: TURN,
        error: { codex_error_info: "usage_limit_exceeded", message: "Synthetic quota failure" } })].join("\n") + "\n");
  };
  writeFailure(failedAtMs);
  const client = {
    listThreads: async (_params?: CodexThreadListParams) => {
      listReads++; return { data: [{ id: THREAD, cwd: root, name: "Fixture task", updatedAtMs: failedAtMs }], nextCursor: null };
    },
    readLatestTurn: async (): Promise<CodexThreadTurnSummary> => {
      turnReads++; return { threadId: THREAD, turnId: TURN, status: "failed", errorCode: "usageLimitExceeded",
        completedAtMs: Math.floor(failedAtMs / 1000) * 1000 };
    },
    readThreadGoal: async (): Promise<CodexThreadGoal | null> => {
      if (goalError) throw new Error("Synthetic host read failure");
      return goal;
    },
    close: async () => {},
  };
  // Both metadata paths are fakes; no installed CLI or external service runs.
  const installFakes = () => {
    (service as any).goalClients.set(ACCOUNT, client);
    (service as any).codexClients.set(ACCOUNT, client);
    service.work.deps.execute = async (policy, _executionId, authorized) => {
      expect(authorized()).toBe(true); expect(policy.purpose).toBe("quota-resume");
      expect(policy.account).toBe(ACCOUNT); expect(policy.nativeSessionId).toBe(THREAD);
      expect(policy.maxTurns).toBe(1); expect(policy.quotaResume?.turnId).toBe(TURN);
      runs++; return { status: "turn-finished", remainingWork: "Completion was not asserted", summary: "One synthetic turn" };
    };
  };
  installFakes();
  const observe = (observedAtMs: number, usedPercent = 20, patch: Partial<QuotaObservation> = {}) => {
    service.ingest([{ provider: "codex", account: ACCOUNT, bucket: BUCKET, label: "5h", windowSeconds: 18000,
      usedPercent, observedAtMs, resetsAtMs: Date.now() + 3600000, source: "fixture", quality: "authoritative", ...patch }]);
    service.collection.recordAttempt("codex", ACCOUNT, "fixture", Date.now(), null, null);
  };
  observe(failedAtMs - 1000);
  const enableAndDiscover = async () => {
    await service.setAutoResumeEnabled(ACCOUNT, true);
    const enabledAt = service.autoResume.status().accounts[0]!.enabledAtMs!;
    writeFailure(Math.max(Date.now(), enabledAt));
    await service.autoResume.poll();
    expect(service.autoResume.incidents()).toHaveLength(1);
    const incident = service.autoResume.incidents()[0]!;
    expect(service.work.store.get(incident.policyId)).not.toBeNull();
    return incident;
  };
  cleanup.push(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, profile, config, get service() { return service; }, client, observe, writeFailure, enableAndDiscover, failedAt: () => failedAtMs,
    runs: () => runs, listReads: () => listReads, turnReads: () => turnReads,
    setGoal: (status: CodexThreadGoal["status"] | null) => {
      goalError = false; goal = status === null ? null : { threadId: THREAD, objective: "Synthetic host objective", status };
    },
    failGoalRead: () => { goalError = true; },
    restart: async () => {
      if (!persistent) throw new Error("Persistent fixture required");
      await service.close();
      service = new QuotaPieService(config, new QuotaDatabase(databasePath), { workState: null, quota: null });
      installFakes();
    } };
}

async function httpFixture() {
  const f = fixture();
  const server = startDashboard(f.service, f.config, { compactionRoot: join(f.root, "empty-compaction") });
  cleanup.unshift(async () => { await server.stop(true); });
  const base = `http://127.0.0.1:${server.port}`;
  const status = async () => (await (await fetch(base + "/api/status")).json()) as any;
  const initial = await status();
  const headers = { "content-type": "application/json", "x-quotapie-action-token": initial.actionToken };
  const post = (body: unknown, extra: Record<string, string> = {}, path = "/api/auto-resume") =>
    fetch(base + path, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  return { ...f, base, headers, initial, post, status };
}

test("auto resume is off by default and the HTTP toggle requires its action token and a trusted origin", async () => {
  const f = await httpFixture();
  expect(f.initial.autoResume.accounts).toMatchObject([{ account: ACCOUNT, enabled: false, enabledAtMs: null }]);
  expect(f.initial.autoResume.incidents).toEqual([]);
  await f.service.autoResume.poll(); expect(f.listReads()).toBe(0); expect(f.turnReads()).toBe(0);
  const body = { action: "enabled", account: ACCOUNT, enabled: true };
  expect((await fetch(f.base + "/api/auto-resume", { method: "POST", body: JSON.stringify(body) })).status).toBe(403);
  expect((await f.post(body, { "x-quotapie-action-token": "wrong" })).status).toBe(403);
  expect((await f.post(body, { origin: "https://foreign.invalid" })).status).toBe(403);
  expect((await f.post(body, { origin: "null" })).status).toBe(403);
  expect((await f.post(body, { host: "foreign.invalid" })).status).toBe(403);
  expect(f.service.autoResume.status().accounts[0]!.enabled).toBe(false);
  const enabled = await f.post(body, { origin: f.base });
  expect(enabled.status).toBe(200);
  expect((await enabled.json() as any).autoResume.accounts[0].enabled).toBe(true);
  expect((await f.status()).autoResume.accounts[0].enabled).toBe(true);
  expect((await fetch(f.base + "/api/auto-resume", { headers: f.headers })).status).toBe(405);
  expect((await f.post({ ...body, enabled: false })).status).toBe(200);
  expect((await f.status()).autoResume.accounts[0].enabled).toBe(false);
  expect(f.service.work.store.list()).toEqual([]); expect(f.runs()).toBe(0);
});

test("a desktop-owned quota failure remains visible and waits without claiming or disturbing its writer", async () => {
  const f = fixture();
  await f.service.setAutoResumeEnabled(ACCOUNT, true);
  f.writeFailure(Date.now());
  const lock=join(f.profile,"thread-writer-locks",THREAD+".lock");
  writeFileSync(lock,"");
  await f.service.autoResume.poll();
  expect(f.service.autoResume.status().incidents).toMatchObject([{state:"waiting",reason:"native-writer-present"}]);
  expect(f.service.work.store.list()).toEqual([]);
  f.service.work.tick(); await f.service.work.settle();
  expect(f.runs()).toBe(0);
  expect(f.service.work.store.executions()).toEqual([]);
  // Only the fixture's host releases its lock; discovery never deletes it.
  expect(await Bun.file(lock).exists()).toBe(true);
  rmSync(lock);
  await f.service.autoResume.poll();
  expect(f.service.work.store.list()).toHaveLength(1);
  expect(f.service.autoResume.status().incidents).toHaveLength(1);
});

test("invalid auto-resume requests never change consent", async () => {
  const f = await httpFixture();
  for (const body of [null, [], {}, { action: "enabled", account: ACCOUNT, enabled: "true" },
    { action: "enabled", account: ACCOUNT, enabled: true, extra: true },
    { action: "enabled", account: "absent", enabled: true }, { action: "skip" },
    { action: "skip", id: "not-registered" }, { action: "enabled", account: "x".repeat(1025), enabled: true }]) {
    expect((await f.post(body)).status).toBe(409);
    expect(f.service.autoResume.status().accounts[0]!.enabled).toBe(false);
  }
  expect((await fetch(f.base + "/api/auto-resume", { method: "POST", headers: f.headers, body: "{invalid" })).status).toBe(409);
  expect(f.service.autoResume.incidents()).toEqual([]); expect(f.runs()).toBe(0);
});

test("generic work save and enable endpoints cannot reactivate or replace an automatic recovery policy", async () => {
  const f = await httpFixture(), incident = await f.enableAndDiscover();
  expect((await f.post({ action: "enabled", account: ACCOUNT, enabled: false })).status).toBe(200);
  const policy = f.service.work.store.get(incident.policyId)!;
  expect(policy.enabled).toBe(false);
  for (const body of [
    { action: "enabled", id: policy.id, enabled: true, expectedRevision: policy.revision, requestId: "reenable" },
    { action: "save", policy: { ...policy, enabled: true }, expectedRevision: policy.revision, requestId: "replace" },
    { action: "save", policy: { ...policy, purpose: undefined, quotaResume: undefined, enabled: true }, expectedRevision: policy.revision, requestId: "strip-purpose" },
    { action: "save", policy: { ...policy, id: "forged-recovery", enabled: true }, expectedRevision: null, requestId: "forge" },
  ]) {
    const response = await f.post(body, {}, "/api/work");
    expect(response.status).toBe(409); expect((await response.json() as any).error).toBe("auto-resume-policy-readonly");
  }
  expect(f.service.work.store.get(policy.id)?.enabled).toBe(false);
  expect(f.service.work.store.list()).toHaveLength(1); f.service.work.tick(); await f.service.work.settle();
  expect(f.runs()).toBe(0); expect(f.service.work.store.executions()).toEqual([]);
});

test("only a fresh positive quota observation after the failure permits one existing WorkController claim", async () => {
  const f = fixture(), incident = await f.enableAndDiscover();
  expect(f.service.work.list()[0]!.admission).toMatchObject({ ready: false, reason: "quota-recovery-unconfirmed" });
  f.service.work.tick(); f.service.work.tick(); await f.service.work.settle();
  expect(f.runs()).toBe(0); expect(f.service.work.store.executions()).toEqual([]);
  while (Date.now() <= f.failedAt()) await Bun.sleep(1);
  f.observe(Date.now(), 100);
  expect(f.service.work.list()[0]!.admission).toMatchObject({ ready: false, reason: "reserve-reached" });
  f.service.work.tick(); await f.service.work.settle(); expect(f.runs()).toBe(0);
  await Bun.sleep(2); f.observe(Date.now(), 0, { quality: "derived" });
  expect(f.service.work.list()[0]!.admission.ready).toBe(false);
  f.service.work.tick(); await f.service.work.settle(); expect(f.runs()).toBe(0);
  await Bun.sleep(2); f.observe(Date.now(), 0);
  expect(f.service.work.list()[0]!.admission.ready).toBe(true);
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const execute = f.service.work.deps.execute;
  f.service.work.deps.execute = async (...args) => { const result = await execute(...args); started(); return result; };
  f.service.work.tick(); f.service.work.tick();
  await Promise.race([begun, Bun.sleep(1500).then(() => { throw new Error("Recovered fixture work did not start"); })]);
  await f.service.work.settle();
  expect(f.runs()).toBe(1);
  expect(f.service.work.store.executions()).toHaveLength(1);
  expect(f.service.work.store.get(incident.policyId)?.state).toMatchObject({ status: "turn-finished", turns: 1 });
  f.service.work.tick(); await f.service.work.settle();
  expect(f.runs()).toBe(1); expect(f.service.work.store.executions()).toHaveLength(1);
  expect(f.service.autoResume.status().incidents[0]!.state).toBe("resumed");
});

test("running recovery authorization follows host goal status and fails closed on read errors", async () => {
  for (const status of ["complete", "paused", "blocked", "budgetLimited", "error"] as const) {
    const f = fixture(), incident = await f.enableAndDiscover();
    while (Date.now() <= f.failedAt()) await Bun.sleep(1);
    f.observe(Date.now(), 0);
    let authorized!: () => boolean, finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    f.service.work.deps.execute = async (_policy, _id, check) => {
      authorized = check; await pending; return { status: "activity-paused", reason: "fixture-finished" };
    };
    try {
      const policy = f.service.work.store.get(incident.policyId)!;
      await f.service.work.dispatch(policy.id, "local", policy.revision, "one-running-turn");
      expect(authorized()).toBe(true); // A verified absence of a host goal is allowed.
      for (const permitted of ["active", "usageLimited"] as const) {
        f.setGoal(permitted); await (f.service as any).refreshAutoResumeGoals();
        expect(authorized()).toBe(true);
      }
      if (status === "error") f.failGoalRead(); else f.setGoal(status);
      await (f.service as any).refreshAutoResumeGoals();
      expect(authorized()).toBe(false);
      expect((f.service as any).autoResumeBlock(f.service.work.store.get(policy.id))).toBe(
        status === "error" ? "host-goal-unavailable" : "host-goal-not-active");
      expect(f.service.work.store.executions()).toHaveLength(1);
    } finally { finish(); await f.service.work.settle(); }
  }
});

test("running authorization expires with host observation even while quota stays fresh", async () => {
  for (const staleAfterSeconds of [300, 10]) {
    const f = fixture(), incident = await f.enableAndDiscover();
    f.config.collection.staleAfterSeconds = staleAfterSeconds;
    while (Date.now() <= f.failedAt()) await Bun.sleep(1);
    f.observe(Date.now(), 0);
    let authorized!: () => boolean, finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    f.service.work.deps.execute = async (_policy, _id, check) => {
      authorized = check; await pending; return { status: "activity-paused", reason: "fixture-finished" };
    };
    let clock: ReturnType<typeof spyOn> | undefined;
    try {
      const policy = f.service.work.store.get(incident.policyId)!;
      await f.service.work.dispatch(policy.id, "local", policy.revision, "one-running-turn");
      expect(authorized()).toBe(true);
      const expired = Date.now() + Math.min(60_000, staleAfterSeconds * 1000);
      clock = spyOn(Date, "now").mockReturnValue(expired);
      f.observe(expired, 0);
      expect((f.service as any).workGate(policy).ready).toBe(true);
      expect(authorized()).toBe(false);
      expect((f.service as any).autoResumeBlock(f.service.work.store.get(policy.id))).toBe("host-goal-stale");
    } finally { clock?.mockRestore(); finish(); await f.service.work.settle(); }
  }
});

test("restart retains the incident but holds until a new host-goal observation succeeds", async () => {
  const f = fixture(true), incident = await f.enableAndDiscover();
  while (Date.now() <= f.failedAt()) await Bun.sleep(1);
  f.observe(Date.now(), 0);
  expect(f.service.work.list()[0]!.admission.ready).toBe(true);
  await f.restart();
  expect(f.service.autoResume.incidents()).toHaveLength(1);
  expect(f.service.work.list()[0]!.admission).toMatchObject({ ready: false, reason: "host-goal-stale" });
  f.service.work.tick(); await f.service.work.settle();
  expect(f.runs()).toBe(0); expect(f.service.work.store.executions()).toEqual([]);
  await (f.service as any).refreshAutoResumeGoals();
  expect(f.service.work.list()[0]!.admission.ready).toBe(true);
  const policy = f.service.work.store.get(incident.policyId)!;
  await f.service.work.dispatch(policy.id, "local", policy.revision, "recovered-after-restart");
  await f.service.work.settle();
  expect(f.runs()).toBe(1); expect(f.service.work.store.executions()).toHaveLength(1);
});
