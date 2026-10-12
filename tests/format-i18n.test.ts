import { describe, expect, test } from "bun:test";
import {
  compactClaudeLine,
  formatDuration,
  formatEvents,
  formatStatuses,
} from "../src/format";
import type { QuotaEvent, WindowAnalysis } from "../src/types";
import { analyzeWindow, groupStatuses } from "../src/analytics";
import { DEFAULT_CONFIG } from "../src/config";

describe("localized text formatters", () => {
  test("status text opts into speed analysis and uses reserve timing independently of exhaustion", () => {
    const now = Date.UTC(2026, 8, 15, 12);
    const observation = { provider: "claude" as const, account: "default", bucket: "weekly", label: "Claude weekly",
      windowSeconds: 604800, source: "claude-statusline", quality: "authoritative" as const,
      observedAtMs: now, usedPercent: 20, resetsAtMs: now + 4 * 3_600_000 };
    const window: WindowAnalysis = { ...analyzeWindow(observation, [observation], DEFAULT_CONFIG, now),
      blendedBurnPerHour: 30, personalBurnPerHour: 20, paceRatio: 2,
      reserveReachesAtMs: now + 3_600_000, reserveMinutesBeforeReset: 180,
      exhaustsAtMs: now + 2 * 3_600_000, minutesBeforeReset: 120 };
    for (const locale of ["en", "ko"] as const) {
      for (const flag of [undefined, false]) {
        window.showUsageSpeed = flag;
        const output = formatStatuses(groupStatuses([window]), locale);
        expect(output).toContain("80");
        expect(output).toContain("claude-statusline");
        expect(output).toContain(locale === "ko" ? "공급자 리셋" : "provider reset");
        expect(output).not.toContain(locale === "ko" ? "소모" : "burn");
        expect(output).not.toContain(locale === "ko" ? "안전 여유" : "safe reserve");
        expect(compactClaudeLine([window], "Main", locale)).not.toContain("2.0×");
      }
      window.showUsageSpeed = true;
      const output = formatStatuses(groupStatuses([window]), locale);
      expect(output).toContain(locale === "ko" ? "소모 30.0" : "burn 30.0");
      expect(output).toContain(locale === "ko" ? "리셋 3시간 0분 전" : "3h 0m before reset");
      const reserveStamp = new Date(now + 3_600_000).toLocaleString(locale === "ko" ? "ko-KR" : "en-US",
        { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      expect(output).toContain(reserveStamp);
      expect(compactClaudeLine([window], "Main", locale)).toContain("2.0×");
      window.reserveMinutesBeforeReset = null;
      expect(formatStatuses(groupStatuses([window]), locale)).not.toContain(locale === "ko" ? "안전 여유" : "safe reserve");
      window.reserveMinutesBeforeReset = 180;
    }
  });

  test("durations and empty states follow the requested locale", () => {
    expect(formatDuration(90 * 60_000, "en")).toBe("1h 30m");
    expect(formatDuration(90 * 60_000, "ko")).toBe("1시간 30분");
    expect(formatStatuses([], "ko")).toContain("아직 한도 관측값이 없습니다");
    expect(formatEvents([], "ko")).toBe("기록된 이벤트가 없습니다.");
    expect(compactClaudeLine([], undefined, "ko")).toBe("⏱ Claude 한도: 첫 API 응답 대기 중");
  });

  test("event history re-renders semantic event data instead of stored prose", () => {
    const event: QuotaEvent = {
      provider: "codex",
      account: "main",
      bucket: "weekly",
      kind: "first_observation",
      severity: "info",
      occurredAtMs: Date.UTC(2026, 8, 1),
      confidence: "high",
      displayText: "This stored English sentence must not leak.",
      details: { label: "주간 한도" },
    };

    const rendered = formatEvents([event], "ko");
    expect(rendered).toContain("[정보]");
    expect(rendered).toContain("주간 한도 관측을 시작했습니다.");
    expect(rendered).not.toContain(event.displayText);
  });

  test("legacy events without semantic details keep their compatibility text", () => {
    const event: QuotaEvent = {
      provider: "codex",
      account: "main",
      bucket: "weekly",
      kind: "external_relief",
      severity: "info",
      occurredAtMs: Date.UTC(2026, 8, 1),
      confidence: "high",
      displayText: "Legacy event text",
      details: {},
    };

    expect(formatEvents([event], "ko")).toContain("Legacy event text");
    expect(formatEvents([event], "ko")).not.toContain("undefined");
  });
});
