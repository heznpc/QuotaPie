import { resetTimingPresentation } from "./signals/timing-presentation";
import { profileDockIcon } from "./profile-dock-icon";
import { localAnnouncementTime } from "./signals/time";
import { benefitChangeText, signalDecision } from "./signals/presentation";
import { connectProfileRelay } from "./profile-relay";
import { saveAccountNickname } from "./account-nickname";
import { connectCodexProfile } from "./profile-connection";
import { ModelNotifications } from "./model-notifications";
import { startSerialObserver } from "./serial-observer";
import { poolStatus, configurePoolPolicy, PoolError } from "./account-pool";
import { buildHeadline } from "./analytics";
import { captureRuntimeIdentity } from "./runtime-identity";
import { CompactionStatusReader } from "./compaction-status";
import type { AppNotificationDisposition, Headline, QuotaEvent } from "./types";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ResumeTargetError } from "./service";
import { ResumeTaskStoreError } from "./storage/resume-task-store";
import { DotsConnection } from "./dots/connection";
import { UsageReportAPI, parseUsageQuery } from "./usage-report-api";
import { OfficialUsageAPI, parseOfficialUsageQuery } from "./official-usage";
import { officialUsageBoundary } from "./official-usage-boundary";
import { readOfficialThreadCandidates } from "./official-thread-usage";
import { ClaudeDesktopError } from "./providers/claude-desktop";

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
import { codexProfileRoot, saveNotificationPreferences } from "./config";
import { validateNotificationPatch } from "./notification-preferences";
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

export function startDashboard(service: QuotaPieService, config: AppConfig, options: { compactionRoot?: string; preferencesPath?: string; poolPolicyPath?: string; poolDatabasePath?: string } = {}) {
  const runtime = captureRuntimeIdentity();
  const compaction = new CompactionStatusReader(options.compactionRoot);
  const dots = new DotsConnection({ config: () => config });
  const usageReports = new UsageReportAPI(config, service.db.db, options.compactionRoot);
  const officialUsage = new OfficialUsageAPI(config, fetch, undefined, (account, query, now) =>
    officialUsageBoundary(service.db.db, config, account, query, now), readOfficialThreadCandidates);
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
    async fetch(request, server) {
      const host = (request.headers.get("host") ?? "").toLowerCase();
      const hostname = host.startsWith("[")
        ? host.slice(1, host.indexOf("]"))
        : host.split(":")[0];
      const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", config.dashboard.host.toLowerCase()]);
      if (!hostname || !allowedHosts.has(hostname)) return json({ error: "invalid_host" }, 403);
      const url = new URL(request.url);
      if (url.pathname === "/api/official-usage") {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        const origin = request.headers.get("origin");
        if ((origin !== null && origin !== url.origin) || !tokenMatches(request.headers.get("x-quotapie-action-token")))
          return json({ error: "forbidden" }, 403);
        try { return json(await officialUsage.read(parseOfficialUsageQuery(url, config), Date.now(), url.searchParams.get("refresh") === "1")); }
        catch { return json({ error: "invalid_official_usage_query" }, 400); }
      }
      if (url.pathname === "/api/usage-report") {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        const origin = request.headers.get("origin");
        if ((origin !== null && origin !== url.origin) || !tokenMatches(request.headers.get("x-quotapie-action-token")))
          return json({ error: "forbidden" }, 403);
        try { return json(usageReports.read(parseUsageQuery(url, config), Date.now(), url.searchParams.get("refresh") === "1")); }
        catch { return json({ error: "invalid_usage_query" }, 400); }
      }
      if (url.pathname === "/api/quota") {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        const nowMs = Date.now();
        const locale = request.headers.get("x-quotapie-locale") === "ko" ? "ko"
          : request.headers.get("x-quotapie-locale") === "en" ? "en" : service.locale;
        const accounts = service.quotaAccounts(nowMs);
        return json({ nowMs, actionToken, accounts, collection: service.collectionStatus(),
          resumeTasks: service.resumeTaskSummaries(100, nowMs, accounts.flatMap(account => account.windows)),
          autoResume: service.autoResume.status(), compaction: compaction.snapshot(nowMs),
          headline: headlineJson(buildHeadline(accounts, nowMs, locale)) });
      }
      if (url.pathname === "/api/collection/refresh") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const origin = request.headers.get("origin");
        if ((origin !== null && origin !== url.origin) || !tokenMatches(request.headers.get("x-quotapie-action-token")))
          return json({ error: "forbidden" }, 403);
        const body = await request.text();
        if (body.length > 128) return json({ error: "invalid_refresh" }, 400);
        if (body) {
          try {
            const input = JSON.parse(body);
            if (!input || typeof input !== "object" || Array.isArray(input) ||
                Object.keys(input).some(key => key !== "reason") ||
                (input.reason !== undefined && !["startup", "wake", "network", "manual", "visible"].includes(input.reason)))
              return json({ error: "invalid_refresh" }, 400);
          } catch { return json({ error: "invalid_refresh" }, 400); }
        }
        service.requestCollection(true);
        return json({ collection: service.collectionStatus() }, 202);
      }
      if (url.pathname === "/api/claude/desktop/connect") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const origin = request.headers.get("origin");
        if ((origin !== null && origin !== url.origin) || !tokenMatches(request.headers.get("x-quotapie-action-token")))
          return json({ error: "forbidden" }, 403);
        const body = await request.text();
        try {
          const input = JSON.parse(body || "{}");
          if (body.length > 128 || !input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)
            return json({ error: "invalid_connection_action" }, 400);
        } catch { return json({ error: "invalid_connection_action" }, 400); }
        // Explicit connection may wait for a running background read and then
        // the user's Keychain decision. Other HTTP requests retain Bun's short
        // idle limit and the normal collection path never permits auth UI.
        server.timeout(request, 180);
        try { return json(await service.connectClaudeDesktop(options.preferencesPath)); }
        catch (error) {
          if (error instanceof ClaudeDesktopError) return json({ error: error.message, category: error.category }, 409);
          return json({ error: error instanceof Error && error.message === "settings_changed" ? "settings_changed" : "connection_action_failed",
            category: "provider-error" }, 409);
        }
      }
      if(url.pathname === "/api/auto-resume") {
        const origin=request.headers.get("origin");
        if((origin!==null && origin!==url.origin) || !tokenMatches(request.headers.get("x-quotapie-action-token"))) return json({error:"forbidden"},403);
        if(request.method!=="POST") return json({error:"method_not_allowed"},405);
        try {
          const body=await request.text();
          if(body.length>1024) throw new Error("auto-resume-invalid-action");
          const input=JSON.parse(body);
          if(input?.action==="enabled" && typeof input.account==="string" && input.account.length<=128 &&
            typeof input.enabled==="boolean" && Object.keys(input).length===3) await service.setAutoResumeEnabled(input.account,input.enabled);
          else if(input?.action==="skip" && typeof input.id==="string" && input.id.length<=128 && Object.keys(input).length===2)
            await service.autoResume.skip(input.id);
          else throw new Error("auto-resume-invalid-action");
          return json({autoResume:service.autoResume.status()});
        } catch(error) {return json({error:error instanceof Error && /^[a-z-]{3,100}$/.test(error.message)?error.message:"auto-resume-action-failed"},409);}
      }
      if (url.pathname === "/api/dots/connection") {
        if (request.headers.has("origin") || !tokenMatches(request.headers.get("x-quotapie-action-token")))
          return json({ error: "forbidden" }, 403);
        if (request.method === "GET") return json(await dots.status());
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        try {
          const body = await request.text();
          if (body.length > 128) return json({ error: "invalid_connection_action" }, 400);
          const input = JSON.parse(body);
          if (Object.keys(input).length !== 1 || !["connect", "disconnect"].includes(input.action))
            return json({ error: "invalid_connection_action" }, 400);
          return json(input.action === "connect" ? await dots.connect() : await dots.disconnect());
        } catch { return json({ error: "connection_action_failed" }, 409); }
      }
      if (url.pathname === "/api/work" || url.pathname.startsWith("/api/work/")) {
        if (request.headers.has("origin") || !tokenMatches(request.headers.get("x-quotapie-action-token"))) return json({error:"forbidden"},403);
        try {
          if(request.method === "GET" && url.pathname === "/api/work") return json(service.workStatus());
          if(request.method === "GET" && url.pathname === "/api/work/preferences") return json({preferences:service.work.store.preferences()});
          if(request.method === "GET" && url.pathname === "/api/work/targets")
            return json(await service.workTargets(url.searchParams.get("provider")??"",url.searchParams.get("account")??""));
          if(request.method === "GET" && url.pathname === "/api/work/host-goal")
            return json({hostGoal:await service.previewWorkHostGoal(url.searchParams.get("provider")??"",url.searchParams.get("account")??"",url.searchParams.get("session")??"")});
          if(request.method !== "POST") return json({error:"method_not_allowed"},405);
          const body=await request.text();
          if(body.length>65536) return json({error:"work-policy-too-large"},400);
          const input=JSON.parse(body);
          if(url.pathname === "/api/work/host-goal") return json(await service.changeWorkHostGoal(input.id,input.expectedRevision,input.action,input.reviewedObjective));
          if(url.pathname === "/api/work/preferences") {
            if(input.scope === "account" && !config.accounts[input.provider as "codex"|"claude"]?.some(a => a.id === input.account && a.enabled))
              return json({error:"account-unavailable"},409);
            return json({preference:service.work.store.savePreferences(input.scope,input.provider,input.account,input.values,input.expectedRevision)});
          }
          if(url.pathname === "/api/work/execute") return json({execution:await service.work.dispatch(input.id,"dots",input.expectedRevision,input.requestId)});
          if(url.pathname !== "/api/work") return json({error:"not_found"},404);
          if(input.action === "save") return json(await service.saveWorkPolicy(input.policy,input.expectedRevision,input.requestId,input.hostGoalLinked,input.reviewedObjective));
          if(input.action === "enabled") {
            if(service.work.store.get(input.id)?.purpose==="quota-resume") throw new Error("auto-resume-policy-readonly");
            return json({policy:await service.work.setEnabled(input.id,input.enabled,input.expectedRevision,input.requestId)});
          }
          return json({error:"work-action-invalid"},400);
        }catch(error){
          const reason=error instanceof Error && /^[a-z-]{3,100}$/.test(error.message)?error.message:"work-action-failed";
          return json({error:reason},409);
        }
      }
      if (url.pathname === "/api/runtime") {
        return request.method === "GET" ? json(runtime) : json({ error: "method_not_allowed" }, 405);
      }
      if (url.pathname === "/api/resume-check") {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        const provider = url.searchParams.get("provider"), account = url.searchParams.get("account");
        const bucket = url.searchParams.get("bucket");
        if ((provider !== "codex" && provider !== "claude") || !account || account.length > 128 ||
            (bucket != null && (!bucket || bucket.length > 160))) {
          return json({ error: "invalid_resume_target" }, 400);
        }
        return json(service.resumeGate(provider, account, Date.now(), bucket ?? undefined));
      }
      if (url.pathname.startsWith("/api/recent-work/")) {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (request.headers.has("origin") || !tokenMatches(request.headers.get("x-quotapie-action-token"))) {
          return json({ error: "forbidden" }, 403);
        }
        const action = url.pathname.match(/^\/api\/recent-work\/([0-9a-f]{64})\/open$/);
        if (!action) return json({ error: "invalid_recent_work_action" }, 400);
        try {
          return json({ plan: await service.recentWorkOpenPlan(action[1]!) });
        } catch (error) {
          if (error instanceof ResumeTargetError) {
            return json({ error: "recent_work_unavailable", detail: error.message }, 409);
          }
          console.error(`[quotapie] recent work open failed: ${String(error)}`);
          return json({ error: "recent_work_open_failed" }, 500);
        }
      }
      if (url.pathname === "/api/accounts/nickname") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (request.headers.has("origin") || !tokenMatches(request.headers.get("x-quotapie-action-token"))) return json({ error: "forbidden" }, 403);
        try {
          const body = await request.text();
          if (body.length > 2048) return json({ error: "invalid_nickname" }, 400);
          return json(saveAccountNickname(config, JSON.parse(body), options.preferencesPath));
        } catch (error) {
          const code = error instanceof Error ? error.message : "invalid_nickname";
          return json({ error: ["settings_changed", "account_not_found"].includes(code) ? code : "invalid_nickname" }, code === "settings_changed" ? 409 : 400);
        }
      }
      if (url.pathname === "/api/account-pool/policy") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (request.headers.has("origin") || !tokenMatches(request.headers.get("x-quotapie-action-token"))) return json({ error: "forbidden" }, 403);
        try {
          const body = await request.text();
          if (body.length > 2048) return json({ error: "pool_invalid_policy" }, 400);
          configurePoolPolicy(JSON.parse(body), options.poolPolicyPath);
          return json({ pool: poolStatus(options.poolDatabasePath, options.poolPolicyPath) });
        } catch (error) {
          return json({ error: error instanceof PoolError ? error.code : "pool_policy_update_failed" }, error instanceof PoolError ? error.status : 400);
        }
      }
      if (url.pathname === "/api/profiles/dock-icon") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (request.headers.has("origin") || !tokenMatches(request.headers.get("x-quotapie-action-token"))) return json({ error: "forbidden" }, 403);
        try {
          const body = await request.text();
          if (body.length > 2048) return json({ error: "invalid_icon" }, 400);
          return json(await profileDockIcon(config, JSON.parse(body)));
        } catch { return json({ error: "dock_icon_unavailable" }, 409); }
      }
      if (url.pathname === "/api/profiles/connect") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (request.headers.has("origin") || !tokenMatches(request.headers.get("x-quotapie-action-token"))) return json({ error: "forbidden" }, 403);
        try {
          const body = await request.text();
          if (body.length > 8192) return json({ error: "invalid_profile" }, 400);
          const connection = connectCodexProfile(config, JSON.parse(body), options.preferencesPath);
          service.requestCollection();
          const profile = config.accounts.codex.find(profile => profile.id === connection.account)!;
          const relayConnected = await connectProfileRelay(codexProfileRoot(profile), options.compactionRoot);
          return json({ ...connection, relayConnected });
        } catch (error) {
          const code = error instanceof Error ? error.message : "connection_failed";
          return json({ error: ["invalid_profile", "settings_changed", "account_disabled", "isolation_required", "profile_overlap", "profile_relay_failed"].includes(code) ? code : "connection_failed" }, 409);
        }
      }
      if (url.pathname === "/api/task-savings/policy") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (request.headers.has("origin") || !tokenMatches(request.headers.get("x-quotapie-action-token"))) return json({ error: "forbidden" }, 403);
        try {
          const body = await request.text();
          if (body.length > 1024) return json({ error: "invalid_policy" }, 400);
          return json({ policy: await compaction.savingsPolicy.configure(JSON.parse(body)) });
        } catch { return json({ error: "savings_update_failed" }, 409); }
      }
      if (url.pathname === "/api/compaction/policy") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (request.headers.has("origin") || !tokenMatches(request.headers.get("x-quotapie-action-token"))) {
          return json({ error: "forbidden" }, 403);
        }
        try {
          const text = await request.text();
          if (text.length > 1024) return json({ error: "invalid_policy" }, 400);
          const input = JSON.parse(text);
          return json({ policy: await compaction.policy.configure(input.model) });
        } catch {
          return json({ error: "policy_update_failed" }, 409);
        }
      }
      if (url.pathname === "/api/notifications" || url.pathname.startsWith("/api/notifications/")) {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        if (!tokenMatches(request.headers.get("x-quotapie-action-token"))) {
          return json({ error: "forbidden" }, 403);
        }
        try {
          if (url.pathname === "/api/notifications/preferences") {
            if (request.headers.has("origin")) return json({ error: "forbidden" }, 403);
            let input: unknown;
            try {
              const body = await request.text();
              if (body.length > 4096) throw new Error("too large");
              input = JSON.parse(body);
              validateNotificationPatch(input);
            } catch { return json({ error: "invalid_preferences" }, 400); }
            const patch = saveNotificationPreferences(input, options.preferencesPath);
            service.applyNotificationPreferences(patch);
            return json({ notificationPreferences: service.notificationPreferences() });
          }
          if (url.pathname === "/api/notifications/claim") {
            if (request.headers.get("x-quotapie-notifications-authorized") === "true") {
              service.alerts.setNativeNotificationConsumer(true);
              await service.retrySuppressedNotifications();
            }
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
        } finally {
          service.publishWorkBoundary();
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
        const displayLocale = request.headers.get("x-quotapie-locale") === "ko" ? "ko" : request.headers.get("x-quotapie-locale") === "en" ? "en" : service.locale;
        const analysed = service.analyses(nowMs);
        const accounts = service.accountStates(nowMs, analysed);
        const resetPlans = service.resetPlanning(accounts, nowMs);
        const timingStatus = service.resetTimingStatus();
        return json({
          nowMs,
          actionToken,
          collection: service.collectionStatus(),
          headline: headlineJson(buildHeadline(accounts, nowMs, displayLocale)),
          accounts,
          // File inventory is opt-in; quota-only clients do not start a scan.
          ...service.recentWorkStatus(nowMs, request.headers.get("x-quotapie-recent-work") === "1"),
          resumeTasks: service.resumeTaskSummaries(100, nowMs, analysed),
          autoResume: service.autoResume.status(),
          hostGoals: service.hostGoalStatus(nowMs),
          jobs: service.jobs.summaries(),
          notificationPreferences: service.notificationPreferences(),
          resetSignals: (() => {
            const feed = service.signalCollector.status(nowMs);
            const automation = service.resetAutomationStatus(nowMs);
            const timingCases = timingStatus.cases;
            const publications = "publications" in timingStatus ? timingStatus.publications : [];
            const opportunities = resetPlans.flatMap(plan => plan.opportunities);
            const forecastText = (id: string) => {
              const entries = opportunities.filter(o => o.signalId === id);
              if (!entries.length) return null;
              const forecasts = entries.flatMap(o => o.forecast ? [o.forecast] : []);
              const ko = displayLocale === "ko";
              if (!forecasts.length) {
                const provider = feed.signals.find(s => s.id === id)?.provider ?? "codex";
                if (!automation.some(a => a.provider === provider && a.enabledCount > 0))
                  return ko ? "자동 실행 대상 없음 · 예고 수집만 동작 중" : "No automatic work configured · collecting announcements only";
                return ko ? "패턴 근거 부족 · 등록 작업의 실행 조건 확인 중" : "Insufficient history · checking registered work conditions";
              }
              const format = (ms: number) => new Intl.DateTimeFormat(ko ? "ko-KR" : "en-US", {
                timeZone: service.config.profile.timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
              }).format(ms);
              const low = Math.min(...forecasts.map(f => f.earliestMs)), high = Math.max(...forecasts.map(f => f.latestMs));
              return `${ko ? "관측 기반 추정" : "Observed estimate"}: ${format(low)}–${format(high)} · ${ko ? "확정 아님" : "unconfirmed"}`;
            };
            const closed = new Map(resetPlans.map(a => [a.provider + ":" + a.account, new Set(a.closedSignalIDs)]));
            return { ...feed, automation, signals: feed.signals.map(signal => {
              const presentation = resetTimingPresentation(signal, timingCases, displayLocale, service.config.profile.timeZone, accounts, publications);
              return { ...signal,
              preparationClosed: accounts.some(a => a.provider === (signal.provider ?? "codex")) && accounts
                .filter(a => a.provider === (signal.provider ?? "codex"))
                .every(a => closed.get(a.provider + ":" + a.account)!.has(signal.id)),
              forecastText: presentation.forecastText ?? forecastText(signal.id),
              timingHistoryText: presentation.timingHistoryText,
              localTimeText: localAnnouncementTime(signal, displayLocale, service.config.profile.timeZone),
              benefitText: benefitChangeText(signal, displayLocale),
              newsTitle: signalDecision(signal, displayLocale, service.config.profile.timeZone).title,
            }; }) };
          })(),
          resetOpportunities: resetPlans.flatMap(plan => plan.opportunities.map(opportunity => ({ ...opportunity, account: plan.account }))),
          resetTiming: timingStatus,
          resetTracking: service.resetTracking(nowMs, accounts),
          compaction: compaction.snapshot(nowMs),
          accountPool: (() => { try {
            const pool = poolStatus(options.poolDatabasePath, options.poolPolicyPath);
            return { ...pool, recent: pool.recent.map(item => {
              const row = item as { account: string; accountLabel: string };
              const account = accounts.find(account => account.provider === "codex" && account.account === row.account);
              return { ...row, ...(account ? { accountLabel: account.accountLabel } : {}) };
            }) };
          } catch { return { enabled: false, accounts: [], recent: [], error: "pool_status_unavailable" }; } })(),
          // Kept for existing consumers. It only contains accounts that have
          // windows, so new consumers should read accounts instead.
          statuses: service.statuses(nowMs, analysed),
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
        const accounts = service.quotaAccounts(nowMs);
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
  // Older relays retain only a small live history. Collect sanitized follow-up
  // evidence even while the popover is closed, without restarting those relays.
  const modelNotifications = new ModelNotifications(service.storage, service.alerts);
  const observeModels = () => compaction.status().then(() =>
    modelNotifications.observe(compaction.notificationEvents(), config, service.locale));
  const stopObserving = startSerialObserver(observeModels);
  const stop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => {
    stopObserving();
    return stop(closeActiveConnections);
  }) as typeof server.stop;
  return server;
}
