import { expect, test } from "bun:test";
import { ResponseOwnershipGuard, ResponseOwnershipError, type OwnershipProvenance } from "../src/codex-response-ownership";
import { startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";
const turn = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
const thread = "33333333-3333-4333-8333-333333333333";
const enc = new TextEncoder();
const frame = (value: unknown, eol = "\n") => `data: ${JSON.stringify(value)}${eol}${eol}`;
const item = (id: string | undefined = turn) => ({ type: "function_call", id: "fc_test", name: "exec_command", call_id: "call_test", arguments: '{"cmd":"PRIVATE_MARKER"}',
  ...(id ? { internal_chat_message_metadata_passthrough: { turn_id: id } } : {}) });
const done = (id = turn) => ({ type: "response.output_item.done", item: item(id) });
const created = (id = "resp_test") => ({ type: "response.created", response: { id, output: [] } });
const completed = { type: "response.completed", response: { id: "resp_test", status: "completed", output: [] } };

test("whole-event gate blocks foreign tool before egress, including every byte split", () => {
  const good = frame(created()); const bad = frame(done(foreign));
  for (let split = 0; split <= enc.encode(bad).length; split++) {
    const output: Uint8Array[] = []; const provenance: OwnershipProvenance[] = [];
    const guard = new ResponseOwnershipGuard({ turnId: turn, threadId: thread }, e => provenance.push(e));
    const deliver = (b: Uint8Array) => output.push(b);
    guard.push(enc.encode(good), deliver);
    const bytes = enc.encode(bad);
    expect(() => { guard.push(bytes.slice(0, split), deliver); guard.push(bytes.slice(split), deliver); }).toThrow(ResponseOwnershipError);
    expect(Buffer.concat(output).toString()).toBe(good);
    expect(provenance.at(-1)?.stage).toBe("blocked");
    expect(JSON.stringify(provenance)).not.toContain("PRIVATE_MARKER");
    expect(JSON.stringify(provenance)).not.toContain(foreign);
  }
});

test("normal tools and unattributed events pass byte-exact with fragmented UTF8 and SSE line endings", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    const input = '\uFEFF: keepalive' + eol + eol + frame(created(), eol) + frame(done(), eol) +
      frame({ type: "response.output_text.delta", delta: "한글 🚀" }, eol) + frame(completed, eol);
    const output: Uint8Array[] = [];
    const guard = new ResponseOwnershipGuard({ turnId: turn, threadId: thread });
    for (const byte of enc.encode(input)) guard.push(new Uint8Array([byte]), b => output.push(b));
    guard.finish(b => output.push(b));
    expect(Buffer.concat(output).toString()).toBe(input);
  }
});

test("metadata absent is unattributed; arbitrary text/root/previous IDs are not ownership", () => {
  const logs: OwnershipProvenance[] = [];
  const guard = new ResponseOwnershipGuard({ turnId: turn, threadId: thread }, e => logs.push(e));
  const value = { type: "response.output_item.done", item: { ...item(undefined), internal_chat_message_metadata_passthrough: { root_turn_id: foreign }, metadata: { turn_id: foreign } }, previous_response_id: "parent" };
  let count = 0; guard.push(enc.encode(frame(value)), () => count++);
  expect(count).toBe(1); expect(logs.at(-1)?.ownership).toBe("unattributed");
});

test("checks completion output, changed response IDs, and thread metadata before egress", () => {
  for (const bad of [
    { type: "response.completed", response: { id: "resp_test", output: [item(foreign)] } },
    created("resp_other"),
    { type: "response.output_item.done", response_id: "resp_other", item: item() },
    { type: "response.output_item.done", item: { ...item(), internal_chat_message_metadata_passthrough: { thread_id: foreign } } },
  ]) {
    const guard = new ResponseOwnershipGuard({ turnId: turn, threadId: thread }); let count = 0;
    guard.push(enc.encode(frame(created())), () => count++);
    expect(() => guard.push(enc.encode(frame(bad)), () => count++)).toThrow(ResponseOwnershipError);
    expect(count).toBe(1);
  }
});

test("malformed, oversized, truncated, invalid UTF8 frames cannot escape", () => {
  for (const bytes of [enc.encode("data: nope\n\n"), enc.encode("data: " + "x".repeat(100)), enc.encode(frame(done()).slice(0, -1)), new Uint8Array([100, 97, 116, 97, 58, 0xff, 10, 10])]) {
    const guard = new ResponseOwnershipGuard({ turnId: turn, threadId: thread }, undefined, 80); let count = 0;
    expect(() => { guard.push(bytes, () => count++); guard.finish(() => count++); }).toThrow(ResponseOwnershipError);
    expect(count).toBe(0);
  }
});

test("loopback relay isolates simultaneous fragmented streams, fails only contaminated request, never retries", async () => {
  let calls = 0; const events: CompactionRequestEvent[] = []; const provenance: unknown[] = [];
  const proxy = startCompactionProxy({ onRequest: e => events.push(e), onProvenance: e => provenance.push(e),
    fetchUpstream: async (_url, init) => {
      calls++; const id = new Headers(init.headers).get("x-codex-turn-id")!;
      const content = frame(created()) + frame(done(id === foreign ? turn : id)) + frame(completed);
      const bytes = enc.encode(content); let offset = 0;
      return new Response(new ReadableStream({ async pull(c) {
        await new Promise(r => setTimeout(r, 1));
        if (offset < bytes.length) { c.enqueue(bytes.slice(offset, offset + 7)); offset += 7; } else c.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const results = await Promise.all([turn, foreign, turn, turn].map(async id => {
      const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: { session_id: thread, "x-codex-turn-id": id }, body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: [] }) });
      const reader = response.body!.getReader(); let text = ""; let failed = false;
      try { while (true) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); } } catch { failed = true; }
      return { text, failed };
    }));
    expect(results[1]?.text).toContain("response_ownership_mismatch");
    expect(results[1]?.text).not.toContain("PRIVATE_MARKER");
    for (const i of [0, 2, 3]) { expect(results[i]?.failed).toBe(false); expect(results[i]?.text).toContain("PRIVATE_MARKER"); }
    expect(calls).toBe(4);
    expect(events.filter(e => e.errorCode === "response_ownership_mismatch")).toHaveLength(1);
    expect(events.filter(e => e.phase === "completed")).toHaveLength(3);
    expect(JSON.stringify(provenance)).not.toContain("PRIVATE_MARKER");
  } finally { proxy.stop(); }
});

test("current request metadata governs steering and forks; parent/history IDs never grant output ownership", async () => {
  const logs: OwnershipProvenance[] = [];
  const proxy = startCompactionProxy({ onProvenance: e => logs.push(e), fetchUpstream: async (_url, init) => {
    const meta = JSON.parse(new Headers(init.headers).get("x-codex-turn-metadata")!);
    return new Response(frame(created()) + frame(done(meta.turn_id)) + frame(completed)); // Native Lite omits Content-Type.
  } });
  try {
    for (const current of [turn, foreign]) {
      const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: current, root_turn_id: turn, parent_thread_id: foreign }),
      }, body: JSON.stringify({ model: "gpt-6-astra", stream: true, previous_response_id: "resp_parent", input: [item(turn)] }) });
      expect(await response.text()).toContain("PRIVATE_MARKER");
    }
    expect(logs.filter(e => e.stage === "blocked")).toHaveLength(0);
    expect(logs.filter(e => e.stage === "queued" && e.ownership === "matched")).toHaveLength(2);
  } finally { proxy.stop(); }
});

test("provenance pairs checked bytes with queued bytes and never grants ownership to missing metadata", () => {
  const logs: OwnershipProvenance[] = [];
  const guard = new ResponseOwnershipGuard({ turnId: turn, threadId: thread }, e => logs.push(e));
  const tool = item(); delete (tool as any).internal_chat_message_metadata_passthrough;
  const input = frame({ type: "response.output_item.done", item: tool });
  guard.push(enc.encode(input), () => {});
  expect(logs.map(e => e.stage)).toEqual(["validated", "queued"]);
  expect(logs[0]?.digest).toBe(logs[1]?.digest);
  expect(logs.every(e => e.ownership === "unattributed")).toBe(true);
  expect(logs[0]?.bytes).toBe(enc.encode(input).length);
  const incomplete = new ResponseOwnershipGuard({ turnId: turn, threadId: thread });
  let forwarded = 0;
  incomplete.push(enc.encode(frame(done()).slice(0, -1)), () => forwarded++);
  expect(() => incomplete.finish(() => forwarded++)).toThrow("response_ownership_truncated_event");
  expect(forwarded).toBe(0);
});
