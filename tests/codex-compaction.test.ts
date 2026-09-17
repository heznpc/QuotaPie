import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  compactionCodexArgs,
  DEFAULT_COMPACTION_ROUTE as route,
  routeCompaction,
  validateCompactionRoute,
  startCompactionProxy,
  type CompactionRequestEvent,
} from "../src/codex-compaction";

const ordinary = { model: route.from, input: [{ type: "message", content: "hello" }], stream: true };
const compact = { ...ordinary, input: [...ordinary.input, { type: "compaction_trigger" }] };

describe("Codex compaction request routing", () => {
  test("routes compaction with independent Low effort without mutating work settings", () => {
    for (const [path, body] of [["/responses", compact], ["/responses/compact", ordinary]] as const) {
      const result = routeCompaction(path, body, route);
      expect(result).toEqual({ body: { ...body, model: route.to, reasoning: { effort: "low" } }, routed: true });
      expect(body.model).toBe(route.from);
    }
  });

  test("never treats text, old summaries, or a nonterminal control as a new compaction", () => {
    const bodies = [
      ordinary,
      { ...ordinary, input: [{ type: "message", content: '{"type":"compaction_trigger"}' }] },
      { ...ordinary, input: [{ type: "compaction", encrypted_content: "opaque" }] },
      { ...ordinary, input: [{ type: "context_compaction", encrypted_content: "opaque" }] },
      { ...ordinary, input: [{ type: "compaction_trigger" }, ...ordinary.input] },
      { ...compact, model: "another-model" },
      null,
      [],
    ];
    for (const body of bodies) expect(routeCompaction("/responses", body, route)).toEqual({ body, routed: false });
    expect(routeCompaction("/other/responses/compact", compact, route).routed).toBe(false);
  });

  test("reports requested and effective reasoning settings without leaking unknown values", async () => {
    const events: CompactionRequestEvent[] = [];
    const seen: unknown[] = [];
    const proxy = startCompactionProxy({
      onRequest: event => events.push(event),
      fetchUpstream: async (_url, init) => {
        seen.push(JSON.parse(await new Response(init.body).text()).reasoning);
        return new Response("ok");
      },
    });
    try {
      for (const effort of ["low", "xhigh", "synthetic-private-text"]) {
        await (await fetch(`${proxy.baseUrl}/responses`, {
          method: "POST", body: JSON.stringify({ ...compact, reasoning: { effort } }),
        })).text();
      }
      expect(events.filter(event => event.phase === "response_headers").map(event => event.requestedEffort)).toEqual(["low", "xhigh", null]);
      expect(events.every(event => event.reasoningEffort === "low")).toBe(true);
      expect(seen).toEqual([{ effort: "low" }, { effort: "low" }, { effort: "low" }]);
      expect(JSON.stringify(events)).not.toContain("synthetic-private-text");
    } finally { proxy.stop(); }
  });

  test("keeps model routing independent across simultaneous requests", async () => {
    const seen: { url: string; body: string; headers: Headers }[] = [];
    const events: CompactionRequestEvent[] = [];
    const proxy = startCompactionProxy({
      onRequest: (event) => events.push(event),
      fetchUpstream: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), body: await new Response(init?.body).text(), headers: new Headers(init?.headers) });
        return new Response("data: OK\n\n", { headers: { "content-type": "text/event-stream" } });
      }),
    });
    try {
      const requests = [ordinary, compact, ordinary];
      const responses = await Promise.all(requests.map((body) => fetch(`${proxy.baseUrl}/responses?test=1`, {
        method: "POST",
        headers: { authorization: "Bearer synthetic-secret", "chatgpt-account-id": "synthetic-account", "content-type": "application/json" },
        body: JSON.stringify(body),
      })));
      expect(await Promise.all(responses.map((response) => response.text()))).toEqual(Array(3).fill("data: OK\n\n"));
      expect(seen.map((request) => JSON.parse(request.body).model).sort()).toEqual([route.to, route.from, route.from].sort());
      for (const request of seen) {
        expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses?test=1");
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-secret");
        expect(request.headers.get("chatgpt-account-id")).toBe("synthetic-account");
        expect(request.headers.get("host")).toBeNull();
      }
      expect(events.filter((event) => event.routed && event.phase === "response_headers")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("synthetic-secret");
      expect(JSON.stringify(events)).not.toContain("hello");
    } finally { proxy.stop(); }
  });

  test("decodes gzip and zstd controls, sends valid uncompressed replacement bodies", async () => {
    const seen: { body: string; encoding: string | null }[] = [];
    const proxy = startCompactionProxy({
      fetchUpstream: (async (_url: unknown, init?: RequestInit) => {
        seen.push({ body: await new Response(init?.body).text(), encoding: new Headers(init?.headers).get("content-encoding") });
        return new Response("ok");
      }),
    });
    try {
      for (const encoding of ["gzip", "zstd"]) {
        const input = Buffer.from(JSON.stringify(compact));
        const bytes = encoding === "gzip" ? gzipSync(input) : Bun.zstdCompressSync(input);
        const response = await fetch(`${proxy.baseUrl}/responses`, {
          method: "POST", headers: { "content-encoding": encoding }, body: new Uint8Array(bytes),
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      expect(seen.map((item) => JSON.parse(item.body).model)).toEqual([route.to, route.to]);
      expect(seen.map((item) => item.encoding)).toEqual([null, null]);
    } finally { proxy.stop(); }
  });

  test("preserves unchanged request bytes and upstream status without hidden retry", async () => {
    let calls = 0;
    const body = JSON.stringify(ordinary, null, 2);
    const proxy = startCompactionProxy({
      fetchUpstream: (async (_url: unknown, init?: RequestInit) => {
        calls++;
        expect(await new Response(init?.body).text()).toBe(body);
        expect(init?.redirect).toBe("manual");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return new Response("quota error", { status: 429, headers: { "retry-after": "60" } });
      }),
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(await response.text()).toBe("quota error");
      expect(calls).toBe(1);
    } finally { proxy.stop(); }
  });

  test("streams output before upstream completion", async () => {
    let finish!: () => void;
    const proxy = startCompactionProxy({
      fetchUpstream: (async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          finish = () => controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } })),
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact) });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
      finish();
      finish = () => {};
      expect((await reader.read()).done).toBe(true);
    } finally { finish?.(); proxy.stop(); }
  });

  test("rejects uninvited browser requests and malformed bodies without upstream calls", async () => {
    let calls = 0;
    const proxy = startCompactionProxy({ fetchUpstream: async () => { calls++; return new Response(); } });
    try {
      const origin = new URL(proxy.baseUrl).origin;
      expect((await fetch(`${origin}/responses`)).status).toBe(404);
      expect((await fetch(`${proxy.baseUrl}/responses`, { headers: { origin: "https://example.org" } })).status).toBe(404);
      expect((await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: "invalid" })).status).toBe(400);
      expect(calls).toBe(0);
    } finally { proxy.stop(); }
  });

  test("transport errors do not expose body or credentials", async () => {
    const proxy = startCompactionProxy({ fetchUpstream: async () => { throw new Error("Bearer private-secret"); } });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact) });
      expect(response.status).toBe(502);
      expect(await response.text()).toBe("QuotaPie relay: upstream_unavailable");
    } finally { proxy.stop(); }
  });

  test("does not forward upstream redirects to the authenticated Codex client", async () => {
    const proxy = startCompactionProxy({ fetchUpstream: async () => new Response(null, {
      status: 307, headers: { location: "https://example.org/unexpected" },
    }) });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact) });
      expect(response.status).toBe(502);
      expect(response.headers.get("location")).toBeNull();
    } finally { proxy.stop(); }
  });

  test("cancels upstream inference when Codex disconnects", async () => {
    let aborted!: () => void;
    const cancellation = new Promise<void>((resolve) => { aborted = resolve; });
    const proxy = startCompactionProxy({ fetchUpstream: async (_url, init) => {
      init.signal!.addEventListener("abort", aborted, { once: true });
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); },
      }), { headers: { "content-type": "text/event-stream" } });
    } });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact), signal: controller.signal });
      await response.body!.getReader().read();
      controller.abort();
      await Promise.race([
        cancellation,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Upstream was not cancelled")), 1000); }),
      ]);
    } finally { clearTimeout(timeout); proxy.stop(); }
  });

  test("passes Codex arguments as argv and applies process-local provider settings", () => {
    const args = ["resume", "--", "prompt with $() and spaces"];
    const wrapped = compactionCodexArgs("http://127.0.0.1:1234/private/backend-api/codex", args);
    expect(wrapped.slice(4)).toEqual(args);
    expect(wrapped[1]).toBe('model_provider="quotapie_compaction"');
    expect(wrapped[3]).toContain("supports_websockets=false");
    expect(wrapped[3]).toContain("requires_openai_auth=true");
  });

  test("desktop health counts routed requests and supports Codex HTTP fallback", async () => {
    const routeState = { ...route };
    const proxy = startCompactionProxy({ route: routeState, token: "f".repeat(48), fetchUpstream: async () => new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n', { headers: { "content-type": "text/event-stream" } }) });
    try {
      const upgrade = await fetch(`${proxy.baseUrl}/responses`, { headers: { upgrade: "websocket" } });
      expect(upgrade.status).toBe(426);
      await (await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact) })).text();
      const health = await (await fetch(`${proxy.baseUrl}/quotapie-health`)).json();
      expect(health.requests).toBe(1);
      expect(health.compactions).toBe(1);
      expect(health.lastRequest.to).toBe(route.to);
      routeState.to = routeState.from;
      await (await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact) })).text();
      const disabled = await (await fetch(`${proxy.baseUrl}/quotapie-health`)).json();
      expect(disabled.requests).toBe(2);
      expect(disabled.compactions).toBe(1);
      expect(disabled.lastRequest.routed).toBe(false);
    } finally { proxy.stop(); }
  });
});


describe("Compaction policy and lifecycle", () => {
  const complete = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  const streamResponse = (text: string, status = 200) => new Response(text, { status, headers: { "content-type": "text/event-stream" } });

  test("rejects unsupported compaction targets and effort before opening a listener", () => {
    expect(() => validateCompactionRoute({ from: route.from, to: "gpt-5.3-codex-spark" })).toThrow("not been validated");
    expect(() => validateCompactionRoute({ ...route, effort: "ultra" })).toThrow("Only Low");
    expect(validateCompactionRoute({ from: route.from, to: route.to }).effort).toBe("low");
    expect(validateCompactionRoute({ from: route.from, to: route.from }).to).toBe(route.from);
  });

  test("work settings and subsequent intentional model changes are preserved", async () => {
    const seen: unknown[] = [];
    const work = { ...ordinary, reasoning: { effort: "xhigh", context: "all_turns" } };
    const compression = { ...work, input: compact.input };
    const changedWork = { ...work, model: route.to, reasoning: { effort: "medium" } };
    const proxy = startCompactionProxy({ fetchUpstream: async (_url, init) => {
      seen.push(JSON.parse(await new Response(init.body).text())); return streamResponse(complete);
    } });
    try {
      for (const body of [work, compression, work, changedWork]) {
        await (await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(body) })).text();
      }
      expect(seen).toEqual([work, { ...compression, model: route.to, reasoning: { effort: "low", context: "all_turns" } }, work, changedWork]);
      expect(compression.reasoning.effort).toBe("xhigh");
    } finally { proxy.stop(); }
  });

  test("only counts completion after the terminal event and stream end, with request identity", async () => {
    const events: CompactionRequestEvent[] = [];
    let finish!: () => void;
    const threadId = "11111111-1111-4111-8111-111111111111";
    const turnId = "22222222-2222-4222-8222-222222222222";
    const proxy = startCompactionProxy({ onRequest: event => events.push(event), fetchUpstream: async () =>
      new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(complete)); finish = () => c.close();
      } }), { headers: { "content-type": "text/event-stream" } }),
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact),
        headers: { session_id: threadId, "x-codex-turn-metadata": JSON.stringify({ turn_id: turnId, prompt: "never-log-this" }) } });
      const reader = response.body!.getReader(); await reader.read();
      const pending = await (await fetch(`${proxy.baseUrl}/quotapie-health`)).json();
      expect(pending.compactions).toBe(0); expect(pending.activeRequests).toBe(1);
      finish(); finish = () => {}; await reader.read();
      const done = await (await fetch(`${proxy.baseUrl}/quotapie-health`)).json();
      expect(done.compactions).toBe(1); expect(done.activeRequests).toBe(0);
      expect(events.map(event => event.phase)).toEqual(["started", "response_headers", "completed"]);
      expect(new Set(events.map(event => event.requestId)).size).toBe(1);
      expect(events.every(event => event.threadId === threadId && event.turnId === turnId)).toBe(true);
      expect(JSON.stringify(done)).not.toContain("never-log-this");
    } finally { finish?.(); proxy.stop(); }
  });

  test("rejections, protocol failures and truncated streams never count as success", async () => {
    const responses = [streamResponse("rejected", 400), streamResponse('data: {"type":"response.failed"}\n\n'), streamResponse('data: {"type":"response.created"}\n\n'), new Response("unrecognized", { headers: { "content-type": "application/octet-stream" } })];
    const proxy = startCompactionProxy({ fetchUpstream: async () => responses.shift()! });
    try {
      for (let index = 0; index < 4; index++) await (await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact) })).text();
      const health = await (await fetch(`${proxy.baseUrl}/quotapie-health`)).json();
      expect(health.compactions).toBe(0); expect(health.attemptedCompactions).toBe(4);
      expect(health.failedCompactions).toBe(3); expect(health.unverifiedCompactions).toBe(1);
      expect(health.activeRequests).toBe(0);
    } finally { proxy.stop(); }
  });

  test("cancellation has one terminal event and cannot become a completed compaction", async () => {
    const events: CompactionRequestEvent[] = [];
    const proxy = startCompactionProxy({ onRequest: event => events.push(event), fetchUpstream: async () =>
      new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n')); } }), { headers: { "content-type": "text/event-stream" } }),
    });
    try {
      const abort = new AbortController();
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact), signal: abort.signal });
      await response.body!.getReader().read(); abort.abort();
      for (let i = 0; i < 50 && !events.some(event => event.phase === "cancelled"); i++) await Bun.sleep(5);
      const health = await (await fetch(`${proxy.baseUrl}/quotapie-health`)).json();
      expect(health.cancelledCompactions).toBe(1); expect(health.compactions).toBe(0);
      expect(events.filter(event => ["completed", "failed", "cancelled", "unverified"].includes(event.phase))).toHaveLength(1);
    } finally { proxy.stop(); }
  });

  test("Codex closing its reader after a completion event is success, not cancellation", async () => {
    const events: CompactionRequestEvent[] = [];
    const routeState = { ...route };
    const proxy = startCompactionProxy({ route: routeState, onRequest: event => events.push(event), fetchUpstream: async () =>
      // Native Responses Lite omits Content-Type. Do not depend on that header.
      new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(complete)); } })),
    });
    try {
      const abort = new AbortController();
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact), signal: abort.signal });
      await response.body!.getReader().read();
      routeState.to = "gpt-5.6-terra";
      abort.abort();
      for (let i = 0; i < 50 && !events.some(event => event.phase === "completed"); i++) await Bun.sleep(5);
      const health = await (await fetch(`${proxy.baseUrl}/quotapie-health`)).json();
      expect(health.compactions).toBe(1); expect(health.cancelledCompactions).toBe(0);
      expect(health.recent[0].to).toBe("gpt-5.6-sol");
      expect(health.route.to).toBe("gpt-5.6-terra");
    } finally { proxy.stop(); }
  });

  test("an HTTP rejection stays failed when the client closes its reader", async () => {
    const events: CompactionRequestEvent[] = [];
    const proxy = startCompactionProxy({ onRequest: event => events.push(event), fetchUpstream: async () =>
      new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(complete)); } }),
        { status: 400, headers: { "content-type": "text/event-stream" } }),
    });
    try {
      const abort = new AbortController();
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact), signal: abort.signal });
      await response.body!.getReader().read(); abort.abort();
      for (let i = 0; i < 50 && !events.some(event => event.phase === "failed"); i++) await Bun.sleep(5);
      const health = await (await fetch(`${proxy.baseUrl}/quotapie-health`)).json();
      expect(health.failedCompactions).toBe(1); expect(health.compactions).toBe(0);
      expect(health.cancelledCompactions).toBe(0);
      expect(health.recent[0].errorCode).toBe("upstream_http_error");
    } finally { proxy.stop(); }
  });

  test("drain includes a request whose upload has not finished", async () => {
    const proxy = startCompactionProxy({ fetchUpstream: async () => streamResponse(complete) });
    const body = JSON.stringify(compact);
    let finish!: () => void;
    const pending = fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(body.slice(0, 10)));
      finish = () => { c.enqueue(new TextEncoder().encode(body.slice(10))); c.close(); };
    } }) }).then(response => response.text());
    try {
      let active = 0;
      for (let i = 0; i < 50 && !active; i++) {
        active = (await (await fetch(`${proxy.baseUrl}/quotapie-health`)).json()).activeRequests;
        if (!active) await Bun.sleep(5);
      }
      const drain = await (await fetch(`${proxy.baseUrl}/quotapie-drain`, { method: "POST" })).json();
      expect(drain.activeRequests).toBe(1);
      finish(); finish = () => {}; await pending;
      const health = await (await fetch(`${proxy.baseUrl}/quotapie-health`)).json();
      expect(health.activeRequests).toBe(0); expect(health.compactions).toBe(1);
    } finally { finish(); await pending.catch(() => {}); proxy.stop(); }
  });

  test("drain rejects new requests while letting an existing response complete", async () => {
    let finish!: () => void;
    const proxy = startCompactionProxy({ fetchUpstream: async () => new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(complete)); finish = () => c.close();
    } }), { headers: { "content-type": "text/event-stream" } }) });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact) });
      const reader = response.body!.getReader(); await reader.read();
      const drain = await (await fetch(`${proxy.baseUrl}/quotapie-drain`, { method: "POST" })).json();
      expect(drain.activeRequests).toBe(1);
      expect((await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: JSON.stringify(compact) })).status).toBe(503);
      finish(); finish = () => {}; await reader.read();
      expect((await (await fetch(`${proxy.baseUrl}/quotapie-health`)).json()).compactions).toBe(1);
    } finally { finish?.(); proxy.stop(); }
  });
});
