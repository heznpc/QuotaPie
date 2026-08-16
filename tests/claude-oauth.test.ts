import { describe, expect, test } from "bun:test";
import { mapClaudeUsage } from "../src/providers/claude-oauth";

// 픽스처는 CodexBar가 실측으로 기록한 공식 usage 응답 형식 두 가지를 따른다:
// 구형 flat 필드와, 2026-07 이후의 limits 배열(weekly_scoped) 혼합형.

describe("claude oauth usage mapping", () => {
  test("maps flat five_hour/seven_day fields to statusline-compatible buckets", () => {
    const observations = mapClaudeUsage({
      five_hour: { utilization: 12.5, resets_at: "2026-12-25T12:00:00.000Z" },
      seven_day: { utilization: 30, resets_at: "2026-12-31T00:00:00.000Z" },
      seven_day_sonnet: { utilization: 5 },
    }, "default", 1_000);
    expect(observations).toHaveLength(3);
    const fiveHour = observations.find((item) => item.bucket === "five_hour")!;
    expect(fiveHour.usedPercent).toBe(12.5);
    expect(fiveHour.resetsAtMs).toBe(Date.parse("2026-12-25T12:00:00.000Z"));
    expect(fiveHour.label).toBe("Claude 5h");
    expect(fiveHour.windowSeconds).toBe(5 * 3_600);
    expect(fiveHour.source).toBe("claude-oauth");
    const sonnet = observations.find((item) => item.bucket === "seven_day_sonnet")!;
    expect(sonnet.usedPercent).toBe(5);
    expect(sonnet.resetsAtMs).toBeNull();
  });

  test("null flat weeklies fall through to the limits array without duplicating filled buckets", () => {
    const observations = mapClaudeUsage({
      five_hour: { utilization: 11, resets_at: "2026-07-03T00:30:00.282668+00:00" },
      seven_day: { utilization: 9, resets_at: "2026-07-08T09:00:00.282694+00:00" },
      seven_day_opus: null,
      limits: [
        { kind: "session", group: "session", percent: 99, resets_at: "2026-07-03T00:30:00.282668+00:00", scope: null, is_active: true },
        { kind: "weekly_all", group: "weekly", percent: 88, resets_at: "2026-07-08T09:00:00.282694+00:00", scope: null, is_active: false },
        {
          kind: "weekly_scoped", group: "weekly", percent: 5,
          resets_at: "2026-07-08T09:00:00.283070+00:00",
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
          is_active: false,
        },
      ],
    }, "default", 1_000);
    // flat이 이미 채운 five_hour/seven_day는 limits의 99/88이 덮어쓰지 못한다.
    expect(observations.find((item) => item.bucket === "five_hour")!.usedPercent).toBe(11);
    expect(observations.find((item) => item.bucket === "seven_day")!.usedPercent).toBe(9);
    const fable = observations.find((item) => item.bucket === "seven_day_fable")!;
    expect(fable.usedPercent).toBe(5);
    expect(fable.windowSeconds).toBe(7 * 86_400);
  });

  test("garbage payloads produce no observations", () => {
    expect(mapClaudeUsage(null)).toHaveLength(0);
    expect(mapClaudeUsage("nope")).toHaveLength(0);
    expect(mapClaudeUsage({ five_hour: { utilization: "high" } })).toHaveLength(0);
    expect(mapClaudeUsage({ limits: [{ kind: "session" }] })).toHaveLength(0);
  });
});
