import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AccountPool, type PoolAccount } from "../src/account-pool";
import { portableReplay } from "../src/account-replay";
import { startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";

const model = "gpt-6-astra", now = Date.now();
const body = { model, stream: true, input: [
  { role: "user", content: "Continue the saved work" },
  { type: "reasoning", id: "r1", encrypted_content: "old-account-cache" },
  { type: "function_call", id: "fc1", call_id: "c1", name: "read_file", arguments: "{}" },
  { type: "function_call_output", call_id: "c1", output: "saved file" },
  { role: "assistant", id: "m1", content: [{ type: "output_text", text: "I read it" }] },
  { role: "user", content: "Keep going" },
] };
const firstBody = { model, input: [{ role: "user", content: "Start" }] };
function setup() {
  const accounts = ["source", "other"].map((id, i): PoolAccount => ({ id, label: id,
    identity: id, accessToken: id, upstreamAccount: id, tokenExpiresAt: now + 3600_000,
    models: [model], remaining: i ? 80 : 25, validUntil: now + 600_000 }));
  const pool = new AccountPool({ path: ":memory:", sourceAccount: "source", accounts: () => accounts,
    policy: () => ({ enabled: true, accounts: ["source", "other"] }) });
  const headers = new Headers({ authorization: "Bearer source", "chatgpt-account-id": "source" });
  const select = (threadId: string, input: unknown = firstBody) => pool.select({
    threadId, requestId: randomUUID(), body: input, model, headers })!;
  return { accounts, pool, headers, select };
}
const done = () => new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  { headers: { "content-type": "text/event-stream" } });

test("healthy login is preferred even if another account has more quota", () => {
  const c = setup();
  try { expect(c.select(randomUUID()).route.account).toBe("source"); }
  finally { c.pool.close(); }
});

test("account transfer preserves messages and tool pairs, filters only foreign reasoning on later requests", () => {
  const c = setup(), thread = randomUUID();
  try {
    c.select(thread); c.accounts[0]!.remaining = 0;
    const recovered = c.select(thread, body);
    expect(recovered.route).toMatchObject({ account: "other", reason: "recovered", previousAccountLabel: "source" });
    const input = (recovered.body as any).input;
    expect(input).toHaveLength(5);
    expect(input[1]).toEqual({ type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" });
    expect(input[2].output).toBe("saved file");
    const next = c.select(thread, { ...body, input: [...body.input,
      { type: "reasoning", encrypted_content: "new-account-cache" }] });
    expect(JSON.stringify(next.body)).not.toContain("old-account-cache");
    expect(JSON.stringify(next.body)).toContain("new-account-cache");
    expect(JSON.stringify(next.body)).not.toContain('"id":"m1"');
    expect(JSON.stringify(body)).toContain("old-account-cache");
  } finally { c.pool.close(); }
});

test("opaque history, uploaded files and incomplete tool pairs are not migrated", () => {
  for (const input of [
    { ...body, previous_response_id: "remote" }, { ...body, conversation: "remote" },
    { ...body, input: [...body.input, { type: "compaction", encrypted_content: "summary" }] },
    { ...body, input: [{ role: "user", content: [{ type: "input_file", file_id: "private" }] }] },
    { ...body, input: body.input.filter(i => i.type !== "function_call_output") },
    { ...body, input: body.input.filter(i => i.type !== "function_call") },
  ]) expect(portableReplay(input)).toBeNull();
  const c = setup(), thread = randomUUID();
  try {
    const selected = c.select(thread);
    c.pool.response("id", selected.identity, 429, "60");
    expect(() => c.select(thread, { ...body, previous_response_id: "remote" })).toThrow("pool_recovery_requires_full_history");
  } finally { c.pool.close(); }
});

test("a verified manual login change releases the old binding", () => {
  const c = setup(), threadId = randomUUID();
  try {
    c.select(threadId);
    Object.assign(c.accounts[0]!, { identity: "new-login", accessToken: "new-token", upstreamAccount: "new-login" });
    const headers = new Headers({ authorization: "Bearer new-token", "chatgpt-account-id": "new-login" });
    const request = { threadId, requestId: randomUUID(), body, model, headers };
    expect(c.pool.select(request)?.route).toMatchObject({ account: "source", reason: "recovered" });
    expect(c.pool.select({ ...request, requestId: randomUUID() })?.route.reason).toBe("pinned");
    expect(() => c.select(threadId)).toThrow("pool_source_identity_mismatch");
  } finally { c.pool.close(); }
});

test("an HTTP 429 is retried once with full history and the replacement account", async () => {
  const c = setup(), events: CompactionRequestEvent[] = [], received: any[] = [];
  const proxy = startCompactionProxy({ accountPool: c.pool, onRequest: e => events.push(e),
    taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" },
    fetchUpstream: async (_, init) => {
      received.push({ account: new Headers(init.headers).get("chatgpt-account-id"), body: JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array)) });
      return received.length === 1 ? new Response("rate limited", { status: 429 }) : done();
    } });
  try {
    const headers = new Headers(c.headers); headers.set("session_id", randomUUID());
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers, body: JSON.stringify(body) });
    expect(response.status).toBe(200); await response.text();
    expect(received.map(r => r.account)).toEqual(["source", "other"]);
    expect(received[1].body.input).toEqual(portableReplay(body)!.body.input);
    expect(events.at(-1)).toMatchObject({ phase: "completed", retryCount: 1, accountRouting: { reason: "recovered" } });
    const health = await (await fetch(proxy.baseUrl + "/quotapie-health")).json() as any;
    expect(health.activeRequests).toBe(0); expect(health.active).toHaveLength(0);
  } finally { proxy.stop(); c.pool.close(); }
});

test("two rejected accounts return the second 429 without looping", async () => {
  const c = setup(); let calls = 0;
  const proxy = startCompactionProxy({ accountPool: c.pool, fetchUpstream: async () => {
    calls++; return new Response("rate limited", { status: 429 });
  } });
  try {
    const headers = new Headers(c.headers); headers.set("session_id", randomUUID());
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers, body: JSON.stringify(firstBody) });
    expect(response.status).toBe(429); await response.text(); expect(calls).toBe(2);
  } finally { proxy.stop(); c.pool.close(); }
});
