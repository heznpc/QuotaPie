import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../src/config";
import { createRelayRuntime, type RuntimeMemory, type RuntimeSettings } from "../src/codex-relay-runtime";
import { profileReference } from "../src/work-boundary";
import { AccountPool, poolAccounts } from "../src/account-pool";
import { manualTargets, setManualTarget, manualRoutingDatabasePath } from "../src/manual-account-routing";
import { nativeToolHistory } from "./fixtures/native-history";

const model = "gpt-6-astra", compactModel = "gpt-5.6-sol", token = "a".repeat(48);
const complete = () => new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } });
async function fixture(run: (f: any) => Promise<void>, accountIDs = ["a", "b"]) {
  const root = mkdtempSync(join(tmpdir(), "qp-manual-routing-")), data = join(root, "data"), configPath = join(root, "config.json");
  mkdirSync(data); const now = Date.now(), thread = randomUUID(), memory: RuntimeMemory = {};
  const config = structuredClone(DEFAULT_CONFIG); config.accounts.claude = [];
  const accounts = accountIDs.map((id, index) => {
    const home = join(root, id); mkdirSync(home);
    const access = `test.${Buffer.from(JSON.stringify({ sub: id, exp: (now + 3600000) / 1000 })).toString("base64url")}.test`;
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: id, access_token: access } }));
    utimesSync(authPath, (now - 5000) / 1000, (now - 5000) / 1000);
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: model }, { slug: compactModel }] }));
    const rollout = join(home, "rollout.jsonl");
    writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: thread } }) + "\n");
    const db = new Database(join(home, "state_1.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT,rollout_path TEXT)"); db.query("INSERT INTO threads VALUES (?,?)").run(thread, rollout); db.close();
    return { id, home, access, row: { provider: "codex", account: id, profileKey: profileReference(home), collectionState: "recent-success", collectionErrorCategory: null,
      windows: [{ bucket: "codex:primary:300", quality: "authoritative", freshness: "fresh", remainingPercent: index ? 90 : 0,
        observedAtMs: now - 1000, resetsAtMs: now + 3600000, validUntilMs: now + 600000 }] as any[] } };
  });
  config.accounts.codex = accounts.map(a => ({ id: a.id, label: a.id, enabled: true, codexHome: a.home }));
  writeFileSync(configPath, JSON.stringify(config));
  const policy: any = { enabled: true, accounts: accountIDs };
  const publish = () => {
    writeFileSync(join(data, "account-pool.json"), JSON.stringify(policy));
    writeFileSync(join(data, "work-state.json"), JSON.stringify({ schemaVersion: 1, generatedAtMs: now - 1000, expiresAtMs: now + 600000, accounts: accounts.map(a => a.row) }));
  }; publish();
  const previous = { home: process.env.QUOTAPIE_HOME, config: process.env.QUOTAPIE_CONFIG, fetch: globalThis.fetch };
  process.env.QUOTAPIE_HOME = data; process.env.QUOTAPIE_CONFIG = configPath;
  const sent: any[] = []; let serve = async (_request: any): Promise<Response> => complete();
  globalThis.fetch = (async (url: any, init: any) => {
    const headers = new Headers(init.headers), bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    const request = { url: String(url), headers, bytes,
      body: new TextDecoder().decode(headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes) };
    sent.push(request); return serve(request);
  }) as any;
  const runtimeSettings: RuntimeSettings = { port: 45001, token, codex_home: accounts[0]!.home,
    route: { from: "gpt-6-astra", to: "gpt-6-astra", effort: "low" }, taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" } };
  let runtime = createRelayRuntime(runtimeSettings, memory);
  const restart = () => {
    runtime.close(); memory.dispose?.();
    for (const key of Object.keys(memory)) delete (memory as any)[key];
    runtime = createRelayRuntime(runtimeSettings, memory);
  };
  const history = [{ type: "compaction", id: "original-item", encrypted_content: "original-encrypted-history" }, { role: "user", content: "Continue" }];
  const request = (input: any = { model, input: history, stream: true }, options: any = {}) => runtime.fetch(new Request(`http://127.0.0.1/${token}/backend-api/codex${options.path ?? "/responses"}`, {
    method: options.method ?? "POST", headers: { authorization: `Bearer ${accounts[0]!.access}`, "chatgpt-account-id": "a", "content-type": "application/json",
      ...(options.omitThread ? {} : { session_id: options.thread ?? thread }), "x-codex-turn-metadata": JSON.stringify({ turn_id: options.turn ?? randomUUID() }), ...options.headers },
    ...(["GET", "HEAD"].includes(options.method) ? {} : { body: options.raw ?? JSON.stringify(input) }) }));
  const select = (account = "b", pendingTurnId?: string) => setManualTarget({ sourceAccount: "a", threadId: thread, account, model }, { config, pendingTurnId });
  try { await run({ config, accounts, data, policy, publish, sent, request, runtime, memory, thread, history, select, restart, serve: (fn: any) => { serve = fn; } }); }
  finally {
    runtime.close(); memory.dispose?.(); globalThis.fetch = previous.fetch;
    if (previous.home === undefined) delete process.env.QUOTAPIE_HOME; else process.env.QUOTAPIE_HOME = previous.home;
    if (previous.config === undefined) delete process.env.QUOTAPIE_CONFIG; else process.env.QUOTAPIE_CONFIG = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
}

test("new conversation preference sends the very first prompt to B and persists across restart", () => fixture(async f => {
  f.policy.newConversationTarget = { account: "b", identity: poolAccounts(f.config).find(a => a.id === "b")!.identity };
  f.policy.enabled = false;
  f.publish();
  const first = { model, reasoning: { effort: "high" }, input: [{ role: "developer", content: "Workspace instructions" },
    { role: "user", content: "Start a new project" }], stream: true };
  let response = await f.request(first);
  expect(response.status).toBe(200); await response.text();
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
  expect(JSON.parse(f.sent[0].body)).toEqual(first);
  expect(manualTargets()[0]).toMatchObject({ account: "b", threadId: f.thread });
  delete f.policy.newConversationTarget; f.publish(); f.restart();
  response = await f.request();
  expect(response.status).toBe(200); await response.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
}));

test("new conversation preference rejects a replaced login instead of spending the source account", () => fixture(async f => {
  f.policy.newConversationTarget = { account: "b", identity: "f".repeat(64) }; f.publish();
  const response = await f.request({ model, input: [{ role: "user", content: "New work" }] });
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("pool_manual_target_identity_changed");
  expect(f.sent).toHaveLength(0);
}));

for (const remaining of [0, null]) {
  test(`new conversation preference falls back when its quota is ${remaining === null ? "unknown" : "exhausted"}`, () => fixture(async f => {
    f.policy.newConversationTarget = { account: "a", identity: poolAccounts(f.config).find(a => a.id === "a")!.identity };
    f.accounts[0].row.windows[0].remainingPercent = remaining;
    f.publish();
    const body = { model, reasoning: { effort: "high" }, input: [{ role: "user", content: "New work" }] };
    const response = await f.request(body);
    expect(response.status).toBe(200); await response.text();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
    expect(JSON.parse(f.sent[0].body)).toEqual(body);
    expect(manualTargets()[0]?.account).toBe("a");
  }));
}

test("new conversation preference keeps quota enforcement when automatic switching is disabled", () => fixture(async f => {
  f.policy.newConversationTarget = { account: "a", identity: poolAccounts(f.config).find(a => a.id === "a")!.identity };
  f.policy.enabled = false; f.publish();
  const response = await f.request({ model, input: [{ role: "user", content: "New work" }] });
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("pool_manual_quota_exhausted");
  expect(f.sent).toHaveLength(0);
}));

test("new conversation preference never overwrites an existing explicit choice", () => fixture(async f => {
  await f.select("b");
  f.policy.newConversationTarget = { account: "a", identity: poolAccounts(f.config).find(a => a.id === "a")!.identity }; f.publish();
  const response = await f.request({ model, input: [{ role: "user", content: "New work" }] });
  expect(response.status).toBe(200); await response.text();
  expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));

test("new conversation preference does not override a fork's existing account", () => fixture(async f => {
  await f.select("b");
  let response = await f.request(); expect(response.status).toBe(200); await response.text();
  f.policy.newConversationTarget = { account: "a", identity: poolAccounts(f.config).find(a => a.id === "a")!.identity }; f.publish();
  const child = randomUUID(), rollout = join(f.accounts[0].home, "child.jsonl");
  writeFileSync(rollout, JSON.stringify({type:"session_meta",payload:{id:child,forked_from_id:f.thread}})+"\n");
  const db = new Database(join(f.accounts[0].home,"state_1.sqlite"));
  db.query("INSERT INTO threads VALUES (?,?)").run(child,rollout); db.close();
  response = await f.request({model,input:[{role:"user",content:"Child work"}]},{thread:child});
  expect(response.status).toBe(200); await response.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
  expect(manualTargets().some(t=>t.threadId===child)).toBe(false);
}));

test("manual choice routes exact native history to B and survives source recovery", () => fixture(async f => {
  const selected = await f.select();
  expect(selected).toMatchObject({ sourceAccount: "a", account: "b", threadId: f.thread, model });
  expect(Object.keys(manualTargets()[0]!)).toEqual(["sourceAccount", "threadId", "account", "model", "selectedAtMs", "revision", "appliedAtMs"]);
  expect(readFileSync(manualRoutingDatabasePath()).includes(Buffer.from(f.accounts[0].access))).toBe(false);
  for (let i = 0; i < 2; i++) {
    const response = await f.request(); expect(response.status).toBe(200); await response.text();
    expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
    expect(JSON.parse(f.sent.at(-1).body).input).toEqual(f.history);
    f.accounts[0].row.windows[0].remainingPercent = 90; f.accounts[0].row.windows[0].observedAtMs = Date.now(); f.publish();
  }
  expect(f.runtime.snapshot().manualAccountRoutingVersion).toBe(1);
  expect(f.runtime.snapshot().recent.at(-1).accountRouting.reason).toBe("manual");
}));

test("all native tool history variants survive manual routing and both compaction paths byte for byte", () => fixture(async f => {
  await f.select();
  for (const encoding of ["identity", "zstd"]) for (const path of ["/responses", "/responses/compact"]) {
    const input = { model, input: [...f.history, ...nativeToolHistory, ...(path === "/responses" ? [{ type: "compaction_trigger" }] : [])],
      metadata: { conversation: "a local label" } };
    const json = JSON.stringify(input, null, 2), raw = encoding === "zstd" ? Bun.zstdCompressSync(json) : Buffer.from(json);
    const response = await f.request(input, { path, raw, headers: { "content-encoding": encoding } });
    expect(response.status).toBe(200); await response.text();
    expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
    expect(f.sent.at(-1).bytes).toEqual(new Uint8Array(raw));
    expect(f.sent.at(-1).body).toBe(json);
  }
}));

test("choice affects the next HTTP request while an existing A stream completes", () => fixture(async f => {
  f.accounts[0].row.windows[0].remainingPercent = 90; f.publish();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  f.serve(async () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { "content-type": "text/event-stream" } }));
  const oldTurn = randomUUID(), old = await f.request(undefined, { turn: oldTurn }); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("a");
  await f.select(); f.serve(async () => complete());
  const oldTool = await f.request(undefined, { path: "/images/edits", turn: oldTurn, raw: "original multipart source body", headers: { "content-type": "multipart/form-data; boundary=fixture" } });
  expect(oldTool.status).toBe(200); await oldTool.text();
  expect(f.sent[1].headers.get("chatgpt-account-id")).toBe("a"); expect(f.sent[1].body).toBe("original multipart source body");
  const next = await f.request(); expect(next.status).toBe(200); await next.text();
  expect(f.sent[2].headers.get("chatgpt-account-id")).toBe("b");
  controller!.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')); controller!.close();
  expect(await old.text()).toContain("response.completed");
}));

test("first hot reload pending choice preserves only the observed original source turn until activation", () => fixture(async f => {
  const oldTurn = randomUUID(); await f.select("b", oldTurn);
  const oldTool = await f.request({ file_id: "source-owned-handle" }, { path: "/images/edits", turn: oldTurn });
  expect(oldTool.status).toBe(200); await oldTool.text(); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("a");
  for (const options of [{ turn: randomUUID() }, { omitThread: true, turn: oldTurn }]) {
    const blocked = await f.request({ query: "fixture" }, { ...options, path: "/alpha/search" });
    expect(blocked.status).toBeGreaterThanOrEqual(400); await blocked.text();
  }
  expect(f.sent).toHaveLength(1);
  await (await f.request()).text(); expect(f.sent[1].headers.get("chatgpt-account-id")).toBe("b");
  f.memory.manualRouting.bindings.clear();
  const afterActivation = await f.request({ query: "fixture" }, { path: "/alpha/search", turn: oldTurn });
  expect(afterActivation.status).toBe(409); await afterActivation.text(); expect(f.sent).toHaveLength(2);
}));

test("a pending selection cannot turn source identity changes into an old-turn fallback", () => fixture(async f => {
  const turn = randomUUID(); await f.select("b", turn);
  writeFileSync(join(f.accounts[0].home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "changed", access_token: f.accounts[0].access } }));
  const response = await f.request({ query: "fixture" }, { path: "/alpha/search", turn });
  expect(response.status).toBeGreaterThanOrEqual(400); await response.text(); expect(f.sent).toHaveLength(0);
}));

test("activation database errors never send the selected request or fall back to source", () => fixture(async f => {
  await f.select(); const db = new Database(manualRoutingDatabasePath()); db.exec("BEGIN IMMEDIATE");
  try {
    const response = await f.request(); expect(response.status).toBeGreaterThanOrEqual(400); await response.text(); expect(f.sent).toHaveLength(0);
  } finally { db.exec("ROLLBACK"); db.close(); }
  const retry = await f.request(); expect(retry.status).toBe(200); await retry.text(); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));

test("concurrent selection remains pending but inherits durable no-source-fallback activation", () => fixture(async f => {
  const oldTurn = randomUUID(); await (await f.request()).text(); f.sent.length = 0;
  await f.select("b", oldTurn);
  const pool = f.memory.interactivePool, select = pool.selectAsync.bind(pool);
  f.accounts[0].row.windows[0].remainingPercent = 90; f.accounts[0].row.windows[0].observedAtMs = Date.now(); f.publish();
  pool.selectAsync = async (...args: any[]) => { const result = await select(...args); await f.select("a", oldTurn); return result; };
  try {
    const response = await f.request(); expect(response.status).toBe(200); await response.text();
    expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b"); expect(manualTargets()[0]!.account).toBe("a");
    f.memory.manualRouting.bindings.clear();
    const oldTool = await f.request({ query: "fixture" }, { path: "/alpha/search", turn: oldTurn });
    expect(oldTool.status).toBe(409); await oldTool.text(); expect(f.sent).toHaveLength(1);
  } finally { pool.selectAsync = select; }
}));

test("native compaction and a changed supported response model retain the selected account", () => fixture(async f => {
  await f.select();
  for (const path of ["/responses/compact", "/responses"]) {
    const response = await f.request({ model: compactModel, input: f.history, stream: true }, { path });
    expect(response.status).toBe(200); await response.text();
    expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
    expect(JSON.parse(f.sent.at(-1).body)).toEqual({ model: compactModel, input: f.history, stream: true });
  }
}));

for (const compacted of [false, true]) for (const encoding of ["identity", "zstd"]) {
  test(`manual native trigger and cancelled calls survive ${encoding}, prior compaction ${compacted}`, () => fixture(async f => {
    await f.select();
    const history = [
      ...(compacted ? f.history : [{ role: "user", content: "Continue" }]),
      { type: "function_call", call_id: "cancelled", name: "run", arguments: "{}" },
    ];
    for (const path of ["/responses", "/responses/compact"]) {
      const body = { model, input: [...history, ...(path === "/responses" ? [{ type: "compaction_trigger" }] : [])], stream: true };
      const raw = JSON.stringify(body, null, 2) + "\n";
      const bytes = encoding === "zstd" ? Bun.zstdCompressSync(raw) : new TextEncoder().encode(raw);
      const response = await f.request(body, { path, raw: bytes,
        headers: { "content-encoding": encoding } });
      expect(response.status).toBe(200); await response.text();
      expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
      expect(f.sent.at(-1).body).toBe(raw);
      expect(f.sent.at(-1).bytes).toEqual(new Uint8Array(bytes));
    }
    const next = await f.request({ model, input: history, stream: true });
    expect(next.status).toBe(200); await next.text();
    expect(f.sent).toHaveLength(3);
  }));
}

for (const change of ["quota", "stale", "target-identity", "source-identity", "policy", "model"]) test(`manual ${change} failure never sends to A`, () => fixture(async f => {
  await f.select();
  if (change === "quota") f.accounts[1].row.windows[0].remainingPercent = 0;
  if (change === "stale") f.accounts[1].row.windows[0].validUntilMs = Date.now() - 1;
  if (change.endsWith("identity")) {
    const index = change === "target-identity" ? 1 : 0;
    const path = join(f.accounts[index].home, "auth.json");
    writeFileSync(path, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "changed", access_token: f.accounts[index].access } }));
  }
  if (change === "policy") f.policy.accounts = ["a"];
  f.publish();
  const response = await f.request(change === "model" ? { model: "unsupported-model", input: f.history } : undefined);
  expect(response.status).toBeGreaterThanOrEqual(400); await response.text(); expect(f.sent).toHaveLength(0);
}));

for (const failure of ["exhausted", "stale"]) for (const path of ["/responses", "/responses/compact"]) {
  test(`manual ${failure} preference rolls over with native history on ${path}`, () => fixture(async f => {
    await f.select(); await (await f.request()).text();
    f.accounts[0].row.windows[0].remainingPercent = 75;
    f.accounts[0].row.windows[0].observedAtMs = Date.now();
    if (failure === "exhausted") f.accounts[1].row.windows[0].remainingPercent = 0;
    else f.accounts[1].row.windows[0].validUntilMs = Date.now() - 1;
    f.accounts[1].row.windows[0].observedAtMs = Date.now(); f.publish();
    const input = { model, reasoning: { effort: "xhigh" }, input: [...f.history, ...nativeToolHistory], stream: true };
    const json = JSON.stringify(input, null, 2), raw = Bun.zstdCompressSync(json), turn = randomUUID();
    for (let i = 0; i < 2; i++) {
      const response = await f.request(input, { path, turn, raw, headers: { "content-encoding": "zstd" } });
      expect(response.status).toBe(200); await response.text();
      expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("a");
      expect(f.sent.at(-1).bytes).toEqual(new Uint8Array(raw));
      expect(JSON.parse(f.sent.at(-1).body)).toEqual(input);
    }
    if (path === "/responses") {
      const tool = await f.request({ query: "fixture" }, { path: "/alpha/search", turn });
      expect(tool.status).toBe(200); await tool.text();
      expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("a");
    }
    expect(manualTargets()[0]!.account).toBe("b");
  }));
}

test("disabled switching still honors the manual preference without silent fallback", () => fixture(async f => {
  await f.select(); f.policy.enabled = false;
  f.accounts[0].row.windows[0].remainingPercent = 80;
  f.accounts[1].row.windows[0].remainingPercent = 0; f.publish();
  const response = await f.request(); expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("pool_manual_quota_exhausted");
  expect(f.sent).toHaveLength(0);
}));

for (const path of ["/responses", "/responses/compact"]) test(`manual provider 429 rolls over without rewriting ${path}`, () => fixture(async f => {
  await f.select();
  f.accounts[0].row.windows[0].remainingPercent = 80;
  f.accounts[0].row.windows[0].observedAtMs = Date.now(); f.publish();
  f.serve(async (request: any) => request.headers.get("chatgpt-account-id") === "b"
    ? new Response("quota exhausted", { status: 429, headers: { "retry-after": "60" } }) : complete());
  const input = { model, reasoning: { effort: "xhigh" }, input: f.history, stream: true };
  const raw = Bun.zstdCompressSync(JSON.stringify(input, null, 2)), turn = randomUUID();
  const response = await f.request(input, { path, turn, raw, headers: { "content-encoding": "zstd" } });
  expect(response.status).toBe(200); await response.text();
  expect(f.sent.map((r: any) => r.headers.get("chatgpt-account-id"))).toEqual(["b", "a"]);
  for (const sent of f.sent) { expect(sent.bytes).toEqual(new Uint8Array(raw)); expect(JSON.parse(sent.body)).toEqual(input); }
  if (path === "/responses") {
    const tool = await f.request({ query: "fixture" }, { path: "/alpha/search", turn });
    expect(tool.status).toBe(200); await tool.text(); expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("a");
  }
  const next = await f.request(input); expect(next.status).toBe(200); await next.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("a");
}));

for (const allExhausted of [false, true]) test(`manual rollover visits each eligible account once; all exhausted ${allExhausted}`, () => fixture(async f => {
  await f.select();
  f.accounts[0].row.windows[0].remainingPercent = 80;
  f.accounts[0].row.windows[0].observedAtMs = Date.now(); f.publish();
  f.serve(async (request: any) => !allExhausted && request.headers.get("chatgpt-account-id") === "c" ? complete()
    : new Response("quota exhausted", { status: 429, headers: { "retry-after": "60" } }));
  const response = await f.request(); expect(response.status).toBe(allExhausted ? 429 : 200); await response.text();
  expect(f.sent.map((r: any) => r.headers.get("chatgpt-account-id"))).toEqual(["b", "a", "c"]);
}, ["a", "b", "c"]));

test("a successful response stream is never replayed after a quota error in its body", () => fixture(async f => {
  await f.select(); f.accounts[0].row.windows[0].remainingPercent = 80; f.publish();
  const failure = 'data: {"type":"error","error":{"code":"rate_limit_exceeded"}}\n\n';
  f.serve(async () => new Response(failure, { headers: { "content-type": "text/event-stream" } }));
  const response = await f.request(); expect(await response.text()).toBe(failure); expect(f.sent).toHaveLength(1);
}));

for (const request of ["malformed", "remote", "unknown", "missing-thread", "unbound-tool"]) test(`manual ${request} request is blocked without source pass-through`, () => fixture(async f => {
  await f.select();
  const response = request === "malformed" ? await f.request(undefined, { raw: "{" })
    : request === "remote" ? await f.request({ model, input: f.history, previous_response_id: "foreign" })
    : request === "unknown" ? await f.request({ value: "unknown" }, { path: "/future-native-operation" })
    : request === "missing-thread" ? await f.request(undefined, { omitThread: true })
    : await f.request({ query: "fixture" }, { path: "/alpha/search" });
  expect(response.status).toBeGreaterThanOrEqual(400); await response.text(); expect(f.sent).toHaveLength(0);
}));

test("manual history rejection explains its fixed reason without exposing history", () => fixture(async f => {
  await f.select();
  const response = await f.request({ model, input: f.history, previous_response_id: "private-response-id" });
  expect(response.status).toBe(409);
  const error = await response.json();
  expect(error).toMatchObject({ error: { code: "pool_manual_history_unverified", historyFailure: "remote_reference" } });
  expect(error.error.message).toContain("remote_reference");
  expect(JSON.stringify(error)).not.toContain("private-response-id");
  expect(JSON.stringify(error)).not.toContain("original-encrypted-history");
  expect(f.sent).toHaveLength(0);
}));

test("native tool stays with its completed B turn even after the next-request choice changes", () => fixture(async f => {
  await f.select(); const turn = randomUUID();
  await (await f.request(undefined, { turn })).text();
  f.accounts[0].row.windows[0].remainingPercent = 90; f.accounts[0].row.windows[0].observedAtMs = Date.now(); f.publish(); await f.select("a");
  const search = await f.request({ query: "fixture" }, { path: "/alpha/search", turn }); expect(search.status).toBe(200); await search.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
  const remote = await f.request({ file_id: "foreign" }, { path: "/images/edits", turn }); expect(remote.status).toBeGreaterThanOrEqual(400); await remote.text();
  expect(f.sent).toHaveLength(2);
}));

for (const manual of [false, true]) test(`completed turn ownership survives a relay restart (manual ${manual})`, () => fixture(async f => {
  if (manual) await f.select();
  const turn = randomUUID();
  await (await f.request(undefined, { turn })).text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
  f.restart();
  const search = await f.request({ query: "fixture" }, { path: "/alpha/search", turn });
  expect(search.status).toBe(200); await search.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
}));

test("restart does not promote a failed target response to native tool ownership", () => fixture(async f => {
  await f.select(); const turn = randomUUID();
  f.serve(async () => new Response("failed", { status: 500 }));
  await (await f.request(undefined, { turn })).text(); f.restart();
  const search = await f.request({ query: "fixture" }, { path: "/alpha/search", turn });
  expect(search.status).toBe(409);
  expect((await search.json()).error.code).toBe("pool_manual_target_unbound");
  expect(f.sent).toHaveLength(1);
}));

test("restart verifies the recorded account identity against current credentials", () => fixture(async f => {
  await f.select(); const turn = randomUUID();
  await (await f.request(undefined, { turn })).text(); f.restart();
  writeFileSync(join(f.accounts[1].home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "different-login", access_token: f.accounts[1].access } }));
  const search = await f.request({ query: "fixture" }, { path: "/alpha/search", turn });
  expect(search.status).toBe(409); await search.text(); expect(f.sent).toHaveLength(1);
}));

test("selected target 429 cannot fall back to a source with no subscription quota", () => fixture(async f => {
  await f.select();
  f.serve(async () => new Response('{"error":{"code":"usage_limit_reached"}}', { status: 429 }));
  const response = await f.request(); expect(response.status).toBe(429); await response.text();
  expect(f.sent).toHaveLength(1); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));

test("automatic recovery honors the explicit next-request account without source fallback", () => fixture(async f => {
  await f.select();
  const response = await f.request({ model, input: [...f.history.slice(0, 1), { role: "user", content: "[QuotaPie quota recovery:test]\nContinue" }], stream: true });
  expect(response.status).toBe(200); await response.text();
  expect(f.sent).toHaveLength(1); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));

test("automatic recovery cannot bypass the chosen account quota", () => fixture(async f => {
  await f.select();
  f.accounts[1].row.windows[0].remainingPercent = 0; f.publish();
  const response = await f.request({ model, input: [...f.history.slice(0, 1), { role: "user", content: "[QuotaPie quota recovery:test]\nContinue" }], stream: true });
  expect(response.status).toBeGreaterThanOrEqual(400); await response.text();
  expect(f.sent).toHaveLength(0);
}));

test("recovery messages keep rolling over as successive preferred accounts run out", () => fixture(async f => {
  await f.select();
  const input = { model, reasoning: { effort: "xhigh" }, input: [f.history[0],
    { role: "user", content: "[QuotaPie quota recovery:test]\nContinue" }], stream: true };
  for (const [index, expected] of ["a", "b", "a"].entries()) {
    for (const account of f.accounts) {
      account.row.windows[0].remainingPercent = account.id === expected ? 60 : 0;
      account.row.windows[0].observedAtMs = Date.now() + index;
    }
    f.publish();
    const response = await f.request(input); expect(response.status).toBe(200); await response.text();
    expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe(expected);
    expect(JSON.parse(f.sent.at(-1).body)).toEqual(input);
  }
}));

for (const path of ["/responses", "/responses/compact"]) for (const provider429 of [false, true]) {
  test(`automatic native rollover without a manual choice: ${path}, provider 429 ${provider429}`, () => fixture(async f => {
    if (provider429) {
      f.accounts[0].row.windows[0].remainingPercent = 80;
      f.accounts[0].row.windows[0].observedAtMs = Date.now(); f.publish();
      f.serve(async (request: any) => request.headers.get("chatgpt-account-id") === "a"
        ? new Response("quota exhausted", { status: 429, headers: { "retry-after": "60" } }) : complete());
    }
    const input = { model, reasoning: { effort: "xhigh" }, input: [...f.history, ...nativeToolHistory], stream: true };
    const raw = Bun.zstdCompressSync(JSON.stringify(input, null, 2)), turn = randomUUID();
    const response = await f.request(input, { path, turn, raw, headers: { "content-encoding": "zstd" } });
    expect(response.status).toBe(200); await response.text();
    expect(f.sent.map((r: any) => r.headers.get("chatgpt-account-id"))).toEqual(provider429 ? ["a", "b"] : ["b"]);
    for (const sent of f.sent) { expect(sent.bytes).toEqual(new Uint8Array(raw)); expect(JSON.parse(sent.body)).toEqual(input); }
    if (path === "/responses") {
      const tool = await f.request({ query: "fixture" }, { path: "/alpha/search", turn });
      expect(tool.status).toBe(200); await tool.text(); expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
    }
    expect(manualTargets()).toHaveLength(0);
  }));
}

test("policy disabled during asynchronous pool selection cannot turn a selected target into source pass-through", () => fixture(async f => {
  await f.select();
  // Construct the current adapter before adding an await-boundary policy change.
  await (await f.request()).text(); f.sent.length = 0;
  const pool = f.memory.interactivePool, select = pool.selectAsync.bind(pool);
  pool.selectAsync = async (...args: any[]) => { f.policy.enabled = false; f.publish(); return null; };
  try {
    const response = await f.request(); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "pool_manual_target_changed" } });
    expect(f.sent).toHaveLength(0);
  } finally { pool.selectAsync = select; }
}));

for (const compacted of [false, true]) test(`manual account routes native agent history unchanged (compacted ${compacted})`, () => fixture(async f => {
  await f.select();
  const input = [...(compacted ? f.history : [{ role: "user", content: "Continue" }]),
    { type: "agent_message", id: "agent-message-id", author: "/root/research", recipient: "/root",
      content: [{ type: "input_text", text: "Research complete" }, { type: "encrypted_content", encrypted_content: "original-agent-history" }] }];
  const body = { model, input, stream: true };
  const response = await f.request(body); expect(response.status).toBe(200); await response.text();
  expect(f.sent).toHaveLength(1); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
  expect(JSON.parse(f.sent[0].body)).toEqual(body);
}));


test("hot reload replaces the retained version-4 pool before validating native agent history", () => fixture(async f => {
  await (await f.request()).text();
  const old = f.memory.interactivePool;
  expect(old).toBeDefined();
  Object.defineProperty(old, "runtimeApiVersion", { value: 4 });
  old.selectAsync = async () => { throw new Error("old_native_history_validator"); };
  await f.select(); f.sent.length = 0;
  const next = createRelayRuntime({ port: 45001, token, codex_home: f.accounts[0].home,
    route: { from: model, to: model, effort: "low" }, taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" } }, f.memory);
  const body = { model, input: [...f.history, { type: "agent_message", author: "/root/research", recipient: "/root",
    content: [{ type: "input_text", text: "Research complete" }, { type: "encrypted_content", encrypted_content: "original" }] }], stream: true };
  try {
    const response = await next.fetch(new Request(`http://127.0.0.1/${token}/backend-api/codex/responses`, {
      method: "POST", headers: { authorization: `Bearer ${f.accounts[0].access}`, "chatgpt-account-id": "a",
        session_id: f.thread, "x-codex-turn-metadata": JSON.stringify({ turn_id: randomUUID() }) }, body: JSON.stringify(body) }));
    expect(response.status).toBe(200); await response.text();
    expect(f.memory.interactivePool).not.toBe(old);
    expect(next.snapshot!().accountPoolRuntimeVersion).toBe(AccountPool.RUNTIME_API_VERSION);
    expect(f.sent).toHaveLength(1); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
    expect(JSON.parse(f.sent[0].body)).toEqual(body);
  } finally { next.close(); }
}));


for (const enabled of [true, false]) test(`both accounts exhausted: explicit credit consent works with automatic switching ${enabled}`, () => fixture(async f => {
  f.accounts[1].row.windows[0].remainingPercent = 0;
  f.policy.enabled = enabled; f.publish();
  await expect(f.select()).rejects.toThrow("quota_exhausted");
  const account = poolAccounts(f.config).find(a => a.id === "b")!;
  f.policy.creditConsent = { b: { identity: account.identity, allow: true } }; f.publish();
  await f.select();
  const turn = randomUUID(), response = await f.request(undefined, { turn });
  expect(response.status).toBe(200); await response.text();
  expect(f.sent).toHaveLength(1); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
  expect(JSON.parse(f.sent[0].body).input).toEqual(f.history);
  const native = await f.request({ query: "fixture" }, { path: "/alpha/search", turn });
  expect(native.status).toBe(200); await native.text();
  expect(f.sent[1].headers.get("chatgpt-account-id")).toBe("b");
  f.policy.creditConsent.b.allow = false; f.publish();
  const blocked = await f.request(); expect(blocked.status).toBe(409); await blocked.text();
  expect(f.sent).toHaveLength(2);
}));

test("turning automatic switching off preserves an existing manual choice", () => fixture(async f => {
  await f.select(); await (await f.request()).text();
  f.policy.enabled = false; f.publish();
  const next = await f.request(); expect(next.status).toBe(200); await next.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
}));

test("in-memory helpers inherit the confirmed parent account with automatic switching off", () => fixture(async f => {
  await f.select(); await (await f.request()).text();
  const selections = manualTargets();
  f.policy.enabled = false; f.publish();
  const child = randomUUID(), turn = randomUUID();
  const headers = { "thread-id": child, "x-codex-turn-metadata": JSON.stringify({
    thread_id: child, turn_id: turn, forked_from_thread_id: f.thread,
  }) };
  const body = { model, reasoning: { effort: "xhigh" }, input: f.history, stream: true };
  const response = await f.request(body, { thread: child, turn, headers });
  expect(response.status).toBe(200); await response.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
  expect(JSON.parse(f.sent.at(-1).body)).toEqual(body);
  const native = await f.request({ query: "fixture" }, { path: "/alpha/search", thread: child, turn, headers });
  expect(native.status).toBe(200); await native.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
  const compact = await f.request({ model: compactModel, input: f.history, stream: true },
    { path: "/responses/compact", thread: child, turn, headers });
  expect(compact.status).toBe(200); await compact.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
  expect(JSON.parse(f.sent.at(-1).body).model).toBe(compactModel);
  expect(manualTargets()).toEqual(selections);
  expect(JSON.parse(readFileSync(join(f.data, "account-pool.json"), "utf8")).enabled).toBe(false);
}));

test("helpers inherit the account that completed the parent rather than its pending next choice", () => fixture(async f => {
  await f.select(); await (await f.request()).text();
  f.accounts[0].row.windows[0].remainingPercent = 90; f.policy.enabled = false; f.publish();
  await f.select("a");
  const child = randomUUID(), turn = randomUUID();
  const response = await f.request(undefined, { thread: child, turn, headers: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: child, turn_id: turn, forked_from_thread_id: f.thread }),
  } });
  expect(response.status).toBe(200); await response.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
  expect(manualTargets()).toHaveLength(1);
  expect(manualTargets()[0]!.account).toBe("a");
}));

for (const failure of ["unconfirmed-parent", "conflicting-lineage", "target-quota", "source-identity"])
  test(`helper ${failure} never sends with an unverified account`, () => fixture(async f => {
    await f.select();
    if (failure === "unconfirmed-parent") f.serve(async () => new Response("fixture failure", { status: 500 }));
    await (await f.request()).text();
    f.sent.length = 0; f.serve(async () => complete());
    f.policy.enabled = false;
    if (failure === "target-quota") f.accounts[1].row.windows[0].remainingPercent = 0;
    if (failure === "source-identity") writeFileSync(join(f.accounts[0].home, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "replacement", access_token: f.accounts[0].access } }));
    f.publish();
    const child = randomUUID(), turn = randomUUID();
    if (failure === "conflicting-lineage") {
      const home = f.accounts[0].home, rollout = join(home, "child.jsonl");
      writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: child, forked_from_id: randomUUID() } }) + "\n");
      const db = new Database(join(home, "state_1.sqlite"));
      db.query("INSERT INTO threads VALUES (?,?)").run(child, rollout); db.close();
    }
    const response = await f.request(undefined, { thread: child, turn, headers: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: child, turn_id: turn, forked_from_thread_id: f.thread }),
    } });
    expect(response.status).toBeGreaterThanOrEqual(400); await response.text();
    expect(f.sent).toHaveLength(0);
    expect(manualTargets()).toHaveLength(1);
  }));

test("persisted forks inherit the confirmed parent account without changing the automatic switch setting", () => fixture(async f => {
  await f.select(); await (await f.request()).text();
  f.policy.enabled = false; f.publish();
  const child = randomUUID(), home = f.accounts[0].home, rollout = join(home, "child.jsonl");
  writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: child, forked_from_id: f.thread } }) + "\n");
  const db = new Database(join(home, "state_1.sqlite"));
  db.query("INSERT INTO threads VALUES (?,?)").run(child, rollout); db.close();
  const response = await f.request({ model, input: f.history, stream: true }, { thread: child });
  expect(response.status).toBe(200); await response.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
  expect(JSON.parse(readFileSync(join(f.data, "account-pool.json"), "utf8")).enabled).toBe(false);
}));

test("manual selection is independent of automatic reserve threshold", () => fixture(async f => {
  f.policy.reservePercent = { b: 95 }; f.publish();
  await f.select();
  const response = await f.request(); expect(response.status).toBe(200); await response.text();
  expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));

test("credit approval does not follow a changed account identity", () => fixture(async f => {
  const account = poolAccounts(f.config).find(a => a.id === "b")!;
  f.policy.creditConsent = { b: { identity: account.identity, allow: true } };
  f.accounts[1].row.windows[0].remainingPercent = 0; f.publish();
  await f.select();
  writeFileSync(join(f.accounts[1].home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "changed", access_token: f.accounts[1].access } }));
  const blocked = await f.request(); expect(blocked.status).toBe(409); await blocked.text();
  expect(f.sent).toHaveLength(0);
}));

test("disabled automatic switching preserves existing source credit behavior; explicit block is independent", () => fixture(async f => {
  f.policy.enabled = false; f.publish();
  await (await f.request()).text(); expect(f.sent).toHaveLength(1);
  const source = poolAccounts(f.config).find(a => a.id === "a")!;
  f.policy.creditConsent = { a: { identity: source.identity, allow: false } }; f.publish();
  const denied = await f.request(); expect(denied.status).toBeGreaterThanOrEqual(400); await denied.text();
  expect(f.sent).toHaveLength(1);
  f.policy.creditConsent.a.allow = true; f.publish();
  const response = await f.request(); expect(response.status).toBe(200); await response.text();
  expect(f.sent).toHaveLength(2);
}));
