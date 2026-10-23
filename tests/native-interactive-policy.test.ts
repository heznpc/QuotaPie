import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../src/config";
import { createSubscriptionGuard, subscriptionGuardMemory } from "../src/subscription-guard";
import { createCompactionHandler, startCompactionProxy } from "../src/codex-compaction";
import { createSourceHistoryGuard } from "../src/source-history-guard";
import { NativeResponseOwnershipGuard } from "../src/codex-response-ownership";
import { inspectNativeBody } from "../src/native-request";
import { interactiveRelayPolicy } from "../src/interactive-relay-policy";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qp-native-policy-"));
  let now = Date.now(), reserve = 0, policyBroken = false;
  const token = (sub: string, expiry = now + 3600_000, nonce = "token") => `fixture.${Buffer.from(JSON.stringify({ sub, exp: expiry / 1000, nonce })).toString("base64url")}.fixture`;
  const auth = { auth_mode: "chatgpt", tokens: { account_id: "source-workspace", access_token: token("source-person") } };
  const writeAuth = () => writeFileSync(join(root, "auth.json"), JSON.stringify(auth)); writeAuth();
  const config = structuredClone(DEFAULT_CONFIG); config.accounts.codex = [{ id: "source", label: "Source", enabled: true, codexHome: root }];
  const memory = subscriptionGuardMemory();
  const options = { codexHome: root, sourceAccount: "source", config: () => config, memory,
    boundaryPath: join(root, "missing-boundary.json"), now: () => now, intervalMs: 10,
    executionMode: "interactive" as const,
    poolPolicy: () => { if (policyBroken) throw new Error("broken policy"); return { enabled: true, accounts: ["source"], reservePercent: { source: reserve } }; } };
  const guard = createSubscriptionGuard(options);
  const headers = () => new Headers({ authorization: `Bearer ${auth.tokens.access_token}`, "chatgpt-account-id": auth.tokens.account_id });
  const historyPath = join(root, "pool.sqlite");
  const history = createSourceHistoryGuard({ path: historyPath, forkParent: async () => ({ status: "unknown" }) });
  const calls: { url: string; headers: Headers; bytes: Uint8Array; method: string }[] = [];
  let upstreamStatus = 200, location: string | undefined;
  const handler = createCompactionHandler({ executionMode: "interactive", subscriptionGuard: guard, sourceHistoryGuard: history,
    route: { from: "gpt-6-astra", to: "gpt-6-astra" }, taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" },
    fetchUpstream: async (url, init) => {
      calls.push({ url, headers: new Headers(init.headers), bytes: new Uint8Array(await new Response(init.body).arrayBuffer()), method: init.method! });
      return new Response(init.method === "HEAD" || upstreamStatus === 204 ? null : "native-result", { status: upstreamStatus,
        headers: location ? { location } : {} });
    } });
  const request = (path: string, method = "POST", body?: BodyInit, extra?: Headers) => handler.fetch(new Request(`http://127.0.0.1${handler.prefix}${path}`, {
    method, headers: extra ?? headers(), ...(body === undefined ? {} : { body }) }));
  return { root, auth, config, token, writeAuth, guard, memory, options, headers, calls, handler, request, historyPath, history,
    reserve(n: number) { reserve = n; }, breakPolicy() { policyBroken = true; }, advance(n: number) { now += n; },
    status(n: number, redirect?: string) { upstreamStatus = n; location = redirect; }, close() { rmSync(root, { recursive: true, force: true }); } };
}

test("production interactive policy accepts native methods, future routes and bodies on one fixed source", async () => {
  const f = fixture();
  try {
    const cases: [string, string, BodyInit | undefined][] = [
      ["GET", "/responses/native-id.v2?cursor=example%2Fnext", undefined],
      ["HEAD", "/files/abc.bin", undefined], ["DELETE", "/files/abc.bin", undefined],
      ["PUT", "/files/upload%2Fpart", new Uint8Array([0, 255, 1, 2])],
      ["PATCH", "/future-native/setting", '{"anything":true}'], ["OPTIONS", "/future-native/setting", undefined],
      ["POST", "/alpha/search", '{"search_query":[{"q":"fixture"}]}'],
      ["POST", "/audio/transcriptions", new Uint8Array([0, 1, 255])],
      ["POST", "/images/edits", "--multipart-boundary\r\nfixture\r\n"],
      ["POST", "/future-native/unknown-feature.v3", "new-wire-format"],
      ["POST", "/responses", '{"model":"future-model-v9","background":true,"input":"native"}'],
      ["POST", "/responses/compact", '{"model":"future-model-v9","input":[],"new_field":true}'],
      ["POST", "/responses", "opaque/new-protocol"], ["POST", "/responses", "[]"],
    ];
    for (const [method, path, body] of cases) {
      const r = await f.request(path, method, body); expect(r.status).toBe(200); await r.text();
      const sent = f.calls.at(-1)!;
      expect(sent.url).toBe("https://chatgpt.com/backend-api/codex" + path); expect(sent.method).toBe(method);
      expect(sent.bytes).toEqual(new Uint8Array(await new Response(body).arrayBuffer()));
      expect(sent.headers.get("authorization")).toBe(f.headers().get("authorization"));
      expect(sent.headers.get("chatgpt-account-id")).toBe("source-workspace");
    }
    expect(f.calls.length).toBe(cases.length);
    expect(f.handler.snapshot().recentNativeRequests.length).toBe(cases.length);
    const diagnostics = JSON.stringify(f.handler.snapshot().recentNativeRequests);
    expect(diagnostics).not.toContain("cursor"); expect(diagnostics).not.toContain(f.auth.tokens.access_token);
    expect(diagnostics).not.toContain("native-id");
    const withoutAccount = f.headers(); withoutAccount.delete("chatgpt-account-id");
    const r = await f.request("/future-native", "POST", "native", withoutAccount);
    expect(r.status).toBe(200); await r.text();
    expect(f.calls.at(-1)!.headers.get("chatgpt-account-id")).toBe("source-workspace");
    expect(JSON.stringify(f.handler.snapshot())).not.toContain(f.guard.check().sourceIdentity!);
  } finally { f.close(); }
});

test("native admission does not invent quota, model, token-expiry or provider-error holds", async () => {
  const f = fixture();
  try {
    expect(f.guard.check({ model: "unreleased-model" })).toMatchObject({ ready: true, enforcement: "source-identity" });
    for (const status of [402, 429, 500, 400, 200]) {
      f.status(status); const r = await f.request("/responses", "POST", '{"model":"unreleased-model","input":[]}');
      expect(r.status).toBe(status); expect(await r.text()).toBe("native-result");
      expect(f.guard.check().ready).toBe(true);
    }
    f.memory.deniedAtMs = Date.now(); // A retained hold from an older live handler is not enrollment.
    expect(createSubscriptionGuard(f.options).check().ready).toBe(true);
    f.advance(7200_000); // Let the provider handle expiry and perform its normal login recovery.
    expect((await f.request("/models", "GET")).status).toBe(200);
    const r = await f.request("/responses", "POST", '{"model":"future-model"}'); expect(r.status).toBe(200); await r.text();
    f.breakPolicy(); expect(f.guard.check()).toMatchObject({ ready: true, policyObservationReason: "policy-unavailable" });
  } finally { f.close(); }
});

test("explicit reserve still opts into local limits, including during a native tool request", async () => {
  const f = fixture();
  try {
    f.reserve(25);
    expect(f.guard.check()).toMatchObject({ ready: false, enforcement: "explicit-reserve" });
    const response = await f.request("/future-feature", "POST", "bytes"); expect(response.status).toBe(400); await response.text();
    expect(f.calls).toHaveLength(0);
    f.breakPolicy(); expect(f.guard.check().ready).toBe(false); // previously selected cutoff survives a broken file
  } finally { f.close(); }
});

test("same-login refresh passes both interactive authentication and optional historical checks", async () => {
  const f = fixture();
  try {
    const previous = f.headers(); previous.set("thread-id", randomUUID());
    for (let i = 0; i < 10; i++) {
      f.auth.tokens.access_token = f.token("source-person", Date.now() + 3600_000, String(i)); f.writeAuth();
      expect(f.guard.check().ready).toBe(true);
    }
    const r = await f.request("/responses", "POST", '{"model":"future-model","input":[]}', previous);
    expect(r.status).toBe(200); await r.text();
    expect(f.calls[0]!.headers.get("authorization")).toBe(previous.get("authorization"));
    f.advance(7200_000);
    const expired = await f.request("/responses", "POST", '{"model":"future-model"}', previous);
    expect(expired.status).toBe(200); await expired.text(); // Provider owns expiry after an observed refresh too.
    const wrong = f.headers(); wrong.set("authorization", "Bearer unobserved");
    expect((await f.request("/future-feature", "POST", "native", wrong)).status).toBe(400);
    const workspace = f.headers(); workspace.set("chatgpt-account-id", "foreign-workspace");
    expect((await f.request("/future-feature", "POST", "native", workspace)).status).toBe(400);
    f.auth.tokens.access_token = f.token("different-person"); f.writeAuth();
    expect((await f.request("/future-feature", "POST", "native")).status).toBe(400);
    expect(f.calls).toHaveLength(2);
  } finally { f.close(); }
});

test("optional historical storage cannot block the source; an actual foreign binding still vetoes", async () => {
  const f = fixture(), child = randomUUID();
  const headers = f.headers(); headers.set("thread-id", child);
  try {
    for (const data of [undefined, "broken database"]) {
      if (data) writeFileSync(f.historyPath, data);
      const r = await f.request("/responses", "POST", '{"model":"future-model","input":[]}', headers);
      expect(r.status).toBe(200); await r.text();
    }
    rmSync(f.historyPath); const db = new Database(f.historyPath);
    try {
      expect(await f.history({ account: "source", identity: f.guard.check().sourceIdentity!, headers })).toBe("unavailable");
      db.run("CREATE TABLE bindings(source TEXT,thread TEXT,account TEXT,identity TEXT,source_identity TEXT)");
      db.run("BEGIN EXCLUSIVE");
      expect(await f.history({ account: "source", identity: f.guard.check().sourceIdentity!, headers })).toBe("unavailable");
      db.run("ROLLBACK");
      db.query("INSERT INTO bindings VALUES (?,?,?,?,?)").run("source", child, "other", "other-identity", f.guard.check().sourceIdentity!);
      const r = await f.request("/responses", "POST", '{"model":"future-model"}', headers);
      expect(r.status).toBe(400); expect((await r.json() as any).error.code).toBe("subscription_pool_source_continuation_mismatch");
      expect(f.calls).toHaveLength(2);
    } finally { db.close(); }
  } finally { f.close(); }
});

test("model discovery is independent of conversation account bindings and quota holds", async () => {
  const f = fixture(), thread = randomUUID(), headers = f.headers(); headers.set("thread-id", thread);
  try {
    const db = new Database(f.historyPath);
    db.run("CREATE TABLE bindings(source TEXT,thread TEXT,account TEXT,identity TEXT,source_identity TEXT)");
    db.query("INSERT INTO bindings VALUES (?,?,?,?,?)").run("source", thread, "other", "other-identity", f.guard.check().sourceIdentity!);
    db.close();
    f.reserve(25);
    const models = await f.request("/models", "GET", undefined, headers);
    expect(models.status).toBe(200); await models.text();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.headers.get("authorization")).toBe(headers.get("authorization"));
    // Discovering models cannot authorize a continuation on the wrong login.
    const response = await f.request("/responses", "POST", '{"model":"future-model","input":[]}', headers);
    expect(response.status).toBe(400); await response.text();
    const invalid = new Headers(headers); invalid.set("authorization", "Bearer unknown");
    expect((await f.request("/models", "GET", undefined, invalid)).status).toBe(400);
    expect(f.calls).toHaveLength(1);
  } finally { f.close(); }
});

test("unknown native routes cannot change the destination, follow redirects or expose management endpoints", async () => {
  const f = fixture();
  try {
    for (const path of ["/quotapie-future", "/../../foreign", "/%2e%2e/%2e%2e/foreign", "//external.example/path"])
      expect((await f.request(path, "POST", "fixture")).status).toBeGreaterThanOrEqual(400);
    expect(f.calls).toHaveLength(0);
    f.status(302); const r = await f.request("/native-operation", "POST", "fixture");
    expect(r.status).toBe(302); await r.text(); expect(f.calls).toHaveLength(1);
    f.status(307, "https://chatgpt.com/backend-api/codex/future-route?cursor=next");
    const local = await f.request("/native-operation", "POST", "fixture");
    expect(local.status).toBe(307); expect(local.headers.get("location")).toBe(f.handler.prefix + "/future-route?cursor=next"); await local.text();
    f.status(307, "https://foreign.example/collect");
    const foreign = await f.request("/native-operation", "POST", "fixture"); expect(foreign.status).toBe(502); await foreign.text();
    expect(f.calls).toHaveLength(3); // No redirect is followed or replayed by the relay.
  } finally { f.close(); }
});

test("optional optimizers default off and invalid optimizer settings cannot reject native work", async () => {
  expect(interactiveRelayPolicy().taskSavings.enabled).toBe(false);
  const defaults = interactiveRelayPolicy(); expect(defaults.route.to).toBe(defaults.route.from);
  const invalid = interactiveRelayPolicy({ to: "new-unsupported-optimizer" }, { enabled: true, model: "unknown" });
  expect(invalid.unavailable).toHaveLength(2); expect(invalid.taskSavings.enabled).toBe(false);
  const f = fixture();
  try {
    const handler = createCompactionHandler({ executionMode: "interactive", subscriptionGuard: f.guard,
      route: { to: "unknown" } as any, taskSavings: { enabled: true, model: "unknown" } as any,
      fetchUpstream: async (_url, init) => new Response(init.body) });
    const body = '{"model":"future-model","input":[]}';
    const response = await handler.fetch(new Request("http://127.0.0.1" + handler.prefix + "/responses", { method: "POST", headers: f.headers(), body }));
    expect(response.status).toBe(200); expect(await response.text()).toBe(body);
    const failingOptimizer = createCompactionHandler({ executionMode: "interactive", subscriptionGuard: f.guard,
      taskSavings: { enabled: true, model: "gpt-5.6-luna", effort: "low" },
      savingsModelSupported: () => { throw new Error("catalog unavailable"); },
      fetchUpstream: async (_url, init) => new Response(init.body) });
    const headers = f.headers(); headers.set("thread-id", randomUUID());
    const original = JSON.stringify({ model: "gpt-6-astra", reasoning: { effort: "high" },
      input: [{ role: "user", content: [{ type: "input_text", text: "Fix this typo" }] }] });
    const fallback = await failingOptimizer.fetch(new Request("http://127.0.0.1" + failingOptimizer.prefix + "/responses", { method: "POST", headers, body: original }));
    expect(fallback.status).toBe(200); expect(await fallback.text()).toBe(original);
  } finally { f.close(); }
});

test("interactive listener streams uploads beyond the previous 64 MiB request cutoff", async () => {
  const f = fixture();
  let received = 0;
  const proxy = startCompactionProxy({ executionMode: "interactive", subscriptionGuard: f.guard,
    fetchUpstream: async (_url, init) => {
      const reader = new Response(init.body).body!.getReader();
      while (true) { const next = await reader.read(); if (next.done) break; received += next.value.length; }
      return new Response(null, { status: 204 });
    } });
  try {
    let remaining = 65;
    const body = new ReadableStream({ pull(controller) {
      if (remaining-- > 0) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close();
    } });
    const response = await fetch(proxy.baseUrl + "/files/upload", { method: "PUT", headers: f.headers(), body });
    expect(response.status).toBe(204); expect(received).toBe(65 * 1024 * 1024);
  } finally { proxy.stop(); f.close(); }
});

test("bounded native inspection preserves oversized and streaming payloads without a request cutoff", async () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 256);
  for (const knownLength of [true, false]) {
    const request = new Request("http://fixture/responses", { method: "POST",
      headers: knownLength ? { "content-length": String(bytes.length) } : {},
      body: new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 10) c.enqueue(bytes.slice(i, i + 10)); c.close(); } }) });
    const inspected = await inspectNativeBody(request, 32);
    expect(inspected.reason).toBe("body-too-large");
    expect(inspected.bytes).toBeUndefined(); expect(new Uint8Array(await new Response(inspected.body).arrayBuffer())).toEqual(bytes);
  }
});

test("native SSE forwards large/new/partial frames but retains explicit foreign-response rejection", () => {
  const child = randomUUID(), root = randomUUID();
  for (const text of ["data: new native text\n\n", "data: {\"type\":\"native.event\"}",
    'data: {"large":"' + "x".repeat(4 * 1024 * 1024) + '"}\n\n',
    `data: ${JSON.stringify({ internal_chat_message_metadata_passthrough: { session_id: root, thread_id: child } })}\n\n`]) {
    const guard = new NativeResponseOwnershipGuard({ threadId: child, turnId: null, sessionId: root }); const out: Uint8Array[] = [];
    const bytes = new TextEncoder().encode(text);
    guard.push(bytes.slice(0, 12), b => out.push(b)); guard.push(bytes.slice(12), b => out.push(b)); guard.finish(b => out.push(b));
    expect(Buffer.concat(out)).toEqual(Buffer.from(bytes));
  }
  const guard = new NativeResponseOwnershipGuard({ threadId: child, turnId: null }); const out: Uint8Array[] = [];
  guard.push(new TextEncoder().encode("data: new native frame\n\n"), b => out.push(b)); out.length = 0;
  expect(() => guard.push(new TextEncoder().encode(`data: ${JSON.stringify({ internal_chat_message_metadata_passthrough: { thread_id: randomUUID() } })}\n\n`), b => out.push(b)))
    .toThrow("response_ownership_mismatch"); expect(out).toHaveLength(0);
});
