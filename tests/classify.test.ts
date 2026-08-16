import { describe, expect, test } from "bun:test";
import { classifyDelta } from "../src/classify";
import { DEFAULT_CONFIG } from "../src/config";
import type { QuotaObservation } from "../src/types";

const HOUR = 3_600_000;

function observation(overrides: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    provider: "codex",
    account: "default",
    bucket: "codex:primary:300",
    label: "Codex 5h",
    windowSeconds: 5 * 3_600,
    usedPercent: 60,
    resetsAtMs: 5 * HOUR,
    observedAtMs: 0,
    source: "codex-app-server",
    quality: "authoritative",
    ...overrides,
  };
}

describe("classifyDelta", () => {
  test("confirms a scheduled reset only from a provider snapshot", () => {
    const previous = observation();
    const next = observation({ usedPercent: 0, observedAtMs: 5 * HOUR + 30_000, resetsAtMs: 10 * HOUR });
    expect(classifyDelta(previous, next, DEFAULT_CONFIG).map((event) => event.kind)).toContain("scheduled_reset");
  });

  test("recognizes a low-use scheduled reset from the advancing provider clock", () => {
    const previous = observation({ usedPercent: 10 });
    const next = observation({ usedPercent: 0, observedAtMs: 5 * HOUR + 10_000, resetsAtMs: 10 * HOUR });
    const reset = classifyDelta(previous, next, DEFAULT_CONFIG).find((event) => event.kind === "scheduled_reset");
    expect(reset).toBeDefined();
    expect(reset?.confidence).toBe("medium");
  });

  test("detects an early external reset and re-based clock", () => {
    const previous = observation();
    const next = observation({ usedPercent: 2, observedAtMs: 3 * HOUR, resetsAtMs: 8 * HOUR });
    const events = classifyDelta(previous, next, DEFAULT_CONFIG);
    expect(events[0]?.kind).toBe("external_relief");
    expect(events[0]?.confidence).toBe("high");
  });

  test("recognizes a tiny early recharge without requiring a 15% drop", () => {
    const previous = observation({ usedPercent: 2 });
    const next = observation({ usedPercent: 0, observedAtMs: 3 * HOUR, resetsAtMs: 8 * HOUR });
    const recharge = classifyDelta(previous, next, DEFAULT_CONFIG)[0];
    expect(recharge?.kind).toBe("external_relief");
    expect(recharge?.confidence).toBe("low");
  });

  test("does not call a ratio drop with the same reset time a confirmed reset", () => {
    const previous = observation({ usedPercent: 80 });
    const next = observation({ usedPercent: 40, observedAtMs: HOUR, resetsAtMs: 5 * HOUR });
    const events = classifyDelta(previous, next, DEFAULT_CONFIG);
    expect(events[0]?.kind).toBe("allowance_relief");
    expect(events[0]?.summary).toContain("한도 증액");
  });

  test("separates a clock rebase from a recharge", () => {
    const previous = observation({ usedPercent: 20 });
    const next = observation({ usedPercent: 21, observedAtMs: HOUR, resetsAtMs: 6 * HOUR });
    expect(classifyDelta(previous, next, DEFAULT_CONFIG)[0]?.kind).toBe("schedule_rebased");
  });

  test("marks missing provider fields as unknown, never as a reset", () => {
    const events = classifyDelta(
      observation(),
      observation({ usedPercent: null, resetsAtMs: null, observedAtMs: HOUR }),
      DEFAULT_CONFIG,
    );
    expect(events.map((event) => event.kind)).toEqual(["source_unknown"]);
  });

  test("keeps paid credits and banked resets separate", () => {
    const previous = observation({ creditBalance: 10, resetCreditsAvailable: 2 });
    const next = observation({
      observedAtMs: HOUR,
      usedPercent: 65,
      creditBalance: 9.5,
      resetCreditsAvailable: 1,
    });
    const kinds = classifyDelta(previous, next, DEFAULT_CONFIG).map((event) => event.kind);
    expect(kinds).toContain("paid_usage");
    expect(kinds).toContain("banked_reset_consumed");
    expect(kinds).not.toContain("scheduled_reset");
  });
});
