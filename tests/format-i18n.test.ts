import { describe, expect, test } from "bun:test";
import {
  compactClaudeLine,
  formatDuration,
  formatEvents,
  formatStatuses,
} from "../src/format";
import type { QuotaEvent } from "../src/types";

describe("localized text formatters", () => {
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
