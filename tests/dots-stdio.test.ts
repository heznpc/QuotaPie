import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { runDotsStdio } from "../src/dots/stdio";

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("fixture condition not reached");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
const call = (id: number, name: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
function harness(rpc: (request: any) => Promise<unknown>, options: {
  tick?: () => Promise<void>; tickMs?: number; write?: (line: string) => void | Promise<void>;
} = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true, cancelled = false, returned = false, closed = 0;
  const lines: any[] = [], signals = new EventEmitter(), outputErrors = new EventEmitter();
  const input = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { cancelled = true; } });
  const run = runDotsStdio({ rpc, tick: options.tick ?? (async () => {}) }, {
    input, signals, outputErrors, tickMs: options.tickMs ?? 30000,
    write: options.write ?? (line => { lines.push(JSON.parse(line)); }),
    onClose: () => { open = false; closed++; },
  });
  // Observe rejection immediately; transport errors must still wait for owned cleanup.
  const outcome = run.then(() => ({ error: null }), error => ({ error: (error as Error).message }))
    .finally(() => { returned = true; });
  return { lines, signals, outputErrors, outcome,
    open: () => open, cancelled: () => cancelled, returned: () => returned, closed: () => closed,
    send: (...requests: unknown[]) => controller.enqueue(new TextEncoder().encode(requests.map(r => JSON.stringify(r) + "\n").join(""))),
    raw: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    end: () => { try { controller.close(); } catch { /* Input may already be cancelled. */ } } };
}

test("one owned execute leaves status and unsubscribe responsive and rejects a second execute", async () => {
  const execution = deferred(); let started = 0, enabled = true, cleaned = false;
  const h = harness(async request => {
    if (request.params.name === "execute_continuation") {
      started++; await execution.promise; cleaned = true;
    } else if (request.params.name === "unsubscribe") enabled = false;
    return { jsonrpc: "2.0", id: request.id, result: { enabled } };
  });
  try {
    h.send(call(1, "execute_continuation"), call(2, "execute_continuation"), call(3, "status"), call(4, "unsubscribe"));
    await until(() => h.lines.length === 3);
    expect(started).toBe(1); expect(cleaned).toBe(false); expect(enabled).toBe(false);
    expect(h.lines.map(line => line.id)).toEqual([2, 3, 4]);
    expect(h.lines[0].error).toMatchObject({ code: -32000, message: "Managed execution already in progress" });
    execution.resolve(undefined); await until(() => h.lines.some(line => line.id === 1));
    h.end(); expect(await h.outcome).toEqual({ error: null }); expect(cleaned).toBe(true);
  } finally { execution.resolve(undefined); h.end(); await h.outcome; }
});

test("ticks and ordinary RPCs remain serialized while a managed execution is pending", async () => {
  const execution = deferred(), ordinary = deferred();
  let started = false, statusStarted = false, ticks = 0, ordinaryActive = 0, maxOrdinary = 0;
  const enter = () => { ordinaryActive++; maxOrdinary = Math.max(maxOrdinary, ordinaryActive); };
  const h = harness(async request => {
    if (request.params.name === "execute_continuation") { started = true; await execution.promise; }
    else { enter(); statusStarted = true; await ordinary.promise; ordinaryActive--; }
    return { jsonrpc: "2.0", id: request.id, result: {} };
  }, { tickMs: 5, tick: async () => { enter(); ticks++; await Promise.resolve(); ordinaryActive--; } });
  try {
    h.send(call(1, "execute_continuation")); await until(() => started);
    h.send(call(2, "status")); await until(() => statusStarted);
    const priorTicks = ticks;
    await new Promise(resolve => setTimeout(resolve, 15)); expect(ticks).toBe(priorTicks);
    ordinary.resolve(undefined); await until(() => ticks > priorTicks);
    expect(maxOrdinary).toBe(1); expect(h.lines.some(line => line.id === 1)).toBe(false);
  } finally { ordinary.resolve(undefined); execution.resolve(undefined); h.end(); await h.outcome; }
});

for (const closeMode of ["EOF", "SIGTERM", "SIGINT", "output-error"] as const) {
  test(`${closeMode} revokes authorization and waits for owned execution cleanup`, async () => {
    const execution = deferred(); let started = false, cleaned = false;
    const h = harness(async request => {
      started = true; await execution.promise; cleaned = true;
      return { jsonrpc: "2.0", id: request.id, result: {} };
    });
    try {
      h.send(call(1, "execute_continuation")); await until(() => started);
      if (closeMode === "EOF") h.end();
      else if (closeMode === "output-error") h.outputErrors.emit("error", new Error("fixture broken pipe"));
      else h.signals.emit(closeMode);
      await until(() => !h.open());
      expect(h.returned()).toBe(false); expect(cleaned).toBe(false); expect(h.closed()).toBe(1);
      execution.resolve(undefined);
      expect(await h.outcome).toEqual({ error: closeMode === "output-error" ? "stdio-output-unavailable" : null });
      expect(cleaned).toBe(true); expect(h.signals.listenerCount("SIGINT")).toBe(0);
      expect(h.signals.listenerCount("SIGTERM")).toBe(0); expect(h.outputErrors.listenerCount("error")).toBe(0);
    } finally { execution.resolve(undefined); h.end(); await h.outcome; }
  });
}

test("a queued execute cannot start after a signal closes its transport", async () => {
  const ordinary = deferred(); let waiting = false, executes = 0;
  const h = harness(async request => {
    if (request.params.name === "execute_continuation") executes++;
    else { waiting = true; await ordinary.promise; }
    return { jsonrpc: "2.0", id: request.id, result: {} };
  });
  try {
    h.send(call(1, "status"), call(2, "execute_continuation")); await until(() => waiting);
    h.signals.emit("SIGTERM"); expect(h.open()).toBe(false);
    ordinary.resolve(undefined); await h.outcome;
    expect(executes).toBe(0);
    expect(h.lines.find(line => line.id === 2).error.message).toContain("Transport closed");
  } finally { ordinary.resolve(undefined); h.end(); await h.outcome; }
});

test("a write failure revokes execution before returning the pipe error", async () => {
  const execution = deferred(); let started = false, cleaned = false;
  const h = harness(async request => {
    if (request.params.name === "execute_continuation") { started = true; await execution.promise; cleaned = true; }
    return { jsonrpc: "2.0", id: request.id, result: {} };
  }, { write() { throw new Error("fixture private write details"); } });
  try {
    h.send(call(1, "execute_continuation")); await until(() => started);
    h.send(call(2, "status")); await until(() => !h.open());
    expect(h.returned()).toBe(false); expect(cleaned).toBe(false);
    execution.resolve(undefined); expect(await h.outcome).toEqual({ error: "stdio-output-unavailable" }); expect(cleaned).toBe(true);
  } finally { execution.resolve(undefined); h.end(); await h.outcome; }
});

test("oversized input still stops the transport and awaits active execution", async () => {
  const execution = deferred(); let started = false;
  const h = harness(async request => { started = true; await execution.promise; return { jsonrpc: "2.0", id: request.id, result: {} }; });
  try {
    h.send(call(1, "execute_continuation")); await until(() => started);
    h.raw("x".repeat(65537)); await until(() => !h.open());
    expect(h.returned()).toBe(false);
    execution.resolve(undefined); expect(await h.outcome).toEqual({ error: "request-too-large" });
  } finally { execution.resolve(undefined); h.end(); await h.outcome; }
});

test("a rejected executor is owned and sanitized while ordinary RPC remains usable", async () => {
  const execution = deferred(); let started = false;
  const h = harness(async request => {
    if (request.params.name === "execute_continuation") { started = true; await execution.promise; }
    return { jsonrpc: "2.0", id: request.id, result: {} };
  });
  try {
    h.send(call(1, "execute_continuation")); await until(() => started);
    execution.reject(new Error("fixture secret executor details")); await until(() => h.lines.length > 0);
    h.send(call(2, "status")); await until(() => h.lines.length === 2);
    expect(h.lines[0]).toMatchObject({ id: 1, error: { code: -32603, message: "Internal error" } });
    expect(JSON.stringify(h.lines)).not.toContain("secret");
    h.end(); expect(await h.outcome).toEqual({ error: null });
  } finally { execution.resolve(undefined); h.end(); await h.outcome; }
});
