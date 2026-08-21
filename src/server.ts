import { buildHeadline } from "./analytics";
import type { Headline, QuotaEvent } from "./types";

// Deprecated compatibility aliases for the one consumer that can be a version
// behind this daemon: the menu bar app, during the seconds between the backend
// restarting and the app restarting. Every other consumer is either served by
// this process (the dashboard) or reads quota.json. Remove the aliases the next
// time the Swift payload shape changes for its own reasons — they are a bridge,
// not a second name.
function headlineJson(headline: Headline) {
  return { ...headline, title: headline.displayText, detail: headline.displayDetail };
}

function eventJson(event: QuotaEvent) {
  return { ...event, summary: event.displayText };
}
import type { AppConfig } from "./config";
import type { QuotaPieService } from "./service";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function startDashboard(service: QuotaPieService, config: AppConfig) {
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
        const nowMs = Date.now();
        const accounts = service.accountStates(nowMs);
        return json({
          nowMs,
          headline: headlineJson(buildHeadline(accounts, nowMs, service.locale)),
          accounts,
          // Kept for existing consumers. It only contains accounts that have
          // windows, so new consumers should read accounts instead.
          statuses: service.statuses(nowMs),
          events: service.recentEvents(30).map(eventJson),
        });
      }
      if (url.pathname === "/api/events") {
        // Number("abc") is NaN, and NaN survives both Math.min and Math.max.
        const requested = Number(url.searchParams.get("limit") ?? "50");
        const limit = Number.isFinite(requested)
          ? Math.min(200, Math.max(1, Math.trunc(requested)))
          : 50;
        return json({ events: service.recentEvents(limit).map(eventJson) });
      }
      if (url.pathname === "/health") {
        // Health is judged by the state of collection itself, not by window
        // freshness. If any enabled account lacks a recent success, this does
        // not return 200.
        const nowMs = Date.now();
        const accounts = service.accountStates(nowMs);
        const degraded = accounts.filter((account) => account.collection.health !== "recent-success");
        return json({
          ok: degraded.length === 0,
          accounts: accounts.map((account) => ({
            provider: account.provider,
            account: account.account,
            health: account.collection.health,
            activeSource: account.collection.activeSource,
            errorCategory: account.collection.errorCategory,
            windows: account.windows.length,
          })),
          degraded: degraded.map((account) => ({
            provider: account.provider,
            account: account.account,
            health: account.collection.health,
            errorCategory: account.collection.errorCategory,
          })),
        }, degraded.length ? 503 : 200);
      }
      return json({ error: "not_found" }, 404);
    },
  });
}
