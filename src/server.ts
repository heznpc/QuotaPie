import { buildHeadline } from "./analytics";
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
        const nowMs = Date.now();
        const accounts = service.accountStates(nowMs);
        return json({
          nowMs,
          headline: buildHeadline(accounts, nowMs),
          accounts,
          // 기존 소비자를 위해 남겨둔 표현. 창이 있는 계정만 담기므로 신규 소비자는 accounts를 쓴다.
          statuses: service.statuses(nowMs),
          events: service.recentEvents(30),
        });
      }
      if (url.pathname === "/api/events") {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "50")));
        return json({ events: service.recentEvents(limit) });
      }
      if (url.pathname === "/health") {
        // 건강은 창의 신선도가 아니라 수집 자체의 상태로 판정한다. 활성 계정 중
        // 하나라도 최근 성공이 없으면 200을 돌려주지 않는다.
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
