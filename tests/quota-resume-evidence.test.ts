import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaResumeEvidenceUnavailableError, readQuotaResumeEvidence } from "../src/quota-resume/evidence";
import type { CodexThreadTurnSummary } from "../src/providers/codex-appserver";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const threadId = "11111111-2222-4333-8444-555555555555", turnId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const now = 2_000_000_000_000, failedAt = now - 1234;
const record = (type: string, payload: Record<string, unknown>, at = failedAt) => ({ timestamp: new Date(at).toISOString(), type, payload });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quotapie-quota-evidence-"))); roots.push(root);
  mkdirSync(join(root, "sessions")); mkdirSync(join(root, "thread-writer-locks"));
  writeFileSync(join(root, "auth.json"), "{}");
  const path = join(root, "sessions", "rollout.jsonl");
  const records = [record("session_meta", { id: threadId }),
    record("event_msg", { type: "task_started", turn_id: turnId }, failedAt - 2000),
    record("turn_context", { model: "gpt-6.1-sol", effort: "high" }, failedAt - 1900),
    record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Private original request" }] }, failedAt - 1800),
    record("event_msg", { type: "task_complete", turn_id: turnId, error: { codex_error_info: "usage_limit_exceeded", message: "Private provider text" } })];
  const save = () => writeFileSync(path, records.map(r => JSON.stringify(r)).join("\n") + "\n"); save();
  const db = new Database(join(root, "state_5.sqlite"));
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)");
  db.run("INSERT INTO threads VALUES (?,?,?)", [threadId, path, root]); db.close();
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "plus", label: "Plus", enabled: true, codexHome: root }];
  const turn: CodexThreadTurnSummary = { threadId, turnId, status: "failed", errorCode: "usageLimitExceeded", completedAtMs: Math.floor(failedAt / 1000) * 1000 };
  let reads = 0;
  const options = { now: () => now, readLatestTurn: async () => { reads++; return turn; } };
  const read = () => readQuotaResumeEvidence(config, "plus", threadId, options);
  return { root, path, config, records, turn, options, save, read, get reads() { return reads; } };
}

test("quota task_complete is matched to the exact failed API turn without returning text", async () => {
  const f = fixture(), result = await f.read();
  expect(result).toMatchObject({ threadId, turnId, failedAtMs: failedAt, cwd: f.root, model: "gpt-6.1-sol" });
  expect(result?.stamp).toContain(f.path);
  expect(JSON.stringify(result)).not.toMatch(/Private|usage_limit/);
  expect(f.reads).toBe(1);
  // Detection does not depend on quota readiness or make any inference call.
  f.config.reservePercent.codex = { short: 100, weekly: 100, other: 100 };
  expect(await f.read()).toEqual(result);
});

function consolidate(f:ReturnType<typeof fixture>) {
  const container=realpathSync(mkdtempSync(join(tmpdir(),"quotapie-moved-evidence-")));roots.push(container);
  const primaryHome=join(container,"primary"),primaryAppData=join(container,"primary-app"),sourceData=join(container,"source-app"),directory=join(container,"QuotaPie");
  for(const path of [primaryHome,primaryAppData,sourceData,directory,join(primaryHome,"sessions"),join(primaryHome,"thread-writer-locks")])mkdirSync(path,{mode:0o700});
  writeFileSync(join(primaryHome,"auth.json"),"{\"primary\":true}");
  f.config.accounts.codex.push({id:"default",label:"Primary",enabled:true,codexHome:primaryHome});
  const path=join(primaryHome,"sessions","copied.jsonl");copyFileSync(f.path,path);
  const db=new Database(join(primaryHome,"state_5.sqlite"));db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)");
  db.run("INSERT INTO threads VALUES (?,?,?)",[threadId,path,f.root]);db.close();
  const manifestPath=join(directory,"manifest.json"),markerPath=join(directory,"session-consolidation.json");
  const manifest=JSON.stringify({version:1,sourceHome:f.root,primaryHome,threadIds:[threadId]});
  writeFileSync(manifestPath,manifest,{mode:0o600});
  writeFileSync(markerPath,JSON.stringify({version:1,state:"complete",completedAtMs:failedAt-100,
    primary:{codexHome:primaryHome,appData:primaryAppData},sources:[{codexHome:f.root,appData:sourceData,manifestPath,
      manifestSHA256:createHash("sha256").update(manifest).digest("hex")}]}),{mode:0o600});
  return {path,primaryHome,options:{...f.options,sessionLocation:{markerPath,primaryHome,primaryAppData,nowMs:now}}};
}
test("moved B evidence uses canonical history with B consent/auth unchanged",async()=>{
  const f=fixture(),m=consolidate(f);
  appendFileSync(f.path,JSON.stringify(record("event_msg",{type:"user_message",message:"retired source noise"}))+"\n");
  const evidence=await readQuotaResumeEvidence(f.config,"plus",threadId,m.options);
  expect(evidence).toMatchObject({threadId,turnId,cwd:f.root});expect(evidence?.stamp).toContain(m.path);
  expect(f.config.accounts.codex[0]!.codexHome).toBe(f.root);
  expect(await readQuotaResumeEvidence(f.config,"plus",turnId,m.options)).toBeNull();
  expect(f.reads).toBe(1);
});
test("new canonical activity supersedes the retired B failure without reading the old store",async()=>{
  const f=fixture(),m=consolidate(f);
  appendFileSync(m.path,JSON.stringify(record("event_msg",{type:"user_message",message:"current source continuation"}))+"\n");
  expect(await readQuotaResumeEvidence(f.config,"plus",threadId,m.options)).toBeNull();expect(f.reads).toBe(0);
});
test("both source subscription and canonical owner credentials remain pinned across evidence reads",async()=>{
  for(const changed of ["source","primary"]){
    const f=fixture(),m=consolidate(f),credential=join(changed==="source"?f.root:m.primaryHome,"auth.json");
    const options={...m.options,readLatestTurn:async()=>{writeFileSync(credential,"{\"changed\":true,\"more\":1}");return f.turn;}};
    expect(await readQuotaResumeEvidence(f.config,"plus",threadId,options)).toBeNull();
  }
});

test.each(["completed", "interrupted", "inProgress"] as const)("API %s supersedes the old local quota record", async status => {
  const f = fixture(); f.turn.status = status;
  expect(await f.read()).toBeNull();
});

test("API turn, error and completion time must all match the local terminal", async () => {
  for (const patch of [{ turnId: threadId }, { threadId: turnId }, { errorCode: "other" }, { errorCode: "rateLimit" },
    { completedAtMs: null }, { completedAtMs: Math.floor(failedAt / 1000) * 1000 + 1000 }]) {
    const f = fixture(); Object.assign(f.turn, patch); expect(await f.read()).toBeNull();
  }
});

test("generic errors, successful completion, aborted turns and unclosed turns are ineligible", async () => {
  for (const payload of [
    { type: "task_complete", turn_id: turnId },
    { type: "task_complete", turn_id: turnId, error: { codex_error_info: "other", message: "usage limit quota 429" } },
    { type: "turn_failed", turn_id: turnId, error: { codex_error_info: "usage_limit_exceeded" } },
    { type: "turn_aborted", turn_id: turnId }, { type: "task_started", turn_id: turnId },
  ]) {
    const f = fixture(); f.records[f.records.length - 1] = record("event_msg", payload); f.save();
    expect(await f.read()).toBeNull(); expect(f.reads).toBe(0);
  }
});

test("any record after the quota terminal invalidates it, including user input before task_started", async () => {
  for (const next of [record("event_msg", { type: "user_message", message: "A new request" }),
    record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "A new request" }] }),
    record("event_msg", { type: "turn_aborted", turn_id: turnId }),
    record("event_msg", { type: "task_complete", turn_id: turnId }),
    record("turn_context", { model: "gpt-6.1-sol" })]) {
    const f = fixture(); f.records.push(next); f.save();
    expect(await f.read()).toBeNull(); expect(f.reads).toBe(0);
  }
});

test("automatic recovery prompts require durable ownership authorization for another incident", async () => {
  for (const user of [record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "[QuotaPie quota recovery:incident-123]\nContinue" }] }),
    record("event_msg", { type: "user_message", message: "[QuotaPie quota recovery:incident-123]\nContinue" })]) {
    const f = fixture(); f.records[3] = user; f.save(); expect(await f.read()).toBeNull();
    const nextTurn = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    f.records.push(record("event_msg", { type: "task_started", turn_id: nextTurn }),
      record("event_msg", { type: "user_message", message: "New human request" }),
      record("event_msg", { type: "task_complete", turn_id: nextTurn, error: { codex_error_info: "usage_limit_exceeded" } }));
    f.turn.turnId = nextTurn; f.save();
    expect(await f.read()).not.toBeNull();
  }
});

test("a verified recovery turn exposes its parent only after exact provider and ownership checks", async () => {
  const f = fixture();
  f.records[3] = record("response_item", { type: "message", role: "user",
    content: [{ type: "input_text", text: "[QuotaPie quota recovery:incident-123]\nContinue" }] });
  f.save();
  const candidates: unknown[] = [];
  const result = await readQuotaResumeEvidence(f.config,"plus",threadId,{...f.options,
    authorizeRecoveryTurn:evidence=>{ candidates.push(evidence); return evidence.turnId===turnId && evidence.recoveryIncidentId==="incident-123"; }});
  expect(result).toMatchObject({threadId,turnId,recoveryIncidentId:"incident-123",failedAtMs:failedAt});
  expect(candidates).toEqual([result]);
  expect(JSON.stringify(result)).not.toMatch(/Continue|Private/);
  expect(await readQuotaResumeEvidence(f.config,"plus",threadId,{...f.options,authorizeRecoveryTurn:()=>false})).toBeNull();
  expect(await readQuotaResumeEvidence(f.config,"plus",threadId,{...f.options,authorizeRecoveryTurn:()=>{throw new Error("receipt-unavailable");}})).toBeNull();
  f.turn.turnId = threadId;
  let authorizations = 0;
  expect(await readQuotaResumeEvidence(f.config,"plus",threadId,{...f.options,authorizeRecoveryTurn:()=>{ authorizations++; return true; }})).toBeNull();
  expect(authorizations).toBe(0);
});

test("changed rollout or credentials during recovery ownership validation invalidate evidence", async () => {
  for(const change of [(f:ReturnType<typeof fixture>)=>appendFileSync(f.path,JSON.stringify(record("event_msg",{type:"user_message",message:"New user request"}))+"\n"),
    (f:ReturnType<typeof fixture>)=>writeFileSync(join(f.root,"auth.json"),'{"changed":true}')]) {
    const f=fixture();
    f.records[3]=record("event_msg",{type:"user_message",message:"[QuotaPie quota recovery:incident-123]\nContinue"}); f.save();
    expect(await readQuotaResumeEvidence(f.config,"plus",threadId,{...f.options,authorizeRecoveryTurn:async()=>{ change(f); return true; }})).toBeNull();
  }
});

test("conflicting automatic markers fail closed but do not poison a later human turn", async () => {
  const f=fixture();
  f.records[3]=record("event_msg",{type:"user_message",message:"[QuotaPie quota recovery:incident-123]\nContinue"});
  f.records.splice(4,0,record("event_msg",{type:"user_message",message:"[QuotaPie quota recovery:incident-456]\nContinue"}));
  f.save();
  let authorizations=0;
  expect(await readQuotaResumeEvidence(f.config,"plus",threadId,{...f.options,authorizeRecoveryTurn:()=>{authorizations++;return true;}})).toBeNull();
  expect(authorizations).toBe(0);
  const nextTurn="bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  f.records.push(record("event_msg",{type:"task_started",turn_id:nextTurn}),
    record("event_msg",{type:"user_message",message:"New human request"}),
    record("event_msg",{type:"task_complete",turn_id:nextTurn,error:{codex_error_info:"usage_limit_exceeded"}}));
  f.turn.turnId=nextTurn; f.save();
  expect(await f.read()).toMatchObject({turnId:nextTurn});
  expect((await f.read())?.recoveryIncidentId).toBeUndefined();
});

test("host user-context records cannot erase an automatic marker within the failed turn", async () => {
  for (const beforeStart of [false, true]) {
    const f = fixture();
    const marker = record("response_item", { type: "message", role: "user",
      content: [{ type: "input_text", text: "[QuotaPie quota recovery:incident-123]\nContinue" }] });
    if (beforeStart) f.records.splice(1, 0, marker);
    else f.records[3] = marker;
    f.records.splice(f.records.length - 1, 0,
      record("event_msg", { type: "user_message", message: "Synthetic host environment context" }),
      record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic context" }] }));
    f.save(); expect(await f.read()).toBeNull(); expect(f.reads).toBe(0);
    expect(await readQuotaResumeEvidence(f.config,"plus",threadId,{...f.options,
      authorizeRecoveryTurn:evidence=>evidence.recoveryIncidentId==="incident-123"}))
      .toMatchObject({threadId,turnId,recoveryIncidentId:"incident-123"});
  }
});

test("an unanswered structured question is not auto-resumed", async () => {
  const f = fixture(); f.records.splice(4, 0, record("response_item", { type: "function_call", name: "functions.request_user_input", call_id: "question" }));
  f.save(); expect(await f.read()).toBeNull();
  f.records.splice(5, 0, record("response_item", { type: "function_call_output", call_id: "question", output: "Answer" }));
  f.save(); expect(await f.read()).not.toBeNull();
});

test("native writer, absent profile credentials and future timestamps fail before provider reads", async () => {
  const f = fixture();
  const lock = join(f.root, "thread-writer-locks", threadId + ".lock"); writeFileSync(lock, "");
  expect(await f.read()).toBeNull(); rmSync(lock);
  f.records.at(-1)!.timestamp = new Date(now + 1000).toISOString(); f.save(); expect(await f.read()).toBeNull();
  rmSync(join(f.root, "auth.json")); expect(await f.read()).toBeNull(); expect(f.reads).toBe(0);
});

test("discovery can display a host-owned failed turn while execution evidence remains blocked", async () => {
  const f = fixture(), lock = join(f.root, "thread-writer-locks", threadId + ".lock");
  writeFileSync(lock, "");
  expect(await readQuotaResumeEvidence(f.config, "plus", threadId, {...f.options, allowNativeWriter: true}))
    .toMatchObject({threadId, turnId, failedAtMs: failedAt});
  expect(await f.read()).toBeNull();
  f.turn.status = "inProgress";
  expect(await readQuotaResumeEvidence(f.config, "plus", threadId, {...f.options, allowNativeWriter: true})).toBeNull();
  expect(f.reads).toBe(2);
});

test("changed rollout, credential identity or writer ownership while awaiting API invalidates evidence", async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => appendFileSync(f.path, JSON.stringify(record("event_msg", { type: "user_message", message: "New" })) + "\n"),
    (f: ReturnType<typeof fixture>) => writeFileSync(join(f.root, "auth.json"), '{"changed":true}'),
    (f: ReturnType<typeof fixture>) => writeFileSync(join(f.root, "thread-writer-locks", threadId + ".lock"), "")]) {
    const f = fixture(); f.options.readLatestTurn = async () => { change(f); return f.turn; };
    expect(await f.read()).toBeNull();
  }
});

test("unavailable provider validation is distinct from a non-quota terminal and exposes no provider text", async () => {
  const f = fixture(); f.options.readLatestTurn = async () => { throw new Error("Private provider text secret-token"); };
  const error = await f.read().catch(error => error);
  expect(error).toBeInstanceOf(QuotaResumeEvidenceUnavailableError);
  expect(error.message).toBe("quota-resume-evidence-unavailable");
  expect(String(error)).not.toMatch(/Private|secret-token/);
  await expect(readQuotaResumeEvidence(f.config,"plus",threadId,{...f.options,readLatestTurn:async()=>null}))
    .rejects.toBeInstanceOf(QuotaResumeEvidenceUnavailableError);
  f.records.at(-1)!.payload = { type: "task_complete", turn_id: turnId }; f.save();
  expect(await f.read()).toBeNull();
});

test("truncated records and bounded tails missing the turn start fail closed", async () => {
  const partial = fixture(); appendFileSync(partial.path, '{"type":'); expect(await partial.read()).toBeNull();
  const bounded = fixture(); bounded.records.splice(3, 0, record("response_item", { type: "message", role: "assistant", content: "x".repeat(16 * 1024 * 1024) }));
  bounded.save(); expect(await bounded.read()).toBeNull(); expect(bounded.reads).toBe(0);
});

test("rollout metadata must match the requested thread", async () => {
  const f = fixture(); f.records[0] = record("session_meta", { id: turnId }); f.save();
  expect(await f.read()).toBeNull(); expect(f.reads).toBe(0);
});

test("ordinary conversation scans let timers run before the whole page completes", async () => {
  const f = fixture();
  // No host validation awaits can rescue the loop: every scan is an ordinary
  // completed conversation, as in an enabled account's newest/history pages.
  f.records.splice(4, 0, ...Array.from({length: 32}, () => record("response_item",
    {type: "message", role: "assistant", content: "x".repeat(32 * 1024)})));
  f.records.at(-1)!.payload = {type: "task_complete", turn_id: turnId}; f.save();
  let completed = 0, ticksDuringScan = 0;
  const timer = setInterval(() => { if (completed < 100) ticksDuringScan++; }, 1);
  try {
    for (; completed < 100; completed++) expect(await f.read()).toBeNull();
  } finally { clearInterval(timer); }
  expect(ticksDuringScan).toBeGreaterThan(5);
  expect(f.reads).toBe(0);
});

test("one large bounded record preserves evidence and permits queued local work", async () => {
  const f = fixture();
  f.records.splice(4, 0, record("response_item", {type: "message", role: "assistant", content: "x".repeat(8 * 1024 * 1024)}));
  f.save();
  let yielded = false;
  const pending = yieldToEventLoop().then(() => { yielded = true; });
  expect(await f.read()).toMatchObject({threadId, turnId, failedAtMs: failedAt});
  expect(yielded).toBe(true); await pending;
  expect(f.reads).toBe(1);
});

test("changes during asynchronous local reads cannot authorize the old failure", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => appendFileSync(f.path, JSON.stringify(record("event_msg", {type: "user_message", message: "New request"})) + "\n"),
    (f: ReturnType<typeof fixture>) => writeFileSync(join(f.root, "auth.json"), '{"changed":true}'),
    (f: ReturnType<typeof fixture>) => writeFileSync(join(f.root, "thread-writer-locks", threadId + ".lock"), ""),
  ]) {
    const f = fixture();
    const pending = yieldToEventLoop().then(() => change(f));
    expect(await f.read()).toBeNull(); await pending;
  }
});

test("profile revocation and credential-store changes during the final local read fail closed", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.config.accounts.codex[0]!.enabled = false; },
    (f: ReturnType<typeof fixture>) => { f.config.accounts.codex = []; },
    (f: ReturnType<typeof fixture>) => { f.config.accounts.codex = [{...f.config.accounts.codex[0]!, codexHome: fixture().root}]; },
    (f: ReturnType<typeof fixture>) => writeFileSync(join(f.root, "config.toml"), 'cli_auth_credentials_store = "keyring"\n'),
  ]) {
    const f = fixture();
    let pending: Promise<void> | undefined;
    f.options.readLatestTurn = async () => {
      // The final read starts on the next microtask; mutate only once its file
      // I/O yields, after it has already accepted the old profile and mode.
      pending = yieldToEventLoop().then(() => { change(f); });
      return f.turn;
    };
    expect(await f.read()).toBeNull(); await pending;
  }
});


test("late native command completion preserves the exact failed turn only with source ownership", async () => {
  const f = fixture();
  const completion = record("event_msg", {type: "item_completed", thread_id: threadId, turn_id: turnId,
    started_at_ms: failedAt - 1000, completed_at_ms: failedAt + 1000,
    item: {type: "CommandExecution", status: "failed", exit_code: 1}}, failedAt + 1000);
  f.records.push(completion); f.save();
  expect(await f.read()).toMatchObject({threadId, turnId, failedAtMs: failedAt});
  // Missing or foreign ownership is never treated as harmless bookkeeping.
  for (const patch of [{thread_id: undefined}, {thread_id: turnId}, {turn_id: undefined}, {turn_id: threadId},
    {started_at_ms: failedAt + 1}, {completed_at_ms: now + 1},
    {item: {type: "CommandExecution", status: "inProgress"}}, {item: {type: "UserMessage"}}]) {
    f.records[f.records.length - 1] = {...completion, payload: {...completion.payload, ...patch}};
    f.save(); expect(await f.read()).toBeNull();
  }
  f.records[f.records.length - 1] = completion; f.save();
  f.turn.status = "inProgress";
  expect(await f.read()).toBeNull();
  f.turn.status = "failed";
  f.records.push(record("event_msg", {type: "task_started", turn_id: threadId}, failedAt + 1100));
  f.save(); expect(await f.read()).toBeNull();
});
