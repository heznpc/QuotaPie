import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../src/config";
import { createRelayRuntime, type RuntimeMemory } from "../src/codex-relay-runtime";
import { profileReference } from "../src/work-boundary";

const model = "gpt-6.1-sol";
const complete = () => new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  { headers: { "content-type": "text/event-stream" } });
async function fixture(run: (f: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "qp-interactive-pool-")), data = join(root, "data"), configPath = join(root, "config.json");
  mkdirSync(data); const now = Date.now(), thread = randomUUID(), memory: RuntimeMemory = {};
  const config = structuredClone(DEFAULT_CONFIG); config.accounts.claude = [];
  const accounts = ["a", "b"].map((id, index) => {
    const home = join(root, id); mkdirSync(home);
    const token = `test.${Buffer.from(JSON.stringify({ sub: id, exp: (now + 3600000) / 1000 })).toString("base64url")}.test`;
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: id, access_token: token } }));
    utimesSync(authPath, (now - 5000) / 1000, (now - 5000) / 1000);
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: model }] }));
    const rollout = join(home, "rollout.jsonl");
    writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: thread } }) + "\n");
    const db = new Database(join(home, "state_1.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT,rollout_path TEXT)"); db.query("INSERT INTO threads VALUES (?,?)").run(thread, rollout); db.close();
    return { id, home, token, row: { provider: "codex", account: id, profileKey: profileReference(home), collectionState: "recent-success", collectionErrorCategory: null,
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
  const runtime = createRelayRuntime({ port: 45001, token: "a".repeat(48), codex_home: accounts[0]!.home,
    route: { from: "gpt-6-astra", to: "gpt-6-astra", effort: "low" }, taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" } }, memory);
  const history = [ { role: "user", content: "Task" }, { type: "reasoning", encrypted_content: "old-cache" },
    { type: "function_call", id: "old-id", call_id: "same-call", name: "tool", arguments: "{}" },
    { type: "function_call_output", call_id: "same-call", output: "done" }, { role: "assistant", content: "Finished earlier part" }, { role: "user", content: "Continue" } ];
  const request = (input: any = { model, input: history, stream: true }, headers: any = {}) => runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/responses`, {
    method: "POST", headers: { authorization: `Bearer ${accounts[0]!.token}`, "chatgpt-account-id": "a", "session_id": thread, ...headers }, body: JSON.stringify(input) }));
  try { await run({ accounts, data, policy, publish, sent, request, runtime, memory, thread, history, serve: (f: any) => { serve = f; } }); }
  finally {
    runtime.close(); memory.dispose?.(); globalThis.fetch = previous.fetch;
    if (previous.home === undefined) delete process.env.QUOTAPIE_HOME; else process.env.QUOTAPIE_HOME = previous.home;
    if (previous.config === undefined) delete process.env.QUOTAPIE_CONFIG; else process.env.QUOTAPIE_CONFIG = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
}

test("actual runtime moves an existing complete session to a fresh account and keeps tool/thread identities", () => fixture(async f => {
  const response = await f.request(); expect(response.status).toBe(200); await response.text();
  expect(f.sent).toHaveLength(1); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
  expect(f.sent[0].headers.get("session_id")).toBe(f.thread);
  const input = JSON.parse(f.sent[0].body).input;
  expect(input.some((x: any) => x.type === "reasoning")).toBe(false);
  expect(input.filter((x: any) => x.call_id).map((x: any) => x.call_id)).toEqual(["same-call", "same-call"]);
  expect(f.runtime.snapshot().recent.at(-1).accountRouting).toMatchObject({ sourceAccount: "a", account: "b", reason: "recovered" });
}));

for (const variant of ["model-zero", "alias-zero", "denied", "spend-denied", "unknown-permission", "unknown-scope", "heuristic", "stale"]) test(`target does not borrow general capacity when ${variant}`, () => fixture(async f => {
  const base = f.accounts[1].row.windows[0];
  if (variant === "model-zero") f.accounts[1].row.windows.push({ ...base, bucket: model + ":300", remainingPercent: 0 });
  if (variant === "alias-zero") f.accounts[1].row.windows.push({ ...base, bucket: "opaque-model:300", remainingPercent: 0, metadata: { normalModelSlug: model } });
  if (variant === "unknown-scope") f.accounts[1].row.windows.push({ ...base, bucket: "opaque-model:300" });
  if (variant === "denied") base.metadata = { ordinaryUsageAllowed: false };
  if (variant === "spend-denied") base.metadata = { spendControlReached: true };
  if (variant === "unknown-permission") base.metadata = { ordinaryUsageAllowed: null };
  if (variant === "heuristic") base.quality = "estimated";
  if (variant === "stale") base.freshness = "stale";
  f.publish(); const response = await f.request(); expect(response.status).toBe(409); await response.text(); expect(f.sent).toHaveLength(0);
}));

test("source reserve does not abort the selected target", () => fixture(async f => {
  f.accounts[0].row.windows[0].remainingPercent = 50; f.policy.reservePercent = { a: 100 }; f.publish();
  const response = await f.request(); expect(response.status).toBe(200); await response.text(); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));

test("disabled pool and opaque history retain native source identity without creating a binding", () => fixture(async f => {
  f.policy.enabled = false; f.publish();
  let response = await f.request({ model, input: [{ role: "user", content: "Native" }] }); expect(response.status).toBe(200); await response.text();
  expect(f.memory.interactivePool).toBeUndefined(); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("a");
  f.policy.enabled = true; f.publish();
  const opaque = { model, input: [{ type: "compaction", encrypted_content: "opaque" }] };
  response = await f.request(opaque); expect(response.status).toBe(200); await response.text();
  expect(f.sent[1].headers.get("chatgpt-account-id")).toBe("a"); expect(f.sent[1].body).toBe(JSON.stringify(opaque));
}));

test("source authentication still rejects a different bearer before selected-account inference", () => fixture(async f => {
  const response = await f.request(undefined, { authorization: `Bearer ${f.accounts[1].token}` });
  expect(response.status).toBe(400); await response.text(); expect(f.sent).toHaveLength(0);
}));

test("partial streamed quota failure is not replayed or sent to another account", () => fixture(async f => {
  f.serve(async () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"usage_limit_exceeded","message":"limit"}}}\n\n', { headers: { "content-type": "text/event-stream" } }));
  const response = await f.request(); await response.text(); expect(f.sent).toHaveLength(1); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));

test("a foreign binding keeps its own opaque compaction on that account without replay", () => fixture(async f => {
  await (await f.request()).text();
  const compact = { model, input: [{ type: "compaction", encrypted_content: "target-cache" }] };
  const response = await f.request(compact); expect(response.status).toBe(200); await response.text();
  expect(f.sent).toHaveLength(2); expect(f.sent[1].headers.get("chatgpt-account-id")).toBe("b");
  expect(JSON.parse(f.sent[1].body).input).toEqual(compact.input);
  f.accounts[1].row.windows[0].remainingPercent = 0; f.accounts[0].row.windows[0].remainingPercent = 80;
  for (const a of f.accounts) a.row.windows[0].observedAtMs = Date.now() - 1;
  f.publish();
  const blocked = await f.request(compact); expect(blocked.status).toBe(409); await blocked.text(); expect(f.sent).toHaveLength(2);
}));

test("a target 429 is attributed only to that account and does not hold the source after its recovery", () => fixture(async f => {
  f.serve(async () => new Response("quota", { status: 429, headers: { "retry-after": "60" } }));
  const failure = await f.request(); expect(failure.status).toBe(429); await failure.text(); expect(f.sent).toHaveLength(1);
  f.accounts[0].row.windows[0].remainingPercent = 80; f.accounts[0].row.windows[0].observedAtMs = Date.now(); f.publish();
  f.serve(async () => complete());
  const next = await f.request(); expect(next.status).toBe(200); await next.text();
  expect(f.sent).toHaveLength(2); expect(f.sent[1].headers.get("chatgpt-account-id")).toBe("a");
}));


test("ephemeral portable helpers retain native source behavior when lineage cannot authorize routing", () => fixture(async f => {
  const response = await f.request(undefined, { session_id: randomUUID() });
  expect(response.status).toBe(200); await response.text(); expect(f.sent).toHaveLength(1);
  expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("a");
  expect(f.runtime.snapshot().recent.at(-1).accountRouting).toBeUndefined();
}));


for (const failAt of [1, 3]) test(`unsent target guard denial ${failAt} restores prior ownership`, () => fixture(async f => {
  const identity = createHash("sha256").update(JSON.stringify([realpathSync(f.accounts[1].home), "b", "b"])).digest("hex");
  let checks = 0;
  f.memory.poolGuards.set("b:" + identity, { intervalMs: 500,
    check: () => ({ ready: ++checks < failAt, reason: "quota-exhausted", sourceIdentity: identity }),
    checkIdentity: () => ({ ready: true, sourceIdentity: identity }) });
  const denied = await f.request(); expect(denied.status).toBeGreaterThanOrEqual(400); await denied.text(); expect(f.sent).toHaveLength(0);
  const db = new Database(join(f.data, "account-pool.sqlite3"), { readonly: true });
  expect(db.query("SELECT count(*) AS n FROM bindings").get()).toMatchObject({ n: 0 }); db.close();
  f.policy.enabled = false; f.publish();
  const opaque = await f.request({ model, input: [{ type: "compaction", encrypted_content: "source-cache" }] });
  expect(opaque.status).toBe(200); await opaque.text(); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("a");
}));

test("source-guard-known bearer remains valid when pool starts after a native token refresh", () => fixture(async f => {
  const account = f.accounts[0], old = account.token;
  const token = `test.${Buffer.from(JSON.stringify({ sub: "a", exp: (Date.now() + 7200000) / 1000 })).toString("base64url")}.test`;
  const path = join(account.home, "auth.json");
  writeFileSync(path, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "a", access_token: token } }));
  utimesSync(path, (Date.now() - 5000) / 1000, (Date.now() - 5000) / 1000);
  const response = await f.request(undefined, { authorization: `Bearer ${old}` });
  expect(response.status).toBe(200); await response.text(); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));


test("disabled pool never forwards a proven foreign opaque binding back to the source, even with its store locked", () => fixture(async f => {
  await (await f.request()).text();
  f.policy.enabled = false; f.publish();
  const opaque = { model, input: [{ type: "compaction", encrypted_content: "target-cache" }] };
  let blocked = await f.request(opaque); expect(blocked.status).toBe(400); await blocked.text(); expect(f.sent).toHaveLength(1);
  const lock = new Database(join(f.data, "account-pool.sqlite3")); lock.exec("BEGIN EXCLUSIVE");
  try {
    blocked = await f.request(opaque); expect(blocked.status).toBe(400); await blocked.text(); expect(f.sent).toHaveLength(1);
  } finally { lock.exec("ROLLBACK"); lock.close(); }
}));

test("disabled pool leaves source interactive quota uncertainty advisory", () => fixture(async f => {
  f.policy.enabled = false; f.accounts[0].row.windows[0].metadata = { ordinaryUsageAllowed: null }; f.publish();
  const response = await f.request(); expect(response.status).toBe(200); await response.text(); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("a");
}));
