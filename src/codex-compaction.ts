import { randomBytes } from "node:crypto";
import { gunzipSync, inflateSync } from "node:zlib";

export interface CompactionRoute {
  from: string;
  to: string;
}

export const DEFAULT_COMPACTION_ROUTE: CompactionRoute = {
  from: "gpt-6-astra",
  to: "gpt-5.6-sol",
};

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Inspect protocol controls, never text inside a conversation or a retained summary. */
export function routeCompaction(
  path: string,
  body: unknown,
  route: CompactionRoute,
): { body: unknown; routed: boolean } {
  if (!object(body) || body.model !== route.from || route.from === route.to) {
    return { body, routed: false };
  }
  const last = Array.isArray(body.input) ? body.input.at(-1) : null;
  const compact = path === "/responses/compact" || (
    path === "/responses" && object(last) && last.type === "compaction_trigger"
  );
  return compact
    ? { body: { ...body, model: route.to }, routed: true }
    : { body, routed: false };
}

export interface CompactionRequestEvent {
  kind: "compaction" | "response";
  from: string;
  to: string;
  routed: boolean;
  status: number;
  reasoningEffort?: string | null;
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
  fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>;
} = {}) {
  const route = options.route ?? DEFAULT_COMPACTION_ROUTE;
  for (const model of [route.from, route.to]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) throw new Error("Invalid model name");
  }
  const token = options.token ?? randomBytes(24).toString("hex");
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error("Invalid relay token");
  const prefix = `/${token}/backend-api/codex`;
  let requests = 0;
  let compactions = 0;
  let lastRequest: (CompactionRequestEvent & { receivedAt: string }) | null = null;
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
        return Response.json({ service: "quotapie-compaction", pid: process.pid, route, requests, compactions, lastRequest });
      }
      // Codex explicitly recognizes 426 and falls back to HTTP for this session.
      // This keeps the built-in OpenAI provider identity in the desktop app.
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return new Response("Use streaming HTTP", { status: 426 });
      }
      if (!/^\/[a-zA-Z0-9_/-]+$/.test(path) || !["GET", "POST"].includes(request.method)) {
        return new Response("Unsupported route", { status: 400 });
      }
      const headers = transportHeaders(request.headers);
      // Bun fetch decompresses upstream responses; request identity to keep streaming simple.
      headers.set("accept-encoding", "identity");
      let body: Uint8Array<ArrayBuffer> | string | undefined;
      let event: Omit<CompactionRequestEvent, "status"> | undefined;
      try {
        if (request.method === "POST") {
          body = new Uint8Array(await request.arrayBuffer());
          if (path === "/responses" || path === "/responses/compact") {
            const decoded = decodeBody(body, headers.get("content-encoding"));
            if (decoded.byteLength > MAX_BODY_BYTES) return new Response("Request too large", { status: 413 });
            const input: unknown = JSON.parse(new TextDecoder().decode(decoded));
            const routed = routeCompaction(path, input, route);
            if (object(input) && typeof input.model === "string") {
              const last = Array.isArray(input.input) ? input.input.at(-1) : null;
              event = {
                kind: path === "/responses/compact" || (object(last) && last.type === "compaction_trigger")
                  ? "compaction" : "response",
                from: input.model,
                to: routed.routed ? route.to : input.model,
                routed: routed.routed,
                reasoningEffort: object(input.reasoning) &&
                  typeof input.reasoning.effort === "string" &&
                  ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(input.reasoning.effort)
                    ? input.reasoning.effort : null,
              };
            }
            // Unchanged requests retain their exact original bytes and encoding.
            if (routed.routed) {
              body = JSON.stringify(routed.body);
              headers.delete("content-encoding");
            }
          }
        }
      } catch {
        return new Response("Invalid or unsupported request body", { status: 400 });
      }
      try {
        const response = await upstreamFetch(`${UPSTREAM}${path}${url.search}`, {
          method: request.method,
          headers,
          body,
          redirect: "manual",
          signal: request.signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          return new Response("Unexpected Codex upstream redirect", { status: 502 });
        }
        if (event) {
          requests++;
          if (event.routed) compactions++;
          lastRequest = { ...event, status: response.status, receivedAt: new Date().toISOString() };
          options.onRequest?.({ ...event, status: response.status });
        }
        const responseHeaders = transportHeaders(response.headers);
        responseHeaders.delete("content-encoding");
        return new Response(response.body, { status: response.status, headers: responseHeaders });
      } catch {
        // Never print transport errors: they can contain URLs, credentials, or body excerpts.
        if (event) options.onRequest?.({ ...event, status: 502 });
        return new Response("Codex upstream unavailable", { status: 502 });
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
    console.log("Usage: quotapie codex [--codex-bin PATH] [--compact-from MODEL] [--compact-model MODEL] -- [Codex arguments]");
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
      case "--codex-bin": command = value; break;
      default: throw new Error("Usage: quotapie codex [--codex-bin PATH] [--compact-from MODEL] [--compact-model MODEL] -- [Codex arguments]");
    }
  }
  const proxy = startCompactionProxy({
    route,
    onRequest: (event) => {
      if (event.routed) console.error(`[QuotaPie] compaction ${event.from} → ${event.to} (HTTP ${event.status}) effort=${event.reasoningEffort ?? "unspecified"}`);
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
