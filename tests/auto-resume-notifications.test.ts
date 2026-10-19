import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { notificationTopic } from "../src/notification-preferences";
import type { WorkExecution } from "../src/work/types";

const resources: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of resources.splice(0)) await close(); });
const incidentID = "quota-resume-fixture";
function fixture(durable = false) {
  const root = durable ? mkdtempSync(join(tmpdir(), "quotapie-auto-notice-")) : null;
  const path = root ? join(root, "test.sqlite3") : ":memory:";
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{id: "plus", label: "Personal", enabled: true, codexHome: null}];
  config.collection.codexEnabled = false; config.collection.claudeOAuthEnabled = false;
  config.resetSignals.enabled = false; config.alerts.command = null;
  config.alerts.enabled = true; config.alerts.macOSNotifications = true;
  config.profile.locale = "ko";
  const state = { accounts: [{account: "plus", label: "Personal", enabled: true, enabledAtMs: 1000,
    lastScanAtMs: 2000, lastError: null as string | null}], incidents: [] as Array<{id:string;account:string;threadId:string;
      projectLabel:string;state:string;reason:string|undefined;detectedAtMs:number;policyId:string}> };
  const executions: WorkExecution[] = [];
  let service: QuotaPieService;
  let restore = () => {};
  const open = () => {
    service = new QuotaPieService(config, new QuotaDatabase(path), {workState:null,quota:null});
    const status = spyOn(service.autoResume, "status").mockImplementation(() => structuredClone(state));
    const records = spyOn(service.work.store, "executions").mockImplementation(id => executions.filter(e => id === undefined || e.policyId === id));
    restore = () => { status.mockRestore(); records.mockRestore(); };
  };
  open();
  resources.push(async () => { restore(); await service.close(); if (root) rmSync(root, {recursive:true,force:true}); });
  return {config,state,executions,get service(){return service;},
    async restart(){ restore(); await service.close(); open(); },
    incident(status = "waiting") { state.incidents = [{id:incidentID,account:"plus",threadId:"private-thread-id",
      projectLabel:"Fixture project",state:status,reason:undefined,detectedAtMs:2000,policyId:incidentID}]; },
    receipt(acknowledged: boolean) { executions.splice(0,executions.length,{id:"execution",policyId:incidentID,status:"dispatched",
      hostQueue:{threadId:"private-thread-id",clientUserMessageId:"private-client-id",sentAtMs:3000,
        ...(acknowledged?{queuedSubmissionId:"queued-id"}:{})}} as WorkExecution); },
  };
}

test("healthy monitoring with no incidents stays quiet and each lifecycle notice uses the existing resume topic", async () => {
  const f = fixture();
  await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);
  f.incident();
  expect(f.service.alerts.hasNativeNotificationConsumer()).toBe(false);
  await f.service.deliverAutoResumeNotifications();
  const first = f.service.alerts.pendingAppNotifications();
  expect(first).toHaveLength(1);
  expect(first[0]?.presentation?.message.key).toBe("alert.resume.auto.waiting.message");
  expect(notificationTopic(first[0]!)).toBe("resumeReady");
  expect(JSON.stringify(first)).not.toMatch(/private-thread|private-client/);
  await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(1);
  const claimed = f.service.claimNextAppNotification()!;
  expect(f.service.completeAppNotification(claimed.id, claimed.claimToken, "scheduled")).toBe(true);
  f.state.incidents[0]!.state = "queued"; f.receipt(false);
  await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);
  f.receipt(true); await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()[0]?.presentation?.message.key).toBe("alert.resume.auto.queued.message");
  expect(f.service.alerts.pendingAppNotifications()[0]?.message).toContain("재개 요청이 접수");
  f.state.incidents[0]!.state = "resumed";
  await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(1);
  expect(f.service.alerts.pendingAppNotifications()[0]?.message).toContain("전체 목표의 완료 여부는 별도로");
});

test("no delivery decisions skip suppression history while cancelling obsolete notices and rearming recovered scans", async () => {
  const f = fixture(); f.incident(); f.state.accounts[0]!.lastError = "scan-unavailable";
  await f.service.deliverAutoResumeNotifications();
  const notices = f.service.alerts.pendingAppNotifications();
  expect(notices).toHaveLength(2);
  const scan = notices.find(item => item.alertKey.startsWith("auto-resume:scan:"))!;
  expect(f.service.alerts.state(scan.alertKey)?.armed).toBe(false);
  f.state.incidents = []; f.state.accounts[0]!.lastError = null;
  const history = spyOn(f.service.alerts, "suppressedThresholdKeys").mockImplementation(() => {
    throw new Error("idle observer must not scan suppression history");
  });
  try {
    for (const retrySuppressed of [false, true]) await f.service.deliverAutoResumeNotifications(retrySuppressed);
    expect(history).not.toHaveBeenCalled();
    expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);
    expect(f.service.alerts.state(scan.alertKey)?.armed).toBe(true);
  } finally { history.mockRestore(); }
});

test("the durable claim prevents restart duplicates and obsolete claimed notifications cannot renew", async () => {
  const f = fixture(true); f.incident();
  await f.service.deliverAutoResumeNotifications();
  const original = f.service.claimNextAppNotification()!;
  await f.restart(); await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications().map(n=>n.id)).toEqual([original.id]);
  f.state.incidents[0]!.state = "needs-review";
  f.state.incidents[0]!.reason = "private-provider-error secret-token";
  expect(f.service.renewAppNotification(original.id,original.claimToken)).toBe(false);
  await f.service.deliverAutoResumeNotifications();
  const notices = f.service.alerts.pendingAppNotifications();
  expect(notices).toHaveLength(1); expect(notices[0]?.severity).toBe("warning");
  expect(notices[0]?.presentation?.message.key).toBe("alert.resume.auto.review.message");
  expect(JSON.stringify(notices)).not.toMatch(/private-provider|secret-token/);
  const review = f.service.claimNextAppNotification()!;
  f.service.completeAppNotification(review.id,review.claimToken,"scheduled");
  await f.restart(); await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);
});

test("an absent native consumer queues once without spawning an osascript fallback", async () => {
  const f = fixture(); f.incident();
  expect(f.service.alerts.hasNativeNotificationConsumer()).toBe(false);
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("unexpected notification subprocess"); });
  const queue = spyOn(f.service.alerts, "queueMacOSNotification");
  try {
    await f.service.deliverAutoResumeNotifications();
    await f.service.deliverAutoResumeNotifications();
    expect(spawn).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledTimes(1);
    expect(f.service.alerts.pendingAppNotifications()).toHaveLength(1);
  } finally { spawn.mockRestore(); queue.mockRestore(); }
});

test("fast queue consumption shares one acceptance notice and requires an actual host receipt", async () => {
  const f = fixture(); f.incident("running"); f.receipt(true);
  await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);
  f.executions[0]!.hostQueue!.turnId = "correlated-turn";
  await f.service.deliverAutoResumeNotifications();
  const running = f.service.alerts.pendingAppNotifications();
  expect(running).toHaveLength(1);
  expect(running[0]?.alertKey).toBe(`auto-resume:incident:${incidentID}:accepted`);
  expect(running[0]?.message).not.toContain("아직 확인되지");
  const claimed = f.service.claimNextAppNotification()!;
  f.service.completeAppNotification(claimed.id, claimed.claimToken, "scheduled");
  f.state.incidents[0]!.state = "queued";
  await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);

  const queued = fixture(); queued.incident("queued"); queued.receipt(true);
  await queued.service.deliverAutoResumeNotifications();
  const pending = queued.service.alerts.pendingAppNotifications()[0]!;
  queued.state.incidents[0]!.state = "running";
  queued.executions[0]!.hostQueue!.turnId = "correlated-turn";
  await queued.service.deliverAutoResumeNotifications();
  expect(queued.service.alerts.pendingAppNotifications().map(n => n.id)).toEqual([pending.id]);
});

test("permission suppression waits for an authorized retry and stale queued states are never replayed", async () => {
  const f = fixture(); f.incident(); await f.service.deliverAutoResumeNotifications();
  const first = f.service.claimNextAppNotification()!;
  f.service.completeAppNotification(first.id,first.claimToken,"suppressed");
  await f.service.deliverAutoResumeNotifications(); await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);
  await f.service.retrySuppressedNotifications();
  const retried = f.service.claimNextAppNotification()!;
  expect(retried.id).not.toBe(first.id);
  f.service.completeAppNotification(retried.id,retried.claimToken,"suppressed");
  f.state.incidents[0]!.state = "resumed";
  await f.service.retrySuppressedNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(1);
  expect(f.service.alerts.pendingAppNotifications()[0]?.presentation?.message.key).toBe("alert.resume.auto.resumed.message");
});

test("global, desktop and resume topic preferences govern the durable outbox", async () => {
  for (const mute of ["global","desktop","topic"] as const) {
    const f = fixture(); f.incident();
    if (mute === "global") f.config.alerts.enabled = false;
    if (mute === "desktop") f.config.alerts.macOSNotifications = false;
    if (mute === "topic") f.config.alerts.topics.resumeReady = false;
    await f.service.deliverAutoResumeNotifications();
    expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);
    f.config.alerts.enabled = true; f.config.alerts.macOSNotifications = true; f.config.alerts.topics.resumeReady = true;
    await f.service.deliverAutoResumeNotifications();
    expect(f.service.alerts.pendingAppNotifications()).toHaveLength(1);
    f.service.applyNotificationPreferences({topics:{resumeReady:false}});
    expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);
    f.state.incidents = []; f.service.applyNotificationPreferences({topics:{resumeReady:true}});
    await f.service.deliverAutoResumeNotifications();
    expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);
  }
});

test("a scan failure notifies once per episode while healthy monitoring only rearms it", async () => {
  const f = fixture(); f.state.accounts[0]!.lastError = "scan-unavailable";
  await f.service.deliverAutoResumeNotifications();
  const first = f.service.claimNextAppNotification()!;
  expect(first.presentation?.message.key).toBe("alert.resume.auto.scanUnavailable.message");
  f.service.completeAppNotification(first.id,first.claimToken,"scheduled");
  f.state.accounts[0]!.lastScanAtMs++; await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);
  f.state.accounts[0]!.lastError = null; await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(0);
  f.state.accounts[0]!.lastError = "scan-unavailable"; await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(1);
});

test("delivery failure is contained and closing cancels a pending observer before database shutdown", async () => {
  const f = fixture(); f.incident();
  const queue = spyOn(f.service.alerts,"queueMacOSNotification").mockImplementation(()=>{throw new Error("fixture delivery failure");});
  await expect(f.service.deliverAutoResumeNotifications()).resolves.toBeUndefined();
  expect(f.state.incidents[0]?.state).toBe("waiting");
  expect(f.service.alerts.state(`auto-resume:incident:${incidentID}:waiting`)?.armed).toBe(true);
  queue.mockRestore(); await f.service.deliverAutoResumeNotifications();
  expect(f.service.alerts.pendingAppNotifications()).toHaveLength(1);
  const deliver = spyOn(f.service,"deliverAutoResumeNotifications");
  (f.service as any).scheduleAutoResumeNotifications();
  f.service.stop(); await Bun.sleep(5);
  expect(deliver).not.toHaveBeenCalled(); deliver.mockRestore();
});
