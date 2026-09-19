import { fetchCodexUpstream, transportFailure } from "./codex-transport";
import { randomBytes, randomUUID } from "node:crypto";
import { gunzipSync, inflateSync } from "node:zlib";

import { DEFAULT_COMPACTION_ROUTE, isCompaction, object, routeCompaction, safeEffort, validateCompactionRoute, type CompactionRoute } from "./codex-compaction-policy";
import { DEFAULT_TASK_SAVINGS, TaskSavingsRouter, validateTaskSavings, type TaskSavingsPolicy, type SavingsReason } from "./task-savings";
import { ResponseCompletionObserver } from "./codex-compaction-stream";
import { PoolError, type AccountPool, type PoolRoute } from "./account-pool";
export { DEFAULT_COMPACTION_ROUTE, routeCompaction, validateCompactionRoute, type CompactionRoute } from "./codex-compaction-policy";

export interface CompactionRequestEvent {
  requestId: string;
  threadId: string | null;
  turnId: string | null;
  kind: "compaction" | "response";
  from: string;
  to: string;
  routed: boolean;
  phase: "started" | "response_headers" | "completed" | "failed" | "cancelled" | "unverified";
  status: number;
  requestedEffort: string | null;
  reasoningEffort: string | null;
  at: string;
  durationMs: number;
  errorCode?: string;
  transportCode?: string;
  retryCount?: number;
  savingsReason?: SavingsReason;
  responseModel?: string | null;
  usage?: { input: number; cachedInput: number; output: number } | null;
  accountRouting?: PoolRoute;
  inlineImageCount?: number;
}

function protocolId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function requestIdentity(headers: Headers) {
  let metadata: Record<string, unknown> = {};
  try {
    const raw = headers.get("x-codex-turn-metadata");
    const parsed: unknown = raw && raw.length <= 4096 ? JSON.parse(raw) : null;
    if (object(parsed)) metadata = parsed;
  } catch { /* Unrecognized metadata remains private and unassociated. */ }
  return {
    threadId: protocolId(headers.get("session_id")) ?? protocolId(metadata.thread_id),
    turnId: protocolId(headers.get("x-codex-turn-id")) ?? protocolId(metadata.turn_id),
  };
}

const UPSTREAM = "https://chatgpt.com/backend-api/codex";
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const HOP_HEADERS = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
];

function transportHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of (headers.get("connection") ?? "").split(",")) {
    if (name.trim()) headers.delete(name.trim());
  }
  for (const name of HOP_HEADERS) headers.delete(name);
  return headers;
}

function decodeBody(bytes: Uint8Array, encoding: string | null): Uint8Array {
  switch (encoding?.toLowerCase()) {
    case undefined:
    case "identity": return bytes;
    case "gzip": return gunzipSync(bytes, { maxOutputLength: MAX_BODY_BYTES });
    case "deflate": return inflateSync(bytes, { maxOutputLength: MAX_BODY_BYTES });
    case "zstd": return Bun.zstdDecompressSync(bytes);
    default: throw new Error("Unsupported request encoding");
  }
}

/** One loopback relay per launched Codex process. Credentials and bodies stay in memory. */
export function startCompactionProxy(options: {
  route?: CompactionRoute;
  port?: number;
  token?: string;
  onRequest?: (event: CompactionRequestEvent) => void;
  taskSavings?: TaskSavingsPolicy;
  savingsModelSupported?: () => boolean;
  fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>;
  accountPool?: AccountPool;
} = {}) {
  const route = options.route ?? { ...DEFAULT_COMPACTION_ROUTE };
  validateCompactionRoute(route);
  const savingsPolicy = options.taskSavings ?? { ...DEFAULT_TASK_SAVINGS };
  const savingsRouter = new TaskSavingsRouter(options.savingsModelSupported);
  const token = options.token ?? randomBytes(24).toString("hex");
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error("Invalid relay token");
  const prefix = `/${token}/backend-api/codex`;
  let requests = 0;
  let compactions = 0;
  let lastRequest: CompactionRequestEvent | null = null;
  let attemptedCompactions = 0, failedCompactions = 0, cancelledCompactions = 0, unverifiedCompactions = 0;
  let activeRequests = 0;
  let draining = false;
  const active = new Map<string, CompactionRequestEvent>();
  const recent: CompactionRequestEvent[] = [];
  const upstreamFetch = options.fetchUpstream ?? fetch;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 0,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${prefix}/`) || request.headers.has("origin")) {
        return new Response("Not found", { status: 404 });
      }
      const path = url.pathname.slice(prefix.length);
      if (path === "/quotapie-health" && request.method === "GET") {
        return Response.json({ service: "quotapie-compaction", schemaVersion: 3, accountPoolVersion: options.accountPool ? 1 : 0, accountPoolRoutingVersion: options.accountPool ? 2 : 0, accountPoolInlineImagesVersion: options.accountPool ? 2 : 0, transportRecoveryVersion: 1, taskSavings: validateTaskSavings(savingsPolicy), savingsModelSupported: options.savingsModelSupported?.() === true, pid: process.pid,
          route: validateCompactionRoute(route), requests, compactions, attemptedCompactions,
          failedCompactions, cancelledCompactions, unverifiedCompactions, activeRequests, draining,
          active: [...active.values()], recent, lastRequest });
      }
      if (path === "/quotapie-drain" && request.method === "POST") {
        draining = true;
        return Response.json({ draining, activeRequests });
      }
      if (draining) return new Response("Relay is draining", { status: 503, headers: { "retry-after": "1" } });
      // Codex explicitly recognizes 426 and falls back to HTTP for this session.
      // This keeps the built-in OpenAI provider identity in the desktop app.
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return new Response("Use streaming HTTP", { status: 426 });
      }
      if (!/^\/[a-zA-Z0-9_/-]+$/.test(path) || !["GET", "POST"].includes(request.method)) {
        return new Response("Unsupported route", { status: 400 });
      }
      let headers = transportHeaders(request.headers);
      // Bun fetch decompresses upstream responses; request identity to keep streaming simple.
      headers.set("accept-encoding", "identity");
      let body: Uint8Array<ArrayBuffer> | string | undefined;
      let expectsSse = false;
      let event: Omit<CompactionRequestEvent, "phase" | "status" | "at" | "durationMs"> | undefined;
      let poolSelection: ReturnType<AccountPool["select"]> = null;
      // Freeze the policy for this request. A live policy update cannot change
      // its target, effort, or attribution after the request has been sent.
      const policy = validateCompactionRoute(route);
      const taskPolicy = validateTaskSavings(savingsPolicy);
      // Include uploads in drain accounting, before the first body-read await.
      activeRequests++;
      try {
        if (request.method === "POST") {
          body = new Uint8Array(await request.arrayBuffer());
          if (path === "/responses" || path === "/responses/compact") {
            const decoded = decodeBody(body, headers.get("content-encoding"));
            if (decoded.byteLength > MAX_BODY_BYTES) {
              activeRequests--;
              return new Response("Request too large", { status: 413 });
            }
            const input: unknown = JSON.parse(new TextDecoder().decode(decoded));
            expectsSse = object(input) && (input.stream === true || (path === "/responses" && isCompaction(path, input)));
            const compact = object(input) && isCompaction(path, input);
            const savings = !compact && path === "/responses" ? savingsRouter.route(input, taskPolicy, requestIdentity(headers).threadId) : null;
            const routed = compact ? routeCompaction(path, input, policy) : savings ?? { body: input, routed: false };
            if (object(input) && typeof input.model === "string") {
              const outgoing = object(routed.body) ? routed.body : input;
              event = {
                requestId: randomUUID(), ...requestIdentity(headers),
                kind: isCompaction(path, input) ? "compaction" : "response",
                from: input.model, to: typeof outgoing.model === "string" ? outgoing.model : input.model,
                ...(savings ? { savingsReason: savings.reason } : {}),
                inlineImageCount: Array.isArray(input.input) ? input.input.reduce((count: number, item: any) => count +
                  [item?.content, item?.output].reduce((n: number, parts: any) => n + (Array.isArray(parts) ? parts.filter((p: any) =>
                    p?.type === "input_image" && p.file_id == null && typeof p.image_url === "string" &&
                    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image_url)).length : 0), 0), 0) : 0,
                routed: routed.routed,
                requestedEffort: safeEffort(object(input.reasoning) ? input.reasoning.effort : null),
                reasoningEffort: safeEffort(object(outgoing.reasoning) ? outgoing.reasoning.effort : null),
              };
              if (options.accountPool) {
                poolSelection = options.accountPool.select({ threadId: event.threadId, requestId: event.requestId,
                  body: input, model: event.to, headers });
                if (poolSelection) { headers = poolSelection.headers; event.accountRouting = poolSelection.route; }
              }
            }
            // Unchanged requests retain their exact original bytes and encoding.
            if (routed.routed) {
              body = JSON.stringify(routed.body);
              headers.delete("content-encoding");
            }
          }
        }
      } catch (error) {
        activeRequests--;
        if (options.accountPool) { try { options.accountPool.reject(error instanceof PoolError ? error.code : "pool_request_rejected"); } catch {} }
        if (error instanceof PoolError) return Response.json({ error: { message: error.code, type: "quotapie_account_pool", code: error.code } }, { status: error.status });
        if (options.accountPool) return Response.json({ error: { message: "pool_request_rejected", type: "quotapie_account_pool" } }, { status: 503 });
        return new Response("Invalid or unsupported request body", { status: 400 });
      }
      const started = performance.now();
      let status = 0, finished = false, receivedResponse = false;
      let retryCount = 0;
      let transportCode: string | undefined;
      let observer: ResponseCompletionObserver | undefined;
      const cancellation = new AbortController();
      if (event?.routed && event.kind === "compaction") attemptedCompactions++;
      const emit = (phase: CompactionRequestEvent["phase"], errorCode?: string) => {
        if (!event) return;
        const update: CompactionRequestEvent = { ...event, phase, status, at: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started), retryCount,
          ...(transportCode ? { transportCode } : {}), ...(errorCode ? { errorCode } : {}),
          ...(event.kind === "response" ? { responseModel: observer?.responseModel ?? null, usage: observer?.usage ?? null } : {}) };
        lastRequest = update;
        if (phase === "started" || phase === "response_headers") active.set(event.requestId, update);
        else {
          active.delete(event.requestId);
          recent.push(update);
          if (recent.length > 32) recent.shift();
        }
        // Observability callbacks must not break or repeat an inference request.
        try { options.onRequest?.(update); } catch { /* Never log callback errors. */ }
      };
      const finish = (phase: "completed" | "failed" | "cancelled" | "unverified", errorCode?: string) => {
        if (finished) return;
        finished = true;
        activeRequests--;
        request.signal.removeEventListener("abort", onAbort);
        if (event?.routed && event.kind === "response" && ["failed", "unverified"].includes(phase)) savingsRouter.failed(event.threadId);
        if (event?.routed && event.kind === "compaction") {
          if (phase === "completed") compactions++;
          if (phase === "failed") failedCompactions++;
          if (phase === "cancelled") cancelledCompactions++;
          if (phase === "unverified") unverifiedCompactions++;
        }
        emit(phase, errorCode);
        if (poolSelection && event) { try { options.accountPool!.finish(event.requestId, phase); } catch { /* telemetry must not replay inference */ } }
      };
      const clientClosed = () => {
        // Codex closes its SSE reader immediately after response.completed;
        // waiting for TCP EOF would misreport every successful native response.
        if (status >= 400) { finish("failed", "upstream_http_error"); return; }
        const terminal = status >= 200 && status < 300 ? observer?.terminal() : null;
        finish(terminal?.phase ?? "cancelled", terminal?.errorCode ?? (terminal ? undefined : "client_disconnected"));
      };
      const onAbort = () => { cancellation.abort(); clientClosed(); };
      emit("started");
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      try {
        const response = await fetchCodexUpstream(upstreamFetch, `${UPSTREAM}${path}${url.search}`, {
          method: request.method, headers, body, redirect: "manual", signal: cancellation.signal,
        }, code => { retryCount++; transportCode = code; });
        receivedResponse = true;
        status = response.status;
        if (poolSelection && event) { try { options.accountPool!.response(event.requestId, poolSelection.identity, status, response.headers.get("retry-after")); } catch { /* do not replay a dispatched request */ } }
        if (finished) { await response.body?.cancel(); return new Response(null, { status: 499 }); }
        if ([301, 302, 303, 307, 308].includes(status)) {
          await response.body?.cancel(); finish("failed", "upstream_redirect");
          return new Response("Unexpected Codex upstream redirect", { status: 502 });
        }
        if (event) requests++;
        emit("response_headers");
        const responseHeaders = transportHeaders(response.headers);
        responseHeaders.delete("content-encoding");
        // The native Responses Lite transport omits Content-Type even for SSE.
        // Use the request's stream control as a fallback, never conversation text.
        observer = new ResponseCompletionObserver(response.headers.get("content-type") || (expectsSse ? "text/event-stream" : ""), event?.kind === "compaction");
        const reader = response.body?.getReader();
        if (!reader) {
          const result = observer.finish();
          finish(response.ok ? result.phase : "failed", response.ok ? result.errorCode : "upstream_http_error");
          return new Response(null, { status, headers: responseHeaders });
        }
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                const result = observer!.finish();
                finish(response.ok ? result.phase : "failed", response.ok ? result.errorCode : "upstream_http_error");
                controller.close();
              } else {
                observer!.push(next.value);
                controller.enqueue(next.value);
              }
            } catch (error) {
              transportCode = transportFailure(error).transportCode;
              if (cancellation.signal.aborted) clientClosed();
              else finish("failed", "upstream_stream_interrupted");
              controller.error(new Error("Codex upstream stream interrupted"));
            }
          },
          async cancel() {
            cancellation.abort(); clientClosed();
            await reader.cancel().catch(() => {});
          },
        });
        return new Response(stream, { status, headers: responseHeaders });
      } catch (error) {
        if (cancellation.signal.aborted) {
          clientClosed();
          return new Response(null, { status: 499 });
        }
        const failure = transportFailure(error);
        transportCode = failure.transportCode;
        const code = receivedResponse ? "relay_response_error" : failure.errorCode;
        finish("failed", code);
        return new Response(`QuotaPie relay: ${code}`, { status: 502 });
      }
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}${prefix}`,
    stop: () => server.stop(true),
  };
}

export function compactionCodexArgs(baseUrl: string, args: string[]): string[] {
  // A custom provider named OpenAI retains Codex's remote compaction protocol.
  // HTTP lets each complete request choose a model without WS session reuse conflicts.
  const provider = `model_providers.quotapie_compaction={name="OpenAI",base_url=${JSON.stringify(baseUrl)},wire_api="responses",requires_openai_auth=true,supports_websockets=false}`;
  return ["-c", 'model_provider="quotapie_compaction"', "-c", provider, ...args];
}

export async function runCompactionCodex(args: string[], defaultCommand: string): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: quotapie codex [--codex-bin PATH] [--compact-from MODEL] [--compact-model MODEL] [--compact-effort low] -- [Codex arguments]");
    console.log("Default: gpt-6-astra compaction requests use gpt-5.6-sol. Requires an existing ChatGPT login. Experimental; applies only to this launched process.");
    return 0;
  }
  const separator = args.indexOf("--");
  const wrapperArgs = separator < 0 ? args : args.slice(0, separator);
  const codexArgs = separator < 0 ? [] : args.slice(separator + 1);
  const route = { ...DEFAULT_COMPACTION_ROUTE };
  let command = defaultCommand;
  for (let i = 0; i < wrapperArgs.length; i += 2) {
    const option = wrapperArgs[i];
    const value = wrapperArgs[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    switch (option) {
      case "--compact-from": route.from = value; break;
      case "--compact-model": route.to = value; break;
      case "--compact-effort": if (value !== "low") throw new Error("Only Low compaction effort has been validated"); route.effort = value; break;
      case "--codex-bin": command = value; break;
      default: throw new Error("Usage: quotapie codex [--codex-bin PATH] [--compact-from MODEL] [--compact-model MODEL] [--compact-effort low] -- [Codex arguments]");
    }
  }
  const proxy = startCompactionProxy({
    route,
    onRequest: (event) => {
      console.error(JSON.stringify({ service: "quotapie-compaction", ...event }));
    },
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const interrupt = () => child?.kill("SIGINT");
  const terminate = () => child?.kill("SIGTERM");
  try {
    child = Bun.spawn([command, ...compactionCodexArgs(proxy.baseUrl, codexArgs)], {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    return await child.exited;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    proxy.stop();
  }
}
