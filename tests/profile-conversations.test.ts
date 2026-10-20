import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config";
import { ProfileConversations } from "../src/profile-conversations";
import type { PoolAccount } from "../src/account-pool";
import { CodexAppServerClient } from "../src/providers/codex-appserver";

const THREAD = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const SUBMIT = "33333333-3333-4333-8333-333333333333", SECOND = "44444444-4444-4444-8444-444444444444";
const OLD = "55555555-5555-4555-8555-555555555555", TURN = "66666666-6666-4666-8666-666666666666";
const NOW = 1_900_000_000_000;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qp-profile-message-")));
  const primaryHome = join(root, "primary"), sourceHome = join(root, "source"), primaryAppData = join(root, "app"), sourceData = join(root, "source-app");
  const support = join(root, "QuotaPie"), journal = join(support, "journal");
  for (const path of [primaryHome, sourceHome, primaryAppData, sourceData, support, journal]) mkdirSync(path, { mode: 0o700 });
  const manifestPath = join(journal, "manifest.json"), markerPath = join(support, "session-consolidation.json");
  const manifest = JSON.stringify({ version: 1, sourceHome, primaryHome, threadIds: [THREAD] });
  writeFileSync(manifestPath, manifest, { mode: 0o600 });
  writeFileSync(markerPath, JSON.stringify({ version: 1, state: "complete", completedAtMs: 1000,
    primary: { codexHome: primaryHome, appData: primaryAppData }, sources: [{ codexHome: sourceHome, appData: sourceData,
      manifestPath, manifestSHA256: createHash("sha256").update(manifest).digest("hex") }] }), { mode: 0o600 });
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "a", label: "A", enabled: true, codexHome: primaryHome }, { id: "b", label: "B", enabled: true, codexHome: sourceHome }];
  const accounts = ["a", "b"].map(id => ({ id, label: id, identity: id.repeat(64), accessToken: "private", upstreamAccount: id,
    tokenExpiresAt: NOW + 300000, models: ["gpt-6.1-sol"], remaining: id === "a" ? 0 : 100, validUntil: NOW + 100000 })) as PoolAccount[];
  const state = { active: false, queue: [] as Array<{ id: string; clientUserMessageId: string }>, turn: null as any,
    adds: [] as Array<{ id: string; text: string }>, wakes: 0, closed: 0, lostAck: false, owner: { pid: 123, startedAtMs: 100 },
    policy: { enabled: true, accounts: ["a", "b"] }, changeBeforeWrite: false };
  const client = {
    listThreads: async (_params: any) => ({ data: [{ id: THREAD, cwd: "/project", name: "Migrated", updatedAtMs: 4000 },
      { id: OTHER, cwd: "/other", name: "Other" }], nextCursor: "next" }),
    readLatestTurn: async () => ({ threadId: THREAD, turnId: OLD, status: state.active ? "inProgress" as const : "failed" as const, errorCode: null, completedAtMs: NOW - 1000 }),
    listThreadQueue: async () => ({ data: state.queue, nextCursor: null }),
    addThreadQueue: async (_thread: string, id: string, text: string, check?: () => void) => {
      if (state.changeBeforeWrite) accounts[1]!.identity = "c".repeat(64);
      check?.(); state.adds.push({ id, text });
      state.queue = [{ id: SECOND, clientUserMessageId: id }];
      if (state.lostAck) throw new Error("transport lost");
      return state.queue[0]!;
    },
    deleteThreadQueue: async () => { throw new Error("must not delete user input"); },
    readTurnForClientMessage: async () => state.turn,
    readTurn: async () => state.turn,
    close: async () => { state.closed++; },
  };
  const options = { databasePath: join(root, "messages.sqlite"), sessionLocation: { markerPath, primaryHome, primaryAppData, nowMs: NOW },
    client: (location: any) => { expect(location.sessionRoot).toBe(primaryHome); return client; }, accounts: () => accounts,
    pool: () => state.policy, owner: async () => state.owner,
    wake: async (request: any) => { await request.beforeSend(); expect(request.stillAuthorized()).toBe(true); state.wakes++; return { status: "sent" as const }; }, now: () => NOW };
  const api = new ProfileConversations(config, options);
  return { root, primaryHome, sourceHome, markerPath, accounts, state, client, options, api,
    input: { account: "b", threadId: THREAD, submissionId: SUBMIT, text: "  exact user text\nwith Unicode 한글  " },
    close: () => { api.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("catalogue keeps B manifest scope, primary metadata, unknown activity and no transcript bodies", async () => {
  const f = fixture();
  try {
    expect(await f.api.catalogue("b")).toEqual({ account: "b", sessionOwner: "a", consolidated: true,
      conversations: [{ id: THREAD, title: "Migrated", active: null, updatedAt: 4000 }], nextCursor: "next" });
    expect((await f.api.catalogue("a")).conversations).toHaveLength(2);
    expect(f.state.closed).toBe(0);
    f.client.listThreads = async () => { f.accounts[1]!.identity = "changed"; return { data: [], nextCursor: "next" }; };
    await expect(f.api.catalogue("b")).rejects.toThrow("profile_identity_changed");
  } finally { f.close(); }
});

test("one exact user input queues and wakes existing host, then exact official receipt establishes completion", async () => {
  const f = fixture();
  try {
    expect(await f.api.submit(f.input)).toMatchObject({ state: "queued", submissionId: SUBMIT, threadId: THREAD });
    expect(f.state.adds).toEqual([{ id: SUBMIT, text: f.input.text }]); expect(f.state.wakes).toBe(1);
    const db = new Database(f.options.databasePath, { readonly: true });
    expect(JSON.stringify(db.query("SELECT * FROM messages").all())).not.toContain(f.input.text); db.close();
    const restarted = new ProfileConversations(DEFAULT_CONFIG, { ...f.options });
    // Same configuration is required after a restart; no identity/owner substitution.
    expect((await restarted.receipt("b", SUBMIT)).state).toBe("uncertain"); restarted.close();
    f.state.queue = []; f.state.turn = { threadId: THREAD, turnId: TURN, status: "inProgress", errorCode: null, completedAtMs: null };
    expect((await f.api.receipt("b", SUBMIT)).state).toBe("running");
    f.state.turn = { ...f.state.turn, status: "completed", completedAtMs: NOW + 1000 };
    expect((await f.api.receipt("b", SUBMIT)).state).toBe("completed");
    expect((await f.api.submit(f.input)).state).toBe("completed"); expect(f.state.adds).toHaveLength(1);
  } finally { f.close(); }
});

test.each(["active", "occupied", "quota", "disabled", "identity"])("known pre-send %s rejection persists failed and performs no add", async kind => {
  const f = fixture();
  try {
    if (kind === "active") f.state.active = true;
    if (kind === "occupied") f.state.queue = [{ id: SECOND, clientUserMessageId: SECOND }];
    if (kind === "quota") f.accounts[1]!.remaining = 0;
    if (kind === "disabled") f.state.policy.enabled = false;
    if (kind === "identity") f.state.changeBeforeWrite = true;
    expect((await f.api.submit(f.input)).state).toBe("failed");
    expect((await f.api.receipt("b", SUBMIT)).state).toBe("failed");
    expect(f.state.adds).toHaveLength(0); expect(f.state.wakes).toBe(0);
  } finally { f.close(); }
});

test("lost queue acknowledgement reconciles a durable intent without resending across instances", async () => {
  const f = fixture();
  try {
    f.state.lostAck = true;
    expect((await f.api.submit(f.input)).state).toBe("uncertain");
    const other = new ProfileConversations((f.api as any).config, f.options);
    expect((await other.submit(f.input)).state).toBe("queued");
    expect(f.state.adds).toHaveLength(1); expect(f.state.wakes).toBe(1); other.close();
    await expect(f.api.submit({ ...f.input, text: "different" })).rejects.toThrow("profile_submission_conflict");
  } finally { f.close(); }
});

test("duplicate click and another submission cannot race a second write to the same thread", async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.api.submit(f.input), f.api.submit(f.input)]);
    expect(results.every(r => ["queued", "uncertain"].includes(r.state))).toBe(true);
    expect(f.state.adds).toHaveLength(1);
    await expect(f.api.submit({ ...f.input, submissionId: SECOND })).rejects.toThrow("profile_message_pending");
    expect(f.state.adds).toHaveLength(1);
  } finally { f.close(); }
});

test("foreign manifest thread, invalid text and malformed receipt never send or claim completion", async () => {
  const f = fixture();
  try {
    await expect(f.api.submit({ ...f.input, threadId: OTHER })).rejects.toThrow("profile_session_unavailable");
    await expect(f.api.submit({ ...f.input, text: "가".repeat(12000) })).rejects.toThrow("profile_message_invalid");
    expect(f.state.adds).toHaveLength(0);
    await f.api.submit(f.input); f.state.queue = [];
    f.state.turn = { threadId: OTHER, turnId: TURN, status: "completed", errorCode: null, completedAtMs: NOW + 1000 };
    expect((await f.api.receipt("b", SUBMIT)).state).toBe("uncertain");
    await expect(f.api.receipt("a", SUBMIT)).rejects.toThrow("profile_receipt_not_found");
  } finally { f.close(); }
});

test("known pre-insert rejections carry accepted false but reused submission conflicts do not", async () => {
  const f = fixture();
  try {
    for (const input of [{ ...f.input, threadId: OTHER }, { ...f.input, text: "bad\u0000text" }]) {
      try { await f.api.submit(input); throw new Error("expected rejection"); }
      catch (error: any) { expect(error.accepted).toBe(false); }
    }
    await f.api.submit(f.input);
    try { await f.api.submit({ ...f.input, text: "changed" }); throw new Error("expected conflict"); }
    catch (error: any) { expect(error.accepted).toBeUndefined(); }
    expect(f.state.adds).toHaveLength(1);
  } finally { f.close(); }
});

test("a delayed host wake receipt cannot downgrade a concurrently completed turn", async () => {
  const f = fixture();
  try {
    f.options.wake = async request => {
      await request.beforeSend(); f.state.queue = [];
      f.state.turn = { threadId: THREAD, turnId: TURN, status: "completed", errorCode: null, completedAtMs: NOW + 1000 };
      expect((await f.api.receipt("b", SUBMIT)).state).toBe("completed");
      return { status: "sent" };
    };
    expect((await f.api.submit(f.input)).state).toBe("completed");
    expect((await f.api.receipt("b", SUBMIT)).state).toBe("completed");
  } finally { f.close(); }
});

test("expired eligible credentials and a changed native owner fail before enqueue", async () => {
  for (const kind of ["expired", "owner"]) {
    const f = fixture();
    try {
      if (kind === "expired") f.accounts[1]!.tokenExpiresAt = NOW;
      else { let count = 0; f.options.owner = async () => ({ pid: ++count, startedAtMs: 100 }); }
      expect((await f.api.submit(f.input)).state).toBe("failed");
      expect(f.state.adds).toHaveLength(0);
    } finally { f.close(); }
  }
});

test("a thread absent from the official unarchived list is rejected without enqueue", async () => {
  const f = fixture();
  try {
    let pages = 0;
    f.client.listThreads = async params => {
      expect(params.archived).toBe(false); pages++;
      return { data: [{ id: OTHER, cwd: "/other", name: "Other" }], nextCursor: "repeated" };
    };
    expect(await f.api.submit(f.input)).toMatchObject({ state: "failed", reason: "profile_thread_unavailable" });
    expect(pages).toBe(2); expect(f.state.adds).toHaveLength(0);
  } finally { f.close(); }
});

test.each(["active", "finished", "queue"])("activity changing during owner reinspection (%s) is rejected before enqueue", async kind => {
  const f = fixture();
  try {
    let checks = 0;
    f.options.owner = async () => {
      if (++checks === 2) {
        if (kind === "active") f.state.active = true;
        if (kind === "finished") f.client.readLatestTurn = async () => ({ threadId: THREAD, turnId: TURN,
          status: "failed", errorCode: null, completedAtMs: NOW - 1000 });
        if (kind === "queue") f.state.queue = [{ id: SECOND, clientUserMessageId: SECOND }];
      }
      return f.state.owner;
    };
    expect((await f.api.submit(f.input)).state).toBe("failed");
    expect(f.state.adds).toHaveLength(0);
  } finally { f.close(); }
});

test("an accepted input can retry a temporary wake with durable backoff without another add", async () => {
  const f = fixture();
  try {
    let now = NOW, wakes = 0;
    f.options.now = () => now;
    f.options.wake = async request => {
      await request.beforeSend(); wakes++;
      return wakes === 1 ? { status: "unavailable", reason: "host-wake-unavailable" } as any : { status: "sent" };
    };
    expect((await f.api.submit(f.input)).state).toBe("queued");
    await f.api.receipt("b", SUBMIT); expect(wakes).toBe(1);
    now += 30000;
    const another = new ProfileConversations((f.api as any).config, f.options);
    await Promise.all([f.api.receipt("b", SUBMIT), another.receipt("b", SUBMIT)]);
    expect(wakes).toBe(2); expect(f.state.adds).toHaveLength(1);
    await another.close();
  } finally { f.close(); }
});

test.each(["owner", "pool", "latest"])("wake retries stop after %s changes and never add a second input", async kind => {
  const f = fixture();
  try {
    let now = NOW, sends = 0;
    f.options.now = () => now;
    f.options.wake = async request => { await request.beforeSend(); sends++; return { status: "unavailable" } as any; };
    await f.api.submit(f.input); expect(sends).toBe(1); now += 30000;
    if (kind === "owner") f.state.owner = { pid: 789, startedAtMs: 200 };
    if (kind === "pool") f.state.policy.enabled = false;
    if (kind === "latest") f.client.readLatestTurn = async () => ({ threadId: THREAD, turnId: TURN,
      status: "failed", errorCode: null, completedAtMs: NOW - 1000 });
    await f.api.receipt("b", SUBMIT);
    expect(sends).toBe(1); expect(f.state.adds).toHaveLength(1);
  } finally { f.close(); }
});

test("profile conversation endpoints reject browser origins and absent action tokens before reads or writes", async () => {
  const { startDashboard } = await import("../src/server"), { QuotaPieService } = await import("../src/service"), { QuotaDatabase } = await import("../src/db");
  const config = structuredClone(DEFAULT_CONFIG); config.collection.codexEnabled = false; config.dashboard.port = 0;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:")), server = startDashboard(service, config);
  try {
    const base = `http://127.0.0.1:${server.port}`, status: any = await (await fetch(base + "/api/status")).json();
    for (const path of ["/api/profiles/conversations?account=b", "/api/profiles/message?account=b&submissionId=" + SUBMIT]) {
      expect((await fetch(base + path)).status).toBe(403);
      expect((await fetch(base + path, { headers: { origin: "https://example.com", "x-quotapie-action-token": status.actionToken } })).status).toBe(403);
    }
    const invalid = await fetch(base + "/api/profiles/message", { method: "POST", body: "{bad", headers: { "x-quotapie-action-token": status.actionToken } });
    expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: "profile_message_invalid", accepted: false });
  } finally { server.stop(true); await service.close(); }
});

test("verified official catalogue brackets metadata with account reads and strips preview", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qp-verified-catalogue-"))), binary = join(root, "codex");
  writeFileSync(join(root, "auth.json"), "{}");
  writeFileSync(binary, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);if(r.id==null)continue;appendFileSync(process.env.CODEX_HOME+'/calls',r.method+'\\n');let result={};
if(r.method==='account/read')result={account:{type:'chatgpt',email:'test@example.invalid'}};
if(r.method==='thread/list')result={data:[{id:'${THREAD}',cwd:'/tmp',name:'Title',preview:'private transcript'}],nextCursor:null};
console.log(JSON.stringify({id:r.id,result}));}`, { mode: 0o700 });
  const client = new CodexAppServerClient(binary, "test", 2000, root);
  try {
    expect(await client.listVerifiedThreads({ limit: 64, useStateDbOnly: true })).toEqual({ data: [{ id: THREAD, cwd: "/tmp", name: "Title" }], nextCursor: null });
    expect(readFileSync(join(root, "calls"), "utf8").trim().split("\n")).toEqual(["initialize", "account/read", "thread/list", "account/read"]);
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});
