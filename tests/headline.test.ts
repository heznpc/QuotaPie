import { describe, expect, test } from "bun:test";
import { buildHeadline, windowShortLabel } from "../src/analytics";
import type { AccountState, CollectionSourceState, WindowAnalysis } from "../src/types";

const NOW = 1_700_000_000_000;

function window(overrides: Partial<WindowAnalysis> = {}): WindowAnalysis {
  return {
    provider: "codex",
    account: "default",
    bucket: "codex:primary:10080",
    label: "Codex weekly",
    windowSeconds: 604_800,
    source: "codex-appserver",
    quality: "authoritative",
    freshness: "fresh",
    observedAtMs: NOW - 1_000,
    usedPercent: 10,
    remainingPercent: 90,
    resetsAtMs: NOW + 7 * 86_400_000,
    timeToResetMs: 7 * 86_400_000,
    reservePercent: 15,
    recentBurnPerHour: 5,
    personalBurnPerHour: 5,
    blendedBurnPerHour: 5,
    safePacePerActiveHour: 0.66,
    paceRatio: 1,
    exhaustsAtMs: null,
    minutesBeforeReset: null,
    confidence: "high",
    sampleCount: 900,
    activeHoursUntilReset: 60,
    bottleneckScore: 0.1,
    riskLevel: "none",
    ...overrides,
  };
}

type AccountOverrides = Partial<Omit<AccountState, "collection">> & { sources?: CollectionSourceState[] };

function account(overrides: AccountOverrides = {}): AccountState {
  const windows = overrides.windows ?? [window()];
  const sources: CollectionSourceState[] = overrides.sources ?? [{
    source: "codex-appserver",
    health: "recent-success",
    lastAttemptAtMs: NOW - 1_000,
    lastSuccessAtMs: NOW - 1_000,
    errorCategory: null,
    errorDetail: null,
  }];
  return {
    provider: "codex",
    account: "default",
    accountLabel: "Main",
    enabled: true,
    windows,
    bottleneckBucket: windows[0]?.bucket ?? null,
    updatedAtMs: NOW - 1_000,
    ...overrides,
    collection: {
      health: sources[0]!.health,
      activeSource: sources[0]!.lastSuccessAtMs != null ? sources[0]!.source : null,
      lastSuccessAtMs: sources[0]!.lastSuccessAtMs,
      errorCategory: sources.find((item) => item.errorCategory != null)?.errorCategory ?? null,
      errorDetail: sources.find((item) => item.errorDetail != null)?.errorDetail ?? null,
      sources,
    },
  };
}

describe("menu bar headline", () => {
  // The contradiction measured in production: 90% remaining looked healthy
  // while a 7.57x pace put it six days short of the reset.
  test("high remaining with a projected shortfall is a risk headline, not a healthy percentage", () => {
    const headline = buildHeadline([account({
      windows: [window({
        usedPercent: 10,
        remainingPercent: 90,
        paceRatio: 7.57,
        exhaustsAtMs: NOW + 86_400_000,
        minutesBeforeReset: 6 * 24 * 60,
        riskLevel: "at-risk",
        bottleneckScore: 2.1,
      })],
    })], NOW);
    expect(headline.kind).toBe("pace-risk");
    // The semantic fields are the contract; the sentence is a rendering of them.
    expect(headline.windowKind).toBe("weekly");
    expect(headline.bucket).toBe("codex:primary:10080");
    expect(headline.remainingPercent).toBe(90);
    expect(headline.displayText).toBe("⚠ weekly at risk");
    expect(headline.displayText).not.toContain("90");
  });

  // The other direction: little left is not a risk when the reset is close.
  test("low remaining that resets soon stays a normal headline", () => {
    const headline = buildHeadline([account({
      windows: [window({
        usedPercent: 90,
        remainingPercent: 10,
        resetsAtMs: NOW + 10 * 60_000,
        timeToResetMs: 10 * 60_000,
        paceRatio: 0.2,
        riskLevel: "none",
      })],
    })], NOW);
    expect(headline.kind).toBe("normal");
    expect(headline.remainingPercent).toBe(10);
    expect(headline.displayText).toBe("10% left");
  });

  test("a riskier account outranks a healthier one with less remaining", () => {
    const healthy = account({
      windows: [window({ bucket: "codex:primary:300", usedPercent: 95, remainingPercent: 5, riskLevel: "none" })],
    });
    const risky = account({
      provider: "claude",
      accountLabel: "Main",
      windows: [window({
        provider: "claude",
        bucket: "seven_day",
        label: "Claude weekly",
        usedPercent: 40,
        remainingPercent: 60,
        paceRatio: 3,
        minutesBeforeReset: 4_320,
        exhaustsAtMs: NOW + 3 * 86_400_000,
        riskLevel: "at-risk",
        bottleneckScore: 1.8,
      })],
      sources: [{
          source: "claude-oauth",
          health: "recent-success",
          lastAttemptAtMs: NOW - 500,
          lastSuccessAtMs: NOW - 500,
          errorCategory: null,
          errorDetail: null,
        }],
    });
    const headline = buildHeadline([healthy, risky], NOW);
    expect(headline.kind).toBe("pace-risk");
    expect(headline.provider).toBe("claude");
  });

  test("a login-less account reports setup instead of claiming everything is fine", () => {
    const headline = buildHeadline([account({
      provider: "claude",
      windows: [],
      sources: [{
          source: "claude-oauth",
          health: "attempted-then-failed",
          lastAttemptAtMs: NOW - 500,
          lastSuccessAtMs: null,
          errorCategory: "auth-required",
          errorDetail: "no Claude login found",
        }],
    })], NOW);
    expect(headline.kind).toBe("setup");
    expect(headline.errorCategory).toBe("auth-required");
    expect(headline.displayText).toBe("Setup needed");
    expect(headline.displayDetail).toContain("Sign-in required");
  });

  test("stale collection on a tracked account reports delay rather than its last number", () => {
    const headline = buildHeadline([account({
      sources: [{
          source: "codex-appserver",
          health: "stale-success",
          lastAttemptAtMs: NOW - 900_000,
          lastSuccessAtMs: NOW - 900_000,
          errorCategory: null,
          errorDetail: null,
        }],
    })], NOW);
    expect(headline.kind).toBe("degraded");
    expect(headline.displayText).toBe("Limits unconfirmed");
  });

  test("no configured accounts still yields an honest setup headline", () => {
    const headline = buildHeadline([], NOW);
    expect(headline.kind).toBe("setup");
    expect(headline.provider).toBeNull();
  });

  test("short labels collapse window lengths for the title", () => {
    expect(windowShortLabel(window())).toBe("weekly");
    expect(windowShortLabel(window({ windowSeconds: 18_000 }))).toBe("5-hour");
  });

  test("the same conclusion renders in whichever locale is asked for", () => {
    const risky = [account({
      windows: [window({
        usedPercent: 10,
        remainingPercent: 90,
        paceRatio: 7.57,
        exhaustsAtMs: NOW + 86_400_000,
        minutesBeforeReset: 6 * 24 * 60,
        riskLevel: "at-risk",
        bottleneckScore: 2.1,
      })],
    })];
    const english = buildHeadline(risky, NOW, "en");
    const korean = buildHeadline(risky, NOW, "ko");
    // Same meaning, different sentence.
    expect(korean.kind).toBe(english.kind);
    expect(korean.windowKind).toBe(english.windowKind);
    expect(korean.remainingPercent).toBe(english.remainingPercent);
    expect(english.displayText).toBe("⚠ weekly at risk");
    expect(korean.displayText).toBe("⚠ 주간 위험");
  });
});

describe("window short labels", () => {
  test("a monthly window is not swallowed by the weekly branch", () => {
    expect(windowShortLabel(window({ windowSeconds: 30 * 86_400 }))).toBe("monthly");
    expect(windowShortLabel(window({ windowSeconds: 28 * 86_400 }))).toBe("monthly");
    expect(windowShortLabel(window({ windowSeconds: 7 * 86_400 }))).toBe("weekly");
    expect(windowShortLabel(window({ windowSeconds: 30 * 86_400 }), "ko")).toBe("월간");
  });

  test("an unknown window length keeps the provider's own label", () => {
    expect(windowShortLabel(window({ windowSeconds: 2 * 86_400, label: "Codex 2일" }))).toBe("Codex 2일");
    expect(windowShortLabel(window({ windowSeconds: null, label: "Codex 43200m" }))).toBe("Codex 43200m");
  });
});
