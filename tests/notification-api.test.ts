import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { startDashboard } from "../src/server";
import { QuotaPieService } from "../src/service";
import type { ResumePlan, ResumeTaskState, TriggerDecision } from "../src/types";

interface ClaimedNotificationWire {
  id: string;
  title: string;
  message: string;
  presentation: {
    title: { key: string; params: Record<string, unknown> };
    message: { key: string; params: Record<string, unknown> };
  } | null;
  severity: string;
  createdAtMs: number;
  expiresAtMs: number;
  claimToken: string;
}

function notificationConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.dashboard.port = 0;
  config.collection.codexEnabled = false;
  config.alerts.enabled = true;
  config.alerts.macOSNotifications = true;
  config.alerts.command = null;
  return config;
}

async function withNotificationServer(
  run: (service: QuotaPieService, origin: string, actionToken: string) => Promise<void>,
): Promise<void> {
  const config = notificationConfig();
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const server = startDashboard(service, config);
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const status = await (await fetch(`${origin}/api/status`)).json() as { actionToken: string };
    await run(service, origin, status.actionToken);
  } finally {
    server.stop(true);
    await service.close();
  }
}

function actionHeaders(actionToken: string, claimToken?: string): Record<string, string> {
  return {
    "x-quotapie-action-token": actionToken,
    ...(claimToken ? { "x-quotapie-notification-claim": claimToken } : {}),
  };
}

async function registerAndQueue(
  origin: string,
  actionToken: string,
): Promise<ClaimedNotificationWire> {
  const registration = await fetch(`${origin}/api/notifications/claim`, {
    method: "POST",
    headers: actionHeaders(actionToken),
  });
  expect(registration.status).toBe(200);
  expect(await registration.json()).toEqual({ notification: null });

  const queued = await fetch(`${origin}/api/notifications/test`, {
    method: "POST",
    headers: actionHeaders(actionToken),
  });
  expect(queued.status).toBe(200);
  expect(await queued.json()).toEqual({ complete: true, nativeAppQueued: true });

  const claimResponse = await fetch(`${origin}/api/notifications/claim`, {
    method: "POST",
    headers: actionHeaders(actionToken),
  });
  expect(claimResponse.status).toBe(200);
  const body = await claimResponse.json() as { notification: ClaimedNotificationWire | null };
  expect(body.notification).not.toBeNull();
  return body.notification!;
}

describe("native app notification API", () => {
  test("authenticates claims, leases exclusively, validates IDs, and completes idempotently", async () => {
    await withNotificationServer(async (service, origin, actionToken) => {
      expect((await fetch(`${origin}/api/notifications/claim`)).status).toBe(405);
      expect((await fetch(`${origin}/api/notifications/claim`, { method: "POST" })).status).toBe(403);
      expect((await fetch(`${origin}/api/notifications/claim`, {
        method: "POST",
        headers: actionHeaders("wrong"),
      })).status).toBe(403);
      expect(service.alerts.hasNativeNotificationConsumer()).toBeFalse();

      expect((await fetch(`${origin}/api/notifications/not-a-uuid/scheduled`, {
        method: "POST",
        headers: actionHeaders(actionToken, "claim"),
      })).status).toBe(400);

      const claimed = await registerAndQueue(origin, actionToken);
      expect(Object.keys(claimed).sort()).toEqual([
        "claimToken",
        "createdAtMs",
        "expiresAtMs",
        "id",
        "message",
        "presentation",
        "severity",
        "title",
      ]);
      expect(typeof claimed.title).toBe("string");
      expect(typeof claimed.message).toBe("string");
      expect(claimed.presentation).toEqual({
        title: { key: "alert.test.title", params: {} },
        message: { key: "alert.test.message", params: {} },
      });
      expect(claimed.severity).toBe("info");
      expect(typeof claimed.claimToken).toBe("string");
      expect(claimed.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(service.alerts.hasNativeNotificationConsumer()).toBeTrue();

      const renewalUrl = `${origin}/api/notifications/${claimed.id}/renew`;
      expect((await fetch(renewalUrl, {
        method: "POST",
        headers: actionHeaders(actionToken, "wrong"),
      })).status).toBe(409);
      expect(await (await fetch(renewalUrl, {
        method: "POST",
        headers: actionHeaders(actionToken, claimed.claimToken),
      })).json()).toEqual({ renewed: true });

      const competing = await fetch(`${origin}/api/notifications/claim`, {
        method: "POST",
        headers: actionHeaders(actionToken),
      });
      expect(await competing.json()).toEqual({ notification: null });

      const completionUrl = `${origin}/api/notifications/${claimed.id}/scheduled`;
      expect((await fetch(completionUrl, {
        method: "POST",
        headers: actionHeaders(actionToken),
      })).status).toBe(403);
      expect((await fetch(completionUrl, {
        method: "POST",
        headers: actionHeaders(actionToken, "wrong"),
      })).status).toBe(409);
      expect((await fetch(completionUrl, {
        method: "POST",
        headers: actionHeaders(actionToken, claimed.claimToken),
      })).status).toBe(200);
      // A lost HTTP response can be retried without presenting twice.
      expect((await fetch(completionUrl, {
        method: "POST",
        headers: actionHeaders(actionToken, claimed.claimToken),
      })).status).toBe(200);
      expect((await fetch(`${origin}/api/notifications/${claimed.id}/suppressed`, {
        method: "POST",
        headers: actionHeaders(actionToken, claimed.claimToken),
      })).status).toBe(409);
    });
  });

  test("releases only the current lease and rejects a stale claim token", async () => {
    await withNotificationServer(async (_service, origin, actionToken) => {
      const first = await registerAndQueue(origin, actionToken);
      const releaseUrl = `${origin}/api/notifications/${first.id}/release`;

      expect((await fetch(releaseUrl, {
        method: "POST",
        headers: actionHeaders(actionToken, "wrong"),
      })).status).toBe(409);
      expect(await (await fetch(`${origin}/api/notifications/claim`, {
        method: "POST",
        headers: actionHeaders(actionToken),
      })).json()).toEqual({ notification: null });

      expect((await fetch(releaseUrl, {
        method: "POST",
        headers: actionHeaders(actionToken, first.claimToken),
      })).status).toBe(200);
      expect((await fetch(releaseUrl, {
        method: "POST",
        headers: actionHeaders(actionToken, first.claimToken),
      })).status).toBe(409);

      const reclaimedBody = await (await fetch(`${origin}/api/notifications/claim`, {
        method: "POST",
        headers: actionHeaders(actionToken),
      })).json() as { notification: ClaimedNotificationWire };
      const reclaimed = reclaimedBody.notification;
      expect(reclaimed.id).toBe(first.id);
      expect(reclaimed.claimToken).not.toBe(first.claimToken);
      expect((await fetch(`${origin}/api/notifications/${first.id}/expired`, {
        method: "POST",
        headers: actionHeaders(actionToken, first.claimToken),
      })).status).toBe(409);
      expect((await fetch(`${origin}/api/notifications/${first.id}/expired`, {
        method: "POST",
        headers: actionHeaders(actionToken, reclaimed.claimToken),
      })).status).toBe(200);
    });
  });
});

describe("notification service integration", () => {
  test("uses legacy delivery until both the API transport and native consumer are available", async () => {
    if (process.platform !== "darwin") return;
    const config = notificationConfig();
    const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
    const subprocess = {
      exited: Promise.resolve(0),
      kill: () => undefined,
    } as unknown as ReturnType<typeof Bun.spawn>;
    const spawn = spyOn(Bun, "spawn").mockReturnValue(subprocess);
    try {
      service.setNativeNotificationTransportAvailable(true);
      expect(await service.deliverTestAlert()).toEqual({ complete: true, nativeAppQueued: false });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(service.alerts.pendingAppNotifications()).toEqual([]);

      expect(service.claimNextAppNotification(1_000)).toBeNull();
      service.setNativeNotificationTransportAvailable(false);
      expect(await service.deliverTestAlert()).toEqual({ complete: true, nativeAppQueued: false });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(service.alerts.pendingAppNotifications()).toEqual([]);

      service.setNativeNotificationTransportAvailable(true);
      expect(await service.deliverTestAlert()).toEqual({ complete: true, nativeAppQueued: true });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(service.alerts.pendingAppNotifications()).toHaveLength(1);
    } finally {
      spawn.mockRestore();
      await service.close();
    }
  });

  test("cancels queued native work when macOS alerts are turned off", async () => {
    const config = notificationConfig();
    const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
    try {
      service.setNativeNotificationTransportAvailable(true);
      expect(service.claimNextAppNotification(1_000)).toBeNull();
      expect(await service.deliverTestAlert()).toEqual({ complete: true, nativeAppQueued: true });
      expect(service.alerts.pendingAppNotifications()).toHaveLength(1);

      config.alerts.macOSNotifications = false;
      expect(service.claimNextAppNotification(2_000)).toBeNull();
      expect(service.alerts.pendingAppNotifications()).toEqual([]);
    } finally {
      await service.close();
    }
  });

  test("cancels pending resume alerts on approval, resume, dismissal, and readiness re-arm", async () => {
    const service = new QuotaPieService(notificationConfig(), new QuotaDatabase(":memory:"));
    const queue = (id: string) => {
      const decision: TriggerDecision = {
        key: `resume:${id}:ready`,
        title: "Ready",
        message: "Quota recovered",
        severity: "info",
      };
      service.alerts.queueMacOSNotification(decision, `test:${id}`, 1_500, 50_000);
    };
    const create = (state: ResumeTaskState) => {
      const id = randomUUID();
      service.resumeTasks.create({
        id,
        taskKey: `task:${id}`,
        provider: "claude",
        account: "default",
        projectLabel: "Project",
        bucket: "five_hour",
        registeredAtMs: 1_000,
        registeredRemainingPercent: 0,
        expectedResetAtMs: 2_000,
      });
      if (state === "ready" || state === "approved") service.resumeTasks.markReady(id, 1_100);
      if (state === "approved") service.resumeTasks.approve(id, 1_200);
      return id;
    };

    try {
      const dismissed = create("waiting");
      queue(dismissed);
      service.dismissResumeTask(dismissed, 2_000);
      expect(service.alerts.pendingAppNotifications()).toEqual([]);

      const resumed = create("approved");
      queue(resumed);
      service.markResumeTaskResumed(resumed, 2_100);
      expect(service.alerts.pendingAppNotifications()).toEqual([]);

      const approved = create("ready");
      queue(approved);
      const internals = service as unknown as {
        hasFreshResumeCapacity: () => boolean;
        buildResumePlan: () => Promise<ResumePlan>;
      };
      internals.hasFreshResumeCapacity = () => true;
      internals.buildResumePlan = async () => ({
        executable: "claude",
        arguments: ["--resume", randomUUID()],
        environment: { CLAUDE_CONFIG_DIR: "/tmp/claude" },
        workingDirectory: "/tmp",
      });
      await service.approveResumeTask(approved, 2_200);
      expect(service.alerts.pendingAppNotifications()).toEqual([]);

      const rearmed = create("ready");
      const key = `resume:${rearmed}:ready`;
      service.alerts.setState(key, 1_000, false, 1_300);
      queue(rearmed);
      await service.updateResumeReadiness([], 2_300);
      expect(service.resumeTasks.get(rearmed)?.state).toBe("waiting");
      expect(service.alerts.pendingAppNotifications()).toEqual([]);
    } finally {
      await service.close();
    }
  });
});
