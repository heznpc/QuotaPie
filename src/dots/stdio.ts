interface StdioBridge {
  rpc(request: unknown): Promise<unknown>;
  tick(): Promise<void>;
}
interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}
interface OutputErrors {
  on(event: "error", listener: () => void): unknown;
  off(event: "error", listener: () => void): unknown;
}

/** The transport owns the lifetime of one managed execution. Other RPCs and
 * event checks remain serialized, so unsubscribe/status can run while that
 * execution waits. Durable bridge claims remain the execution authority. */
export async function runDotsStdio(bridge: StdioBridge, options: {
  input: ReadableStream<Uint8Array>;
  write: (line: string) => void | Promise<void>;
  warn?: (line: string) => void;
  onClose: () => void;
  signals?: SignalSource;
  outputErrors?: OutputErrors;
  tickMs?: number;
}): Promise<void> {
  const reader = options.input.getReader();
  let open = true, ticking = false;
  let chain: Promise<void> = Promise.resolve();
  let output: Promise<void> = Promise.resolve();
  let execution: Promise<void> | null = null;
  let outputFailed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (!open) return;
    // Revoke runner authorization before waiting for any asynchronous cleanup.
    open = false;
    try { options.onClose(); } catch { /* Keep ownership until cleanup even if a caller fails. */ }
    clearInterval(timer);
    void reader.cancel().catch(() => {});
  };
  const reply = (response: unknown) => {
    if (response == null) return output;
    output = output.then(async () => {
      if (outputFailed) return;
      try { await options.write(JSON.stringify(response) + "\n"); }
      catch { outputFailed = true; close(); }
    });
    return output;
  };
  const requestID = (request: any) => request && Object.hasOwn(request, "id") ? request.id : undefined;
  const reject = (request: unknown, message: string) => {
    const id = requestID(request);
    return id === undefined ? Promise.resolve() : reply({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  };
  const invoke = async (request: unknown) => {
    try { await reply(await bridge.rpc(request)); }
    catch {
      const id = requestID(request);
      if (id !== undefined) await reply({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
    }
  };
  const dispatch = async (line: string) => {
    let request: any;
    try { request = JSON.parse(line); }
    catch { await reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    const managed = request?.method === "tools/call" && request?.params?.name === "execute_continuation";
    if (!managed) { await invoke(request); return; }
    if (!open) { await reject(request, "Transport closed; no execution started"); return; }
    if (execution) { await reject(request, "Managed execution already in progress"); return; }
    // Do not add the managed turn to the serialized RPC chain. Its rejection
    // and final result are still owned, awaited and never automatically retried.
    execution = invoke(request).finally(() => { execution = null; });
  };
  const signalClose = () => close();
  const outputClose = () => { outputFailed = true; close(); };
  options.signals?.on("SIGINT", signalClose);
  options.signals?.on("SIGTERM", signalClose);
  options.outputErrors?.on("error", outputClose);
  timer = setInterval(() => {
    if (!open || ticking) return;
    ticking = true;
    chain = chain.then(async () => { if (open) await bridge.tick(); }).catch(() => {
      try { options.warn?.("QuotaPie: event check unavailable; no continuation granted.\n"); } catch { /* Diagnostic only. */ }
    }).finally(() => { ticking = false; });
  }, options.tickMs ?? 30000);
  let pending = "";
  const decoder = new TextDecoder();
  try {
    while (open) {
      const { done, value } = await reader.read();
      if (done) { close(); break; }
      pending += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(pending) > 65536) throw new Error("request-too-large");
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (!line.trim()) continue;
        chain = chain.then(() => dispatch(line));
        await chain;
      }
    }
  } finally {
    close();
    // The managed runner observes onClose through stillAuthorized. Keep its
    // store and signal handlers alive until it finishes stopping its child.
    try { await chain; }
    finally {
      try { if (execution) await execution; await output; }
      finally {
        options.signals?.off("SIGINT", signalClose);
        options.signals?.off("SIGTERM", signalClose);
        options.outputErrors?.off("error", outputClose);
        reader.releaseLock();
      }
    }
  }
  if (outputFailed) throw new Error("stdio-output-unavailable");
}
