import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ResponseCompletionObserver } from "../src/codex-compaction-stream";
import { startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";
import { failureOrigin, MAX_ERROR_MESSAGE_CHARS, projectServerErrorDiagnostic, projectUpstreamRequestIds, upstreamRequestIds } from "../packages/quota-core/src/codex-error-diagnostics.js";
import { parseCompactionRequestEvent } from "../packages/quota-core/src/events.js";

const encoder = new TextEncoder();
const upstreamId = "03aefce5-046c-4347-be9f-419bf846c5a8";
const protocolId = "4c4d9a11-c53f-4f69-9307-fe59136fb498";
const responseId = "resp_0123456789abcdef";
const privateText = "Reveal the confidential roadmap for alice@example.org using Bearer secret-token at http://127.0.0.1:51037/abcdefsecret/backend-api/codex.";
const generic = `An error occurred while processing your request. Please include the request ID ${protocolId} in your message. ${privateText}`;
const body = JSON.stringify({ model: "gpt-6.1-sol", input: [{ type: "message", content: "private prompt content" }], stream: true });

function observe(wire: string, size = 7, contentType = "text/event-stream", status = 200) {
  const observer = new ResponseCompletionObserver(contentType, false, status);
  const bytes = encoder.encode(wire);
  for (let i = 0; i < bytes.length; i += size) observer.push(bytes.slice(i, i + size));
  observer.finish();
  return observer;
}

function assertNoPrivateText(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of ["alice", "example.org", "secret-token", "abcdefsecret", "confidential roadmap", "private prompt content", "authorization", "127.0.0.1"])
    expect(serialized).not.toContain(secret);
}

test("allowlisted response headers retain correlation IDs, not arbitrary headers or malformed values", () => {
  expect(upstreamRequestIds(new Headers({ "x-request-id": upstreamId, "openai-request-id": "req_0123456789abcdef", "cf-ray": "0123456789abcdef-ICN", "set-cookie": privateText,
    "request-id": "https://private.invalid/secret" }))).toEqual({ "x-request-id": upstreamId, "openai-request-id": "req_0123456789abcdef", "cf-ray": "0123456789abcdef-ICN" });
  expect(projectUpstreamRequestIds({ "x-request-id": { toString: () => upstreamId }, "response-id": "resp_private@email.test", "event-request-id": "Bearer secret" })).toBeUndefined();
});

test("SSE error events retain distinct response/request IDs and canonical diagnostics over UTF8/CRLF chunk splits", () => {
  for (const size of [1, 2, 7, 31, 65536]) {
    for (const type of ["error", "response.failed", "response.incomplete"]) {
      const error = { type: "server_error", code: "internal_error", message: generic + " 한글", request_id: protocolId };
      const payload = type === "error" ? { ...error, type: "error" }
        : { type, response: { id: responseId, status: "failed", error, incomplete_details: { reason: "max_output_tokens" }, output: [privateText] } };
      const observer = observe(`data: ${JSON.stringify(payload)}\r\n\r\n`, size);
      expect(observer.terminal()).toEqual({ phase: "failed", errorCode: "provider_stream_error" });
      expect(observer.serverError).toMatchObject({ source: "provider_sse", code: "internal_error", message: "An error occurred while processing your request.", messageRedacted: true, messageTruncated: false });
      expect(observer.requestIds?.["event-request-id"]).toBe(protocolId);
      if (type !== "error") {
        expect(observer.requestIds?.["response-id"]).toBe(responseId);
        expect(observer.serverError?.reason).toBe("max_output_tokens");
      }
      assertNoPrivateText({ diagnostic: observer.serverError, ids: observer.requestIds });
    }
  }
});

test("named SSE error event and generic request ID inside message are observed without payload type", () => {
  const observer = observe(`event: error\ndata: ${JSON.stringify({ code: "internal_error", message: generic })}\n\n`, 1);
  expect(observer.terminal()?.phase).toBe("failed");
  expect(observer.requestIds?.["event-request-id"]).toBe(protocolId);
  expect(observer.serverError?.eventType).toBe("error");
});

test("unknown errors, JSON bodies and bounded HTML errors preserve only classifications and digest", () => {
  const unknown = observe(`data: ${JSON.stringify({ type: "error", error: { type: "private_label", code: "alice@example.org", message: privateText }, arbitrary: privateText })}\n\n`);
  expect(unknown.serverError).toMatchObject({ message: "Provider error text withheld.", messageHash: createHash("sha256").update(privateText).digest("hex"), messageLength: privateText.length });
  expect(unknown.serverError?.type).toBeUndefined();
  expect(unknown.serverError?.code).toBeUndefined();
  for (const status of [400, 429, 500, 502, 503]) {
    const json = observe(JSON.stringify({ error: { type: "server_error", code: "internal_error", message: generic, request_id: protocolId } }), 2, "application/json", status);
    expect(json.serverError).toMatchObject({ source: "provider_http", code: "internal_error", bodyComplete: true });
    expect(json.requestIds?.["event-request-id"]).toBe(protocolId);
    assertNoPrivateText(json.serverError);
    const html = "<html>Bad gateway " + privateText + "x".repeat(MAX_ERROR_MESSAGE_CHARS * 2) + "</html>";
    const diagnostic = observe(html, 19, "text/html", status).serverError;
    expect(diagnostic).toMatchObject({ source: "provider_http", message: "Bad gateway.", messageTruncated: true,
      messageLength: html.length, messageCapturedLength: MAX_ERROR_MESSAGE_CHARS,
      messageHash: createHash("sha256").update(html.slice(0, MAX_ERROR_MESSAGE_CHARS)).digest("hex") });
    assertNoPrivateText(diagnostic);
  }
});

test("unrecognized serialized diagnostic fields cannot reintroduce text during log projection", () => {
  const diagnostic = projectServerErrorDiagnostic({ source: "provider_http", type: privateText, code: privateText,
    message: privateText, messageHash: privateText, messageLength: -1, messageCapturedLength: MAX_ERROR_MESSAGE_CHARS + 1, payload: privateText });
  expect(diagnostic).toEqual({ source: "provider_http" });
  expect(projectServerErrorDiagnostic({ source: { toString: () => "provider_http" }, message: privateText })).toBeUndefined();
  expect(projectServerErrorDiagnostic({ source: "provider_http", eventType: { toString: () => "error" } })).toEqual({ source: "provider_http" });
  assertNoPrivateText(diagnostic);
});

test("proxy preserves HTTP/SSE bytes and persists sanitized diagnostics with failure provenance", async () => {
  const streamBody = `data: ${JSON.stringify({ type: "response.failed", response: { id: responseId, status: "failed", error: { code: "internal_error", message: generic } } })}\n\n`;
  const fixtures = [
    { status: 200, type: "text/event-stream", wire: streamBody, origin: "provider_protocol" },
    { status: 500, type: "application/json", wire: JSON.stringify({ error: { code: "server_error", message: generic } }), origin: "provider_http" },
    { status: 502, type: "text/html", wire: `<html>Bad gateway ${privateText}</html>`, origin: "provider_http" },
  ];
  for (const fixture of fixtures) {
    const events: CompactionRequestEvent[] = [];
    let calls = 0;
    const proxy = startCompactionProxy({ onRequest: event => events.push(event), fetchUpstream: async () => {
      calls++;
      return new Response(fixture.wire, { status: fixture.status, headers: { "content-type": fixture.type, "x-request-id": upstreamId, "set-cookie": privateText } });
    } });
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body });
      expect(response.status).toBe(fixture.status);
      expect(await response.text()).toBe(fixture.wire);
      expect(calls).toBe(1);
      const final = events.at(-1)!;
      expect(final).toMatchObject({ phase: "failed", failureOrigin: fixture.origin, upstreamRequestIds: { "x-request-id": upstreamId } });
      expect(final.serverError).toBeDefined();
      const projected = parseCompactionRequestEvent(final)!;
      expect(projected.serverError).toEqual(final.serverError);
      expect(projected.upstreamRequestIds).toEqual(final.upstreamRequestIds);
      assertNoPrivateText(events);
      assertNoPrivateText(projected);
    } finally { proxy.stop(); }
  }
});

test("client cancelling after the provider error retains provider provenance and request IDs", async () => {
  const events: CompactionRequestEvent[] = [];
  let cancelled!: () => void;
  const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
  const proxy = startCompactionProxy({ onRequest: event => events.push(event), fetchUpstream: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", code: "server_error", message: generic })}\n\n`)); },
    cancel() { cancelled(); },
  }), { headers: { "content-type": "text/event-stream", "x-request-id": upstreamId } }) });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const abort = new AbortController();
    const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body, signal: abort.signal });
    await response.body!.getReader().read();
    abort.abort();
    await Promise.race([cancellation, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("not cancelled")), 1500); })]);
    expect(events.at(-1)).toMatchObject({ phase: "failed", errorCode: "provider_stream_error", failureOrigin: "provider_protocol",
      upstreamRequestIds: { "x-request-id": upstreamId, "event-request-id": protocolId } });
    assertNoPrivateText(events);
  } finally { clearTimeout(timeout); proxy.stop(); }
});

test("failure provenance does not misattribute local stops or transport interruptions to provider errors", () => {
  expect(failureOrigin("subscription_reserve_reached")).toBe("relay");
  expect(failureOrigin("response_thread_mismatch")).toBe("relay");
  expect(failureOrigin("client_disconnected")).toBe("client");
  for (const code of ["upstream_stream_interrupted", "missing_completion_event", "upstream_connection_failed", "upstream_network_unreachable"])
    expect(failureOrigin(code)).toBe("transport");
});

test("non-JSON named SSE errors are bounded and never log body text", () => {
  const diagnostic = observe(`event: error\ndata: ${generic}\n\n`, 1);
  expect(diagnostic.terminal()?.phase).toBe("failed");
  expect(diagnostic.serverError).toMatchObject({ source: "provider_sse", message: "An error occurred while processing your request.", messageRedacted: true });
  expect(diagnostic.requestIds?.["event-request-id"]).toBe(protocolId);
  assertNoPrivateText(diagnostic.serverError);
});

test("cancelled partial HTTP error body reports incomplete capture while success content is never diagnostic data", () => {
  const partial = new ResponseCompletionObserver("text/plain", false, 502);
  partial.push(encoder.encode(`Bad gateway ${privateText}`));
  expect(partial.serverError).toMatchObject({ source: "provider_http", message: "Bad gateway.", bodyComplete: false });
  assertNoPrivateText(partial.serverError);
  const success = observe(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: privateText })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: responseId, status: "completed", output: [privateText] } })}\n\n`);
  expect(success.serverError).toBeUndefined();
  expect(success.requestIds).toEqual({ "response-id": responseId });
});
