import { buildHeadline } from "./analytics";
import type { AppNotificationDisposition, Headline, QuotaEvent } from "./types";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ResumeTargetError } from "./service";
import { ResumeTaskStoreError } from "./storage/resume-task-store";

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
  const actionToken = randomBytes(32).toString("base64url");
  const tokenMatches = (candidate: string | null): boolean => {
    if (candidate == null) return false;
    const expected = Buffer.from(actionToken);
    const received = Buffer.from(candidate);
    return expected.length === received.length && timingSafeEqual(expected, received);
  };
  const server = Bun.serve({
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
      if (url.pathname === "/api/notifications" || url.pathname.startsWith("/api/notifications/")) {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (!tokenMatches(request.headers.get("x-quotapie-action-token"))) {
          return json({ error: "forbidden" }, 403);
        }
        try {
          if (url.pathname === "/api/notifications/claim") {
            const claim = service.claimNextAppNotification();
            return json({
              notification: claim
                ? {
                    id: claim.id,
                    title: claim.title,
                    message: claim.message,
                    presentation: claim.presentation,
                    severity: claim.severity,
                    createdAtMs: claim.createdAtMs,
                    expiresAtMs: claim.expiresAtMs,
                    claimToken: claim.claimToken,
                  }
                : null,
            });
          }
          if (url.pathname === "/api/notifications/test") {
            return json(await service.deliverTestAlert());
          }
          const action = url.pathname.match(/^\/api\/notifications\/([^/]+)\/([^/]+)$/);
          if (!action) return json({ error: "invalid_notification_action" }, 400);
          const id = action[1]!;
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            return json({ error: "invalid_notification_id" }, 400);
          }
          const operation = action[2]!;
          if (!["scheduled", "suppressed", "expired", "release", "renew"].includes(operation)) {
            return json({ error: "invalid_notification_action" }, 400);
          }
          const claimToken = request.headers.get("x-quotapie-notification-claim")?.trim();
          if (!claimToken) return json({ error: "notification_claim_required" }, 403);
          if (operation === "release") {
            const released = service.releaseAppNotification(id, claimToken);
            return released
              ? json({ released: true })
              : json({ error: "notification_claim_conflict" }, 409);
          }
          if (operation === "renew") {
            const renewed = service.renewAppNotification(id, claimToken);
            return renewed
              ? json({ renewed: true })
              : json({ error: "notification_claim_conflict" }, 409);
          }
          const completed = service.completeAppNotification(
            id,
            claimToken,
            operation as AppNotificationDisposition,
          );
          return completed
            ? json({ completed: true })
            : json({ error: "notification_claim_conflict" }, 409);
        } catch (error) {
          console.error(`[quotapie] app notification action failed: ${String(error)}`);
          return json({ error: "notification_action_failed" }, 500);
        }
      }
      const action = url.pathname.match(
        /^\/api\/resume-tasks\/([0-9a-fA-F-]+)\/(approve|resumed|retry|dismiss)$/,
      );
      if (action) {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (!tokenMatches(request.headers.get("x-quotapie-action-token"))) {
          return json({ error: "forbidden" }, 403);
        }
        const id = action[1]!;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          return json({ error: "invalid_resume_task_id" }, 400);
        }
        try {
          switch (action[2]) {
            case "approve":
              return json(await service.approveResumeTask(id));
            case "resumed":
              return json({ task: service.markResumeTaskResumed(id) });
            case "retry":
              return json({ task: service.retryResumeTask(id) });
            case "dismiss":
              return json({ task: service.dismissResumeTask(id) });
          }
        } catch (error) {
          if (error instanceof ResumeTaskStoreError) {
            return error.kind === "not-found"
              ? json({ error: "resume_task_not_found" }, 404)
              : json({ error: error.kind, detail: error.message }, 409);
          }
          if (error instanceof ResumeTargetError) {
            return json({ error: "resume_target_unavailable", detail: error.message }, 409);
          }
          console.error(`[quotapie] resume task action failed: ${String(error)}`);
          return json({ error: "resume_action_failed" }, 500);
        }
      }
      if (url.pathname.startsWith("/api/resume-tasks/")) {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (!tokenMatches(request.headers.get("x-quotapie-action-token"))) {
          return json({ error: "forbidden" }, 403);
        }
        return json({ error: "invalid_resume_task_action" }, 400);
      }
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
          actionToken,
          headline: headlineJson(buildHeadline(accounts, nowMs, service.locale)),
          accounts,
          resumeTasks: service.resumeTaskSummaries(),
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
  service.setNativeNotificationTransportAvailable(true);
  return server;
}
