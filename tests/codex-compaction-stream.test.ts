import { expect, test } from "bun:test";
import { ResponseCompletionObserver } from "../src/codex-compaction-stream";

test("completion survives arbitrary chunk boundaries, CRLF and multiline SSE", () => {
  const wire = 'event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"status":"completed"}}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const size of [1, 2, 7, 31, wire.length]) {
    const observer = new ResponseCompletionObserver("text/event-stream", true);
    for (let i = 0; i < wire.length; i += size) observer.push(new TextEncoder().encode(wire.slice(i, i + size)));
    expect(observer.finish()).toEqual({ phase: "completed" });
  }
});

test("DONE, a truncated event, or an HTTP 200 with a provider failure cannot establish success", () => {
  for (const wire of [
    "data: [DONE]\n\n",
    'data: {"type":"response.completed"}',
    'data: {"type":"response.completed","response":{"status":"incomplete"}}\n\n',
    'data: {"type":"response.completed"}\n\ndata: {"type":"error"}\n\n',
  ]) {
    const observer = new ResponseCompletionObserver("text/event-stream", true);
    observer.push(new TextEncoder().encode(wire));
    expect(observer.finish().phase).toBe("failed");
  }
});

test("legacy JSON requires a complete compaction result", () => {
  for (const [wire, phase] of [
    ['{"output":[{"type":"compaction","encrypted_content":"opaque"}]}', "completed"],
    ['{"output":[]}', "unverified"],
    ['{"output":[', "unverified"],
    ['{"error":{},"output":[{"type":"compaction"}]}', "unverified"],
  ] as const) {
    const observer = new ResponseCompletionObserver("application/json", true);
    observer.push(new TextEncoder().encode(wire));
    expect(observer.finish().phase).toBe(phase);
  }
});

test("an oversized event is bounded and a later terminal event can still be observed", () => {
  const observer = new ResponseCompletionObserver("text/event-stream", true);
  observer.push(new TextEncoder().encode("data: " + "x".repeat(4 * 1024 * 1024 + 1)));
  observer.push(new TextEncoder().encode('\n\ndata: {"type":"response.completed"}\n\n'));
  expect(observer.finish()).toEqual({ phase: "completed" });
});
