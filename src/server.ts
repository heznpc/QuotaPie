import type { AppConfig } from "./config";
import type { TimeQuotaService } from "./service";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function startDashboard(service: TimeQuotaService, config: AppConfig) {
  const dashboardFile = Bun.file(new URL("./dashboard.html", import.meta.url));
  return Bun.serve({
    hostname: config.dashboard.host,
    port: config.dashboard.port,
    async fetch(request) {
      const host = (request.headers.get("host") ?? "").toLowerCase();
      const hostname = host.startsWith("[")
        ? host.slice(1, host.indexOf("]"))
        : host.split(":")[0];
      const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", config.dashboard.host.toLowerCase()]);
      if (!hostname || !allowedHosts.has(hostname)) return json({ error: "invalid_host" }, 403);
      const url = new URL(request.url);
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(dashboardFile, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/api/status") {
        return json({ nowMs: Date.now(), statuses: service.statuses(), events: service.recentEvents(30) });
      }
      if (url.pathname === "/api/events") {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "50")));
        return json({ events: service.recentEvents(limit) });
      }
      if (url.pathname === "/health") {
        const statuses = service.statuses();
        const degraded = statuses.flatMap((status) => status.windows).filter((window) =>
          window.provider === "codex" && window.freshness !== "fresh"
        );
        return json({
          ok: degraded.length === 0,
          providers: statuses.map((status) => status.provider),
          degraded: degraded.map((window) => ({ bucket: window.bucket, freshness: window.freshness })),
        }, degraded.length ? 503 : 200);
      }
      return json({ error: "not_found" }, 404);
    },
  });
}
