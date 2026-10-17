import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { CodexGoalUnsupportedError } from "../src/providers/codex-appserver";
import { startDashboard } from "../src/server";
import { fakeCodexLogin } from "./helpers/account";

const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const fixtures: Array<{ root: string; service: QuotaPieService }> = [];

function fixture(persist = false) {
  const root = mkdtempSync(join(tmpdir(), "quotapie-goal-link-"));
  const profile = join(root, "profile");
  fakeCodexLogin(profile);
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "fixture", label: "Fixture", codexHome: profile, enabled: true }];
  config.accounts.claude = [];
  config.collection.codexEnabled = false;
  config.alerts.enabled = false;
  config.dashboard.port = 0;
  const dbPath = persist ? join(root, "data", "quotapie.sqlite3") : ":memory:";
  const service = new QuotaPieService(config, new QuotaDatabase(dbPath));
  const now = Date.now();
  const sample = (usedPercent: number, observedAtMs = Date.now(), bucket = "codex:primary:300") => ({
    provider: "codex" as const, account: "fixture", bucket, label: "5h", windowSeconds: 18_000,
    usedPercent, observedAtMs, resetsAtMs: now + 3_600_000, source: "fixture", quality: "authoritative" as const,
  });
  service.ingest([sample(100, now - 5_000)]);
  const task = service.registerResumeTask({ provider: "codex", account: "fixture", nativeId: SESSION, cwd: root }, now - 4_000);
  let calls = 0;
  const client = {
    listThreads: async () => ({ data: [{ id: SESSION, cwd: root, name: "Fixture task" }], nextCursor: null }),
    readThreadGoal: async (_id: string): Promise<any> => { calls++; return { threadId: SESSION, objective: "Finish the fixture", status: "active" }; },
    close: async () => {},
  };
  (service as any).goalClients.set("fixture", client);
  const f = { root, profile, config, service, task, client, sample, dbPath, calls: () => calls };
  fixtures.push(f);
  return f;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.service.close().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("explicit link reads the exact host goal and keeps host state separate from resume readiness", async () => {
  const f = fixture();
  await f.service.refreshHostGoals();
  expect(f.calls()).toBe(0);
  const linked = await f.service.linkHostGoal(f.task.id, SESSION);
  expect(linked).toMatchObject({ taskId: f.task.id, objective: "Finish the fixture", hostStatus: "active",
    readState: "ready", resumeState: "waiting" });
  expect(f.calls()).toBe(1);
  await f.service.refreshHostGoals();
  expect(f.calls()).toBe(1);
  f.service.ingest([f.sample(20)]);
  await f.service.updateResumeReadiness(f.service.analyses(), Date.now());
  expect(f.service.hostGoalStatus().items[0]?.resumeState).toBe("ready");
  f.client.readThreadGoal = async () => ({ threadId: SESSION, objective: "Finish the fixture", status: "complete" });
  await f.service.refreshHostGoals(true);
  expect(f.service.hostGoalStatus().items[0]).toMatchObject({ hostStatus: "complete", resumeState: "ready" });
  expect(f.service.resumeTasks.get(f.task.id)?.state).toBe("ready");
  // A new account-wide blocker invalidates the advertised ready state even
  // before the next resume state-machine tick.
  f.service.ingest([f.sample(100, Date.now(), "codex:secondary:10080")]);
  expect(f.service.hostGoalStatus().items[0]?.resumeState).toBe("unknown");
});

test("another session, missing host thread, or changed profile cannot be linked", async () => {
  const f = fixture();
  await expect(f.service.linkHostGoal(f.task.id, OTHER)).rejects.toThrow("session_mismatch");
  expect(f.calls()).toBe(0);
  f.client.listThreads = async () => ({ data: [], nextCursor: null });
  await expect(f.service.linkHostGoal(f.task.id, SESSION)).rejects.toThrow("session_unavailable");
  fakeCodexLogin(f.profile, "another-account");
  await expect(f.service.linkHostGoal(f.task.id, SESSION)).rejects.toThrow("account_changed");
  expect(f.service.hostGoalStatus().items).toEqual([]);
});

test("host lookup outcomes distinguish absent goal, unsupported API, and transient failure", async () => {
  const f = fixture();
  f.client.readThreadGoal = async () => null;
  expect(await f.service.linkHostGoal(f.task.id, SESSION)).toMatchObject({ readState: "no_goal", objective: null });
  f.client.readThreadGoal = async () => { throw new CodexGoalUnsupportedError("unsupported"); };
  await f.service.refreshHostGoals(true);
  expect(f.service.hostGoalStatus().items[0]?.readState).toBe("unsupported");
  f.client.readThreadGoal = async () => { throw new Error("PRIVATE_PROVIDER_ERROR"); };
  await f.service.refreshHostGoals(true);
  const status = f.service.hostGoalStatus();
  expect(status.items[0]?.readState).toBe("error");
  expect(JSON.stringify(status)).not.toContain("PRIVATE_PROVIDER_ERROR");
});

test("expired and future observations are stale, failures retain cached evidence, and login changes redact it", async () => {
  const f = fixture();
  const linked = await f.service.linkHostGoal(f.task.id, SESSION);
  expect(f.service.hostGoalStatus(linked.expiresAtMs!).items[0]?.readState).toBe("stale");
  expect(f.service.hostGoalStatus(linked.observedAtMs! - 1).items[0]?.readState).toBe("stale");
  f.client.readThreadGoal = async () => { throw new Error("temporary"); };
  await f.service.refreshHostGoals(true);
  expect(f.service.hostGoalStatus().items[0]).toMatchObject({ readState: "error", objective: linked.objective,
    observedAtMs: linked.observedAtMs });
  fakeCodexLogin(f.profile, "different-account");
  expect(f.service.hostGoalStatus().items[0]).toMatchObject({ readState: "account_changed", objective: null,
    hostStatus: null, observedAtMs: null, resumeState: "unknown" });
  await f.service.refreshHostGoals(true);
  expect(f.service.hostGoalLinks.get(f.task.id)?.objective).toBeNull();
});

test("an account change during a successful read cannot install a new snapshot", async () => {
  const f = fixture();
  f.client.readThreadGoal = async () => {
    fakeCodexLogin(f.profile, "switched-during-read");
    return { threadId: SESSION, objective: "PRIVATE_OTHER_ACCOUNT", status: "active" };
  };
  const linked = await f.service.linkHostGoal(f.task.id, SESSION);
  expect(linked).toMatchObject({ readState: "account_changed", objective: null });
  expect(f.service.hostGoalLinks.get(f.task.id)?.objective).toBeNull();
});

test("unlink during a read cannot resurrect the goal", async () => {
  const f = fixture();
  await f.service.linkHostGoal(f.task.id, SESSION);
  let release!: (value: unknown) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  f.client.readThreadGoal = async () => { started(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.service.refreshHostGoals(true);
  await entered;
  f.service.unlinkHostGoal(f.task.id);
  release({ threadId: SESSION, objective: "Late result", status: "active" });
  await pending;
  expect(f.service.hostGoalStatus().items).toEqual([]);
});

test("unlink during initial linking reports a conflict instead of an undefined success", async () => {
  const f = fixture();
  f.client.readThreadGoal = async () => {
    f.service.unlinkHostGoal(f.task.id);
    return { threadId: SESSION, objective: "Late result", status: "active" };
  };
  await expect(f.service.linkHostGoal(f.task.id, SESSION)).rejects.toThrow("host_goal_link_changed");
  expect(f.service.hostGoalStatus().items).toEqual([]);
});

test("a null goal after the linked thread disappears is unavailable, not a confirmed absence of a goal", async () => {
  const f = fixture();
  await f.service.linkHostGoal(f.task.id, SESSION);
  f.client.readThreadGoal = async () => null;
  f.client.listThreads = async () => ({ data: [], nextCursor: null });
  await f.service.refreshHostGoals(true);
  expect(f.service.hostGoalStatus().items[0]).toMatchObject({ readState: "error", objective: "Finish the fixture" });
});

test("terminal tasks retain history without further host reads and disappear when the task is pruned", async () => {
  const f = fixture();
  await f.service.linkHostGoal(f.task.id, SESSION);
  f.service.dismissResumeTask(f.task.id);
  await f.service.refreshHostGoals(true);
  expect(f.calls()).toBe(1);
  expect(f.service.hostGoalStatus().items[0]?.resumeState).toBe("dismissed");
  f.service.resumeTasks.pruneTerminal(Date.now() + 1_000);
  await f.service.refreshHostGoals(true);
  expect(f.service.hostGoalLinks.list()).toEqual([]);
});

test("a resumed task continues reading its host goal without pretending a shell launch completed it", async () => {
  const f = fixture();
  await f.service.linkHostGoal(f.task.id, SESSION);
  f.service.resumeTasks.markReady(f.task.id,Date.now());
  f.service.resumeTasks.approve(f.task.id,Date.now());
  f.service.resumeTasks.markResumed(f.task.id,Date.now());
  f.client.readThreadGoal = async () => ({threadId:SESSION,objective:"Finish the fixture",status:"complete"});
  await f.service.refreshHostGoals(true);
  expect(f.service.hostGoalStatus().items[0]).toMatchObject({resumeState:"resumed",hostStatus:"complete",readState:"ready"});
});

test("pause with a goal can retry the same active registration after a failed lookup", async () => {
  const f = fixture();
  f.client.listThreads = async () => ({data:[],nextCursor:null});
  await expect(f.service.linkHostGoal(f.task.id, SESSION)).rejects.toThrow("session_unavailable");
  const retried = f.service.registerResumeTask({provider:"codex",account:"fixture",nativeId:SESSION,cwd:f.root},Date.now(),true);
  expect(retried.id).toBe(f.task.id);
  expect(f.service.resumeTasks.active()).toHaveLength(1);
  f.client.listThreads = async () => ({data:[{id:SESSION,cwd:f.root,name:"Fixture"}],nextCursor:null});
  expect((await f.service.linkHostGoal(retried.id,SESSION)).readState).toBe("ready");
  fakeCodexLogin(f.profile,"different-account");
  expect(()=>f.service.registerResumeTask({provider:"codex",account:"fixture",nativeId:SESSION},Date.now(),true)).toThrow("account_changed");
});

test("links survive a service restart, and the public API omits private session locators", async () => {
  const f = fixture(true);
  await f.service.linkHostGoal(f.task.id, SESSION);
  await f.service.close();
  const restored = new QuotaPieService(f.config, new QuotaDatabase(f.dbPath));
  f.service = restored;
  expect(restored.hostGoalStatus().items[0]).toMatchObject({ taskId: f.task.id, hostStatus: "active" });
  const server = startDashboard(restored, f.config, { compactionRoot: join(f.root, "empty-relays") });
  try {
    const payload = await (await fetch(`http://127.0.0.1:${server.port}/api/status`)).json() as any;
    expect(payload.hostGoals.items[0].objective).toBe("Finish the fixture");
    const text = JSON.stringify(payload.hostGoals);
    for (const privateValue of [SESSION, f.profile, "thread_id", "revision", "taskKey"]) expect(text).not.toContain(privateValue);
  } finally { server.stop(true); }
});
