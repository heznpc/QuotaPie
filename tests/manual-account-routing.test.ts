import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../src/config";
import { createRelayRuntime, type RuntimeMemory } from "../src/codex-relay-runtime";
import { profileReference } from "../src/work-boundary";
import { manualTargets, setManualTarget, manualRoutingDatabasePath } from "../src/manual-account-routing";

const model = "gpt-6-astra", compactModel = "gpt-5.6-sol", token = "a".repeat(48);
const complete = () => new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } });
async function fixture(run: (f: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "qp-manual-routing-")), data = join(root, "data"), configPath = join(root, "config.json");
  mkdirSync(data); const now = Date.now(), thread = randomUUID(), memory: RuntimeMemory = {};
  const config = structuredClone(DEFAULT_CONFIG); config.accounts.claude = [];
  const accounts = ["a", "b"].map((id, index) => {
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
  const policy: any = { enabled: true, accounts: ["a", "b"] };
  const publish = () => {
    writeFileSync(join(data, "account-pool.json"), JSON.stringify(policy));
    writeFileSync(join(data, "work-state.json"), JSON.stringify({ schemaVersion: 1, generatedAtMs: now - 1000, expiresAtMs: now + 600000, accounts: accounts.map(a => a.row) }));
  }; publish();
  const previous = { home: process.env.QUOTAPIE_HOME, config: process.env.QUOTAPIE_CONFIG, fetch: globalThis.fetch };
  process.env.QUOTAPIE_HOME = data; process.env.QUOTAPIE_CONFIG = configPath;
  const sent: any[] = []; let serve = async (_request: any): Promise<Response> => complete();
  globalThis.fetch = (async (url: any, init: any) => {
    const request = { url: String(url), headers: new Headers(init.headers), body: await new Response(init.body).text() };
    sent.push(request); return serve(request);
  }) as any;
  const runtime = createRelayRuntime({ port: 45001, token, codex_home: accounts[0]!.home,
    route: { from: "gpt-6-astra", to: "gpt-6-astra", effort: "low" }, taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" } }, memory);
  const history = [{ type: "compaction", id: "original-item", encrypted_content: "original-encrypted-history" }, { role: "user", content: "Continue" }];
  const request = (input: any = { model, input: history, stream: true }, options: any = {}) => runtime.fetch(new Request(`http://127.0.0.1/${token}/backend-api/codex${options.path ?? "/responses"}`, {
    method: options.method ?? "POST", headers: { authorization: `Bearer ${accounts[0]!.access}`, "chatgpt-account-id": "a", "content-type": "application/json",
      ...(options.omitThread ? {} : { session_id: options.thread ?? thread }), "x-codex-turn-metadata": JSON.stringify({ turn_id: options.turn ?? randomUUID() }), ...options.headers },
    ...(["GET", "HEAD"].includes(options.method) ? {} : { body: options.raw ?? JSON.stringify(input) }) }));
  const select = (account = "b", pendingTurnId?: string) => setManualTarget({ sourceAccount: "a", threadId: thread, account, model }, { config, pendingTurnId });
  try { await run({ config, accounts, data, policy, publish, sent, request, runtime, memory, thread, history, select, serve: (fn: any) => { serve = fn; } }); }
  finally {
    runtime.close(); memory.dispose?.(); globalThis.fetch = previous.fetch;
    if (previous.home === undefined) delete process.env.QUOTAPIE_HOME; else process.env.QUOTAPIE_HOME = previous.home;
    if (previous.config === undefined) delete process.env.QUOTAPIE_CONFIG; else process.env.QUOTAPIE_CONFIG = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
}

test("manual choice routes exact native history to B and survives source recovery", () => fixture(async f => {
  const selected = await f.select();
  expect(selected).toMatchObject({ sourceAccount: "a", account: "b", threadId: f.thread, model });
  expect(Object.keys(manualTargets()[0]!)).toEqual(["sourceAccount", "threadId", "account", "model", "selectedAtMs", "revision"]);
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

test("choice affects the next HTTP request while an existing A stream completes", () => fixture(async f => {
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

for (const change of ["quota", "stale", "target-identity", "source-identity", "policy", "model"]) test(`manual ${change} failure never sends to A`, () => fixture(async f => {
  await f.select();
  if (change === "quota") f.accounts[1].row.windows[0].remainingPercent = 0;
  if (change === "stale") f.accounts[1].row.windows[0].validUntilMs = Date.now() - 1;
  if (change.endsWith("identity")) {
    const index = change === "target-identity" ? 1 : 0;
    const path = join(f.accounts[index].home, "auth.json");
    writeFileSync(path, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "changed", access_token: f.accounts[index].access } }));
  }
  if (change === "policy") f.policy.enabled = false;
  f.publish();
  const response = await f.request(change === "model" ? { model: "unsupported-model", input: f.history } : undefined);
  expect(response.status).toBeGreaterThanOrEqual(400); await response.text(); expect(f.sent).toHaveLength(0);
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

test("native tool stays with its completed B turn even after the next-request choice changes", () => fixture(async f => {
  await f.select(); const turn = randomUUID();
  await (await f.request(undefined, { turn })).text();
  f.accounts[0].row.windows[0].remainingPercent = 90; f.accounts[0].row.windows[0].observedAtMs = Date.now(); f.publish(); await f.select("a");
  const search = await f.request({ query: "fixture" }, { path: "/alpha/search", turn }); expect(search.status).toBe(200); await search.text();
  expect(f.sent.at(-1).headers.get("chatgpt-account-id")).toBe("b");
  const remote = await f.request({ file_id: "foreign" }, { path: "/images/edits", turn }); expect(remote.status).toBeGreaterThanOrEqual(400); await remote.text();
  expect(f.sent).toHaveLength(2);
}));

test("selected target 429 is returned once with no automatic source credit fallback", () => fixture(async f => {
  await f.select(); f.accounts[0].row.windows[0].remainingPercent = 90; f.publish();
  f.serve(async () => new Response('{"error":{"code":"usage_limit_reached"}}', { status: 429 }));
  const response = await f.request(); expect(response.status).toBe(429); await response.text();
  expect(f.sent).toHaveLength(1); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));

test("source-only automatic recovery conflicts with manual selection instead of silently using source", () => fixture(async f => {
  await f.select();
  const response = await f.request({ model, input: [...f.history.slice(0, 1), { role: "user", content: "[QuotaPie quota recovery:test]\nContinue" }], stream: true });
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "pool_manual_execution_conflict" } }); expect(f.sent).toHaveLength(0);
}));

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
