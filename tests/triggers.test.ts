import { describe, expect, spyOn, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { alertScope, deliverTrigger, planTriggers } from "../src/triggers";
import type { QuotaEvent, WindowAnalysis } from "../src/types";

function window(overrides: Partial<WindowAnalysis> = {}): WindowAnalysis {
  return {
    provider: "codex",
    account: "default",
    bucket: "codex:primary:300",
    label: "Codex 5h",
    windowSeconds: 18_000,
    source: "test",
    quality: "authoritative",
    freshness: "fresh",
    observedAtMs: 0,
    usedPercent: 96,
    remainingPercent: 4,
    resetsAtMs: 10_000,
    timeToResetMs: 10_000,
    reservePercent: 10,
    recentBurnPerHour: 10,
    personalBurnPerHour: 10,
    blendedBurnPerHour: 10,
    safePacePerActiveHour: 5,
    paceRatio: 2,
    exhaustsAtMs: 5_000,
    minutesBeforeReset: 60,
    confidence: "medium",
    sampleCount: 10,
    activeHoursUntilReset: 1,
    bottleneckScore: 2,
    riskLevel: "none",
    ...overrides,
  };
}

describe("trigger planning and claims", () => {
  test("preserves default alert keys and separates non-default account cooldowns", () => {
    expect(alertScope("codex", "default", "x")).toBe("codex:x");
    expect(alertScope("codex", "work", "x")).toBe("codex:work:x");
    const decisions = planTriggers(
      [window(), window({ account: "work" })],
      [],
      DEFAULT_CONFIG,
      0,
      1_000,
    );
    expect(decisions.map((decision) => decision.key)).toContain("codex:codex:primary:300:remaining:5");
    expect(decisions.map((decision) => decision.key)).toContain("codex:work:codex:primary:300:remaining:5");
  });

  test("suppresses old remaining and pace alerts while reset confirmation is due", () => {
    const decisions = planTriggers(
      [window({ freshness: "reset_due", resetsAtMs: 1_000 })],
      [],
      DEFAULT_CONFIG,
      0,
      2_000,
    );
    expect(decisions).toEqual([]);
  });

  test("does not page on expected Claude idle staleness", () => {
    const decisions = planTriggers(
      [window({ provider: "claude", freshness: "stale", bucket: "five_hour" })],
      [],
      DEFAULT_CONFIG,
      0,
      20_000,
    );
    expect(decisions).toEqual([]);
  });

  test("durably claims and coalesces event alerts by cooldown", () => {
    const db = new QuotaDatabase(":memory:");
    const first: QuotaEvent = {
      provider: "codex" as const,
      account: "default",
      bucket: "x",
      kind: "paid_usage" as const,
      severity: "warning" as const,
      occurredAtMs: 1_000,
      confidence: "high" as const,
      summary: "paid",
      details: {},
    };
    expect(db.insertEvent(first)).toBeTrue();
    const firstClaim = db.claimEventAlert(first.id!, "event:codex:x:paid_usage", 1_000, 30_000);
    expect(firstClaim).not.toBeNull();
    expect(db.completeEventAlert(first.id!, "event:codex:x:paid_usage", firstClaim!, 1_000)).toBeTrue();
    const second: QuotaEvent = { ...first, id: undefined, occurredAtMs: 2_000 };
    expect(db.insertEvent(second)).toBeTrue();
    expect(db.claimEventAlert(second.id!, "event:codex:x:paid_usage", 2_000, 30_000)).toBeNull();
    expect(db.pendingAlertEvents()).toEqual([]);
    db.close();
  });

  test("serializes same-category events and protects a reclaimed lease with CAS", () => {
    const db = new QuotaDatabase(":memory:");
    const event = (at: number): QuotaEvent => ({
      provider: "codex",
      account: "default",
      bucket: "x",
      kind: "schedule_rebased",
      severity: "info",
      occurredAtMs: at,
      confidence: "high",
      summary: "rebase",
      details: {},
    });
    const first = event(1_000);
    const second = event(2_000);
    db.insertEvent(first);
    db.insertEvent(second);
    const staleToken = db.claimEventAlert(first.id!, "event:codex:x:schedule_rebased", 1_000, 0, 5_000);
    expect(staleToken).not.toBeNull();
    expect(db.claimEventAlert(second.id!, "event:codex:x:schedule_rebased", 2_000, 0, 5_000)).toBeNull();
    const currentToken = db.claimEventAlert(first.id!, "event:codex:x:schedule_rebased", 6_001, 0, 5_000);
    expect(currentToken).not.toBeNull();
    expect(db.releaseEventAlert(first.id!, "event:codex:x:schedule_rebased", staleToken!)).toBeFalse();
    expect(db.completeEventAlert(first.id!, "event:codex:x:schedule_rebased", currentToken!, 6_100)).toBeTrue();
    db.close();
  });

  test("keeps a completed threshold disarmed until explicit recovery", () => {
    const db = new QuotaDatabase(":memory:");
    const firstClaim = db.claimAlert("codex:x:remaining:5", 1_000, 0);
    expect(firstClaim).not.toBeNull();
    expect(db.completeAlertClaim("codex:x:remaining:5", firstClaim!.token, 1_000)).toBeTrue();
    expect(db.claimAlert("codex:x:remaining:5", 2_000, 0)).toBeNull();
    db.setAlertState("codex:x:remaining:5", 1_000, true);
    expect(db.claimAlert("codex:x:remaining:5", 2_000, 0)).not.toBeNull();
    db.close();
  });

  test("reclaims a threshold after a crashed delivery lease expires", () => {
    const db = new QuotaDatabase(":memory:");
    const staleToken = db.claimAlert("codex:x:remaining:5", 1_000, 0, 5_000);
    expect(staleToken).not.toBeNull();
    expect(db.claimAlert("codex:x:remaining:5", 2_000, 0, 5_000)).toBeNull();
    const currentToken = db.claimAlert("codex:x:remaining:5", 6_001, 0, 5_000);
    expect(currentToken).not.toBeNull();
    expect(db.releaseAlertClaim("codex:x:remaining:5", staleToken!.token)).toBeFalse();
    expect(db.completeAlertClaim("codex:x:remaining:5", currentToken!.token, 6_100)).toBeTrue();
    db.close();
  });

  test("clears partial channel delivery state when a threshold recovers", () => {
    const db = new QuotaDatabase(":memory:");
    const key = "codex:x:remaining:5";
    const claim = db.claimAlert(key, 1_000, 0);
    expect(claim).not.toBeNull();
    const deliveryKey = `threshold:${key}:${claim!.generation}`;
    db.markChannelDelivered(deliveryKey, "macos-notification", 1_100);
    db.releaseAlertClaim(key, claim!.token);
    expect(db.deliveredChannels(deliveryKey)).toEqual(["macos-notification"]);
    db.setAlertState(key, 0, true);
    expect(db.deliveredChannels(deliveryKey)).toEqual([]);
    const nextClaim = db.claimAlert(key, 2_000, 0);
    expect(nextClaim?.generation).toBe(claim!.generation + 1);
    db.close();
  });

  test("a missing custom executable reports failure instead of throwing", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
    const config = structuredClone(DEFAULT_CONFIG);
    config.alerts.macOSNotifications = false;
    config.alerts.command = ["/definitely/not/a/timequota-command"];
    const delivered = await deliverTrigger(
      { key: "test", title: "test", message: "test", severity: "info" },
      config,
    );
    expect(delivered.complete).toBeFalse();
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  test("a non-zero custom trigger exit is logged and not marked delivered", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
    const config = structuredClone(DEFAULT_CONFIG);
    config.alerts.macOSNotifications = false;
    config.alerts.command = ["/usr/bin/false"];
    const delivered = await deliverTrigger(
      { key: "test", title: "test", message: "test", severity: "info" },
      config,
    );
    expect(delivered.complete).toBeFalse();
    expect(errorLog.mock.calls.flat().join(" ")).toContain("code 1");
    errorLog.mockRestore();
  });

  test("does not execute a channel that was already durably delivered", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.alerts.macOSNotifications = false;
    config.alerts.command = ["/usr/bin/false"];
    const result = await deliverTrigger(
      { key: "test", title: "test", message: "test", severity: "info" },
      config,
      ["command"],
      "threshold:test",
    );
    expect(result.complete).toBeTrue();
    expect(result.succeededChannels).toEqual([]);
  });

  test("times out a stuck custom trigger instead of blocking the watch loop", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => undefined);
    const config = structuredClone(DEFAULT_CONFIG);
    config.alerts.macOSNotifications = false;
    config.alerts.command = ["/bin/sleep", "5"];
    config.alerts.deliveryTimeoutSeconds = 1;
    const started = performance.now();
    const result = await deliverTrigger(
      { key: "test", title: "test", message: "test", severity: "info" },
      config,
    );
    expect(result.complete).toBeFalse();
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(errorLog.mock.calls.flat().join(" ")).toContain("timed out");
    errorLog.mockRestore();
  });
});

describe("pace alert honesty", () => {
  test("suppresses pace alert when recent actual burn is zero", () => {
    const decisions = planTriggers(
      [window({
        usedPercent: 66,
        remainingPercent: 34,
        recentBurnPerHour: 0,
        personalBurnPerHour: 1.8,
        blendedBurnPerHour: 1.8,
        paceRatio: 5.46,
        minutesBeforeReset: 4_080,
      })],
      [],
      DEFAULT_CONFIG,
      0,
      1_000,
    );
    expect(decisions.filter((decision) => decision.key.endsWith(":pace"))).toHaveLength(0);
  });

  test("uses forecast wording when only habit pattern exceeds pace, current wording when measured burn does", () => {
    const habitOnly = planTriggers(
      [window({ recentBurnPerHour: 2, safePacePerActiveHour: 5, blendedBurnPerHour: 9, paceRatio: 1.8 })],
      [], DEFAULT_CONFIG, 0, 1_000,
    ).find((decision) => decision.key.endsWith(":pace"));
    expect(habitOnly?.title).toContain("패턴 전망");
    expect(habitOnly?.message).toContain("이 패턴이면");

    const measured = planTriggers(
      [window({ recentBurnPerHour: 12, safePacePerActiveHour: 5, blendedBurnPerHour: 10, paceRatio: 2 })],
      [], DEFAULT_CONFIG, 0, 1_000,
    ).find((decision) => decision.key.endsWith(":pace"));
    expect(measured?.title).toContain("사용 속도 과열");
  });
});
