import { describe, expect, test } from "bun:test";
import { mapClaudeUsage } from "../src/providers/claude-oauth";
import { parseClaudeStatusLine } from "../src/providers/claude-statusline";
import { parseCodexRateLimits } from "../src/providers/codex-appserver";

describe("provider normalization", () => {
  test("normalizes Codex multi-bucket snapshots without account identity", () => {
    const observations = parseCodexRateLimits(
      {
        rateLimitsByLimitId: {
          codex_bengalfox: {
            limitId: "codex_bengalfox",
            primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          },
          codex: {
            limitId: "codex",
            credits: { balance: "12.5", hasCredits: true },
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
          },
        },
        rateLimitResetCredits: { availableCount: 1 },
      },
      1234,
    );
    expect(observations).toHaveLength(3);
    const codex = observations.find((item) => item.bucket === "codex:primary:300");
    const spark = observations.find((item) => item.bucket === "codex_bengalfox:primary:300");
    expect(codex?.resetsAtMs).toBe(1_800_000_000_000);
    expect(codex?.account).toBe("default");
    expect(codex?.resetCreditsAvailable).toBe(1);
    expect(codex?.creditBalance).toBe(12.5);
    expect(spark?.creditBalance).toBeUndefined();
    expect(JSON.stringify(observations)).not.toContain("email");
  });

  test("normalizes Claude official status-line windows", () => {
    const observations = parseClaudeStatusLine(
      {
        session_id: "not-stored",
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 1_800_000_000 },
          seven_day: { used_percentage: 41.2, resets_at: 1_800_600_000 },
          seven_day_opus: { used_percentage: 8, resets_at: 1_800_600_000 },
          seven_day_fable: { used_percentage: 100, resets_at: 1_800_600_000 },
        },
      },
      4321,
    );
    expect(observations.map((item) => item.bucket)).toEqual(["five_hour", "seven_day", "seven_day_opus", "seven_day_fable"]);
    expect(observations[0]?.windowSeconds).toBe(18_000);
    expect(observations[1]?.windowSeconds).toBe(604_800);
    expect(observations[3]?.label).toBe("Claude Fable weekly");
    expect(String(observations[0]?.metadata?.sessionHash)).toHaveLength(16);
    expect(JSON.stringify(observations)).not.toContain("not-stored");
  });

  test("names the Codex 30-day window as monthly", () => {
    const observations = parseCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 0, windowDurationMins: 43_200, resetsAt: 1_800_000_000 },
      },
    });
    expect(observations[0]?.label).toBe("Codex monthly");
  });

  test("does not turn absent Claude limits into fake 0% usage", () => {
    expect(parseClaudeStatusLine({ context_window: { used_percentage: 10 } })).toEqual([]);
  });

  test("uses only the configured local alias for account identity", () => {
    const codex = parseCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 10, windowDurationMins: 300 },
      },
    }, 1_000, "work");
    const claude = parseClaudeStatusLine({
      session_id: "private-session",
      rate_limits: { five_hour: { used_percentage: 20 } },
    }, 1_000, "work");
    expect(codex[0]?.account).toBe("work");
    expect(claude[0]?.account).toBe("work");
    expect(JSON.stringify([...codex, ...claude])).not.toContain("private-session");
  });
});

describe("provider values are normalised at the adapter boundary", () => {
  test("a percentage outside 0..100 is clamped rather than carried into the domain", () => {
    const windows = mapClaudeUsage({
      five_hour: { utilization: 137, resets_at: "2026-12-25T12:00:00.000Z" },
      seven_day: { utilization: -4, resets_at: "2026-12-31T00:00:00.000Z" },
    });
    expect(windows.find((item) => item.bucket === "five_hour")!.usedPercent).toBe(100);
    expect(windows.find((item) => item.bucket === "seven_day")!.usedPercent).toBe(0);
  });

  test("a non-numeric percentage still yields no window", () => {
    expect(mapClaudeUsage({ five_hour: { utilization: Number.NaN } })).toHaveLength(0);
  });
});
