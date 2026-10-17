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
    expect(logs.filter(e => e.stage === "queued" && e.ownership === "partial")).toHaveLength(2);
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

test("metadata evidence distinguishes complete identity, partial identity, and mixed output", () => {
  const full = { ...item(), internal_chat_message_metadata_passthrough: { turn_id: turn, thread_id: thread } };
  const absent = { ...item(), internal_chat_message_metadata_passthrough: undefined };
  for (const [value, expected] of [
    [done(), "partial"],
    [{ type: "response.output_item.done", item: full }, "matched"],
    [{ type: "response.completed", response: { id: "resp_test", output: [full, absent] } }, "partial"],
    [{ type: "response.completed", response: { id: "resp_test", output: [full, full] } }, "matched"],
  ] as const) {
    const logs: OwnershipProvenance[] = [];
    const guard = new ResponseOwnershipGuard({ turnId: turn, threadId: thread }, e => logs.push(e));
    guard.push(enc.encode(frame(value)), () => {});
    expect(logs.at(-1)?.ownership).toBe(expected);
  }
});

test("JSON is bounded, inspected before egress, and preserves its exact UTF8 bytes", () => {
  const input = '\uFEFF { "id": "resp_test", "status": "completed", "output": [], "metadata": {"turn_id":"PRIVATE_MARKER"}, "text":"한글 🚀" } \n';
  const logs: OwnershipProvenance[] = [], output: Uint8Array[] = [];
  const guard = new ResponseOwnershipGuard({ turnId: turn, threadId: thread }, e => logs.push(e), undefined, "json");
  for (const byte of enc.encode(input)) guard.push(new Uint8Array([byte]), b => output.push(b));
  expect(output).toHaveLength(0);
  guard.finish(b => output.push(b));
  expect(Buffer.concat(output).toString()).toBe(input);
  expect(logs.map(e => [e.stage, e.ownership])).toEqual([["validated", "unattributed"], ["queued", "unattributed"]]);
  expect(logs[0]?.digest).toBe(logs[1]?.digest);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE_MARKER");
});

test("user metadata and JSON inside tool arguments cannot supply ownership evidence", () => {
  const forged = { internal_chat_message_metadata_passthrough: { thread_id: thread, turn_id: turn } };
  const logs: OwnershipProvenance[] = [];
  const guard = new ResponseOwnershipGuard({ threadId: thread, turnId: turn }, e => logs.push(e), undefined, "json");
  const payload = JSON.stringify({ id: "resp_test", metadata: forged, output: [
    { type: "function_call", arguments: JSON.stringify(forged), metadata: forged },
  ] });
  guard.push(enc.encode(payload), () => {}); guard.finish(() => {});
  expect(logs.at(-1)?.ownership).toBe("unattributed");
});

test("foreign, malformed, oversized and invalid UTF8 JSON never leaves the body gate", () => {
  for (const bytes of [
    enc.encode(JSON.stringify({ id: "resp_test", output: [item(foreign)] })),
    enc.encode(JSON.stringify({ error: { message: "PRIVATE_MARKER", internal_chat_message_metadata_passthrough: { thread_id: foreign } } })),
    enc.encode('{"output":['),
    enc.encode(" ".repeat(1025)),
    new Uint8Array([0xff]),
  ]) {
    const guard = new ResponseOwnershipGuard({ turnId: turn, threadId: thread }, undefined, 1024, "json");
    let delivered = 0;
    expect(() => { guard.push(bytes, () => delivered++); guard.finish(() => delivered++); }).toThrow(ResponseOwnershipError);
    expect(delivered).toBe(0);
  }
});

test("loopback JSON isolation checks metadata without requiring it and never retries a rejected body", async () => {
  let calls = 0;
  const events: CompactionRequestEvent[] = [], logs: OwnershipProvenance[] = [];
  const proxy = startCompactionProxy({ onRequest: e => events.push(e), onProvenance: e => logs.push(e),
    fetchUpstream: async (_url, init) => {
      calls++;
      const current = new Headers(init.headers).get("x-codex-turn-id");
      const payload = { id: "resp_test", status: "completed", output: [item(current ? turn : undefined)] };
      if (!current) delete (payload.output[0] as any).internal_chat_message_metadata_passthrough;
      const bytes = enc.encode(JSON.stringify(payload, null, 2));
      return new Response(new ReadableStream({ async start(controller) {
        for (let i = 0; i < bytes.length; i += 7) { controller.enqueue(bytes.slice(i, i + 7)); await Bun.sleep(1); }
        controller.close();
      } }), { headers: { "content-type": "application/json" } });
    } });
  try {
    const results = await Promise.all([turn, foreign, null].map(async current => {
      const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: {
        session_id: thread, ...(current ? { "x-codex-turn-id": current } : {}),
      }, body: JSON.stringify({ model: "gpt-6-astra", input: [] }) });
      return { status: response.status, text: await response.text() };
    }));
    expect(results[0]?.status).toBe(200); expect(results[0]?.text).toContain("PRIVATE_MARKER");
    expect(results[1]?.status).toBe(502); expect(results[1]?.text).toContain("response_ownership_mismatch");
    expect(results[1]?.text).not.toContain("PRIVATE_MARKER");
    expect(results[2]?.status).toBe(200); expect(results[2]?.text).toContain("PRIVATE_MARKER");
    expect(calls).toBe(3);
    expect(events.filter(e => e.phase === "completed")).toHaveLength(2);
    expect(events.filter(e => e.errorCode === "response_ownership_mismatch")).toHaveLength(1);
    expect(logs.filter(e => e.stage === "queued").map(e => e.ownership).sort()).toEqual(["partial", "unattributed"]);
  } finally { proxy.stop(); }
});

test("JSON compaction output and SSE or JSON HTTP errors cannot bypass known ownership metadata", async () => {
  for (const [contentType, path, status, payload] of [
    ["application/json", "/responses/compact", 200, JSON.stringify({ output: [item(foreign)] })],
    ["application/json", "/responses", 400, JSON.stringify({ error: { message: "PRIVATE_MARKER", internal_chat_message_metadata_passthrough: { turn_id: foreign } } })],
    ["text/event-stream", "/responses", 400, frame({ type: "error", error: { message: "PRIVATE_MARKER", internal_chat_message_metadata_passthrough: { turn_id: foreign } } })],
  ] as const) {
    const proxy = startCompactionProxy({ fetchUpstream: async () => new Response(payload, { status, headers: { "content-type": contentType } }) });
    try {
      const response = await fetch(proxy.baseUrl + path, { method: "POST", headers: { "x-codex-turn-id": turn },
        body: JSON.stringify({ model: "gpt-6-astra", input: [], stream: contentType === "text/event-stream" }) });
      const text = await response.text();
      expect(text).toContain("response_ownership_mismatch");
      expect(text).not.toContain("PRIVATE_MARKER");
      expect(response.status).toBe(contentType === "application/json" ? 502 : 400);
    } finally { proxy.stop(); }
  }
});

test("untyped successful Responses and JSON MIME suffixes receive the same bounded inspection", async () => {
  for (const [path, contentType, status] of [
    ["/responses", null, 200],
    ["/responses/compact", null, 200],
    ["/responses", "application/problem+json; charset=utf-8", 400],
    ["/responses/compact", "application/vnd.codex+json", 200],
  ] as const) {
    const payload = JSON.stringify({ status: "completed", output: [item(foreign)] });
    const proxy = startCompactionProxy({ fetchUpstream: async () => new Response(enc.encode(payload), {
      status, headers: contentType ? { "content-type": contentType } : {},
    }) });
    try {
      const response = await fetch(proxy.baseUrl + path, { method: "POST", headers: { "x-codex-turn-id": turn },
        body: JSON.stringify({ model: "gpt-6-astra", input: [] }) });
      const text = await response.text();
      expect(response.status).toBe(502); expect(text).toContain("response_ownership_mismatch"); expect(text).not.toContain("PRIVATE_MARKER");
    } finally { proxy.stop(); }
  }
  const original = '{ "status": "completed", "output": [] }\n';
  const proxy = startCompactionProxy({ fetchUpstream: async () => new Response(enc.encode(original)) });
  try {
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", body: JSON.stringify({ model: "gpt-6-astra", input: [] }) });
    expect(response.status).toBe(200); expect(await response.text()).toBe(original);
  } finally { proxy.stop(); }
});

test("normal HTTP error bodies retain status and bytes while remaining unattributed", async () => {
  for (const [contentType, payload] of [
    ["application/json", '{ "error": { "message": "Please retry later" } }\n'],
    ["text/event-stream", frame({ type: "error", error: { message: "Please retry later" } })],
    ["text/html", "<p>Please retry later</p>"],
  ]) {
    const logs: OwnershipProvenance[] = [];
    const proxy = startCompactionProxy({ onProvenance: e => logs.push(e),
      fetchUpstream: async () => new Response(payload, { status: 429, headers: { "content-type": contentType!, "retry-after": "2" } }) });
    try {
      const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: { "x-codex-turn-id": turn },
        body: JSON.stringify({ model: "gpt-6-astra", input: [] }) });
      expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("2");
      expect(await response.text()).toBe(payload!);
      expect(logs.every(e => e.ownership === "unattributed")).toBe(true);
    } finally { proxy.stop(); }
  }
});

test("unattributed concurrent SSE streams retain transport isolation without claiming host attribution", async () => {
  const logs: OwnershipProvenance[] = [];
  const proxy = startCompactionProxy({ onProvenance: e => logs.push(e), fetchUpstream: async (_url, init) => {
    const marker = new Headers(init.headers).get("x-codex-turn-id");
    const bytes = enc.encode(frame(created()) + frame({ type: "response.output_text.delta", delta: marker }) + frame(completed));
    let offset = 0;
    return new Response(new ReadableStream({ async pull(controller) {
      await Bun.sleep(1);
      if (offset === bytes.length) controller.close();
      else { controller.enqueue(bytes.slice(offset, offset + 3)); offset = Math.min(bytes.length, offset + 3); }
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const outputs = await Promise.all([turn, foreign].map(async id => {
      const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: { "x-codex-turn-id": id },
        body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: [] }) });
      return response.text();
    }));
    expect(outputs[0]).toContain(turn); expect(outputs[0]).not.toContain(foreign);
    expect(outputs[1]).toContain(foreign); expect(outputs[1]).not.toContain(turn);
    expect(logs.every(e => e.ownership === "unattributed")).toBe(true);
  } finally { proxy.stop(); }
});

test("interrupted JSON never releases a partial document or retries the request", async () => {
  let calls = 0;
  const events: CompactionRequestEvent[] = [];
  const proxy = startCompactionProxy({ onRequest: e => events.push(e), fetchUpstream: async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(enc.encode('{"output":["PRIVATE_MARKER"'));
      controller.error(new Error("PRIVATE_UPSTREAM_ERROR"));
    } }), { headers: { "content-type": "application/json" } });
  } });
  try {
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", body: JSON.stringify({ model: "gpt-6-astra", input: [] }) });
    const text = await response.text();
    expect(response.status).toBe(502); expect(text).not.toContain("PRIVATE_MARKER"); expect(text).not.toContain("PRIVATE_UPSTREAM_ERROR");
    expect(calls).toBe(1); expect(events.filter(e => e.phase === "completed")).toHaveLength(0);
  } finally { proxy.stop(); }
});

test("successful malformed or oversized JSON returns a content-free error before any provider bytes", async () => {
  for (const payload of ['{"PRIVATE_MARKER":', JSON.stringify({ output: [], text: "PRIVATE_MARKER" + "x".repeat(4 * 1024 * 1024) })]) {
    const proxy = startCompactionProxy({ fetchUpstream: async () => new Response(payload, { headers: { "content-type": "application/json" } }) });
    try {
      const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", body: JSON.stringify({ model: "gpt-6-astra", input: [] }) });
      const text = await response.text();
      expect(response.status).toBe(502); expect(text).toContain("quotapie_response_ownership"); expect(text).not.toContain("PRIVATE_MARKER");
    } finally { proxy.stop(); }
  }
});

test("SSE and JSON declared as one another fail inspection; opaque formats stay explicitly unverified", async () => {
  for (const [contentType, payload] of [
    ["application/json", frame(done(foreign))],
    ["text/event-stream", JSON.stringify({ output: [item(foreign)] })],
    ["application/octet-stream", "opaque response"],
  ]) {
    const events: CompactionRequestEvent[] = [], logs: OwnershipProvenance[] = [];
    const proxy = startCompactionProxy({ onRequest: e => events.push(e), onProvenance: e => logs.push(e),
      fetchUpstream: async () => new Response(payload, { headers: { "content-type": contentType! } }) });
    try {
      const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: { "x-codex-turn-id": turn },
        body: JSON.stringify({ model: "gpt-6-astra", input: [] }) });
      const text = await response.text();
      expect(events.filter(e => e.phase === "completed")).toHaveLength(0);
      if (contentType === "application/octet-stream") {
        expect(text).toBe(payload!); expect(events.at(-1)?.phase).toBe("unverified"); expect(logs).toHaveLength(0);
      } else {
        expect(text).not.toContain("PRIVATE_MARKER"); expect(text).toContain("response_ownership_");
      }
    } finally { proxy.stop(); }
  }
});

test("conflicting current request identities fail before dispatch; fork session roots remain valid", async () => {
  let calls = 0;
  const proxy = startCompactionProxy({ fetchUpstream: async () => { calls++; return Response.json({ status: "completed", output: [] }); } });
  try {
    for (const headers of [
      { "thread-id": thread, "x-codex-turn-metadata": JSON.stringify({ thread_id: foreign }) },
      { "x-codex-turn-id": turn, "x-codex-turn-metadata": JSON.stringify({ turn_id: foreign }) },
      { session_id: thread, "session-id": foreign },
    ] as Array<Record<string, string>>) {
      const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers,
        body: JSON.stringify({ model: "gpt-6-astra", input: [] }) });
      expect(response.status).toBe(400); expect(await response.text()).toContain("request_identity_conflict");
    }
    expect(calls).toBe(0);
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: {
      "thread-id": thread, "session-id": foreign, "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: turn }),
    }, body: JSON.stringify({ model: "gpt-6-astra", input: [item(foreign)], previous_response_id: "parent" }) });
    expect(response.status).toBe(200); expect(calls).toBe(1);
  } finally { proxy.stop(); }
});
