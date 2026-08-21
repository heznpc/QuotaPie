// A fixture server that reproduces the menu bar app's display states
// deterministically. Development only: it exists so the UI can be verified
// without waiting for real collection.
// Usage: bun run script/ui_fixture_server.ts <state> [port]
import { buildHeadline } from "../src/analytics";
import type { AccountState, CollectionSourceState, WindowAnalysis } from "../src/types";

const NOW = Date.now();

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
    observedAtMs: NOW - 30_000,
    usedPercent: 31,
    remainingPercent: 69,
    resetsAtMs: NOW + 7 * 86_400_000,
    timeToResetMs: 7 * 86_400_000,
    reservePercent: 15,
    recentBurnPerHour: 0.4,
    personalBurnPerHour: 0.5,
    blendedBurnPerHour: 0.45,
    safePacePerActiveHour: 0.9,
    paceRatio: 0.5,
    exhaustsAtMs: null,
    minutesBeforeReset: null,
    confidence: "high",
    sampleCount: 400,
    activeHoursUntilReset: 60,
    bottleneckScore: 0.31,
    riskLevel: "none",
    ...overrides,
  };
}

function source(overrides: Partial<CollectionSourceState> = {}): CollectionSourceState {
  return {
    source: "codex-appserver",
    health: "recent-success",
    lastAttemptAtMs: NOW - 30_000,
    lastSuccessAtMs: NOW - 30_000,
    errorCategory: null,
    errorDetail: null,
    ...overrides,
  };
}

function account(
  overrides: Partial<Omit<AccountState, "collection">> & { sources?: CollectionSourceState[] } = {},
): AccountState {
  const { sources: overrideSources, ...rest } = overrides;
  const windows = rest.windows ?? [window()];
  const sources = overrideSources ?? [source()];
  return {
    provider: "codex",
    account: "default",
    accountLabel: "Main",
    enabled: true,
    bottleneckBucket: windows[0]?.bucket ?? null,
    updatedAtMs: windows.length ? Math.max(...windows.map((item) => item.observedAtMs)) : null,
    ...rest,
    windows,
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

const fiveHour = window({
  bucket: "codex:primary:300",
  label: "Codex 5h",
  windowSeconds: 18_000,
  usedPercent: 44,
  remainingPercent: 56,
  resetsAtMs: NOW + 77 * 60_000,
  timeToResetMs: 77 * 60_000,
  bottleneckScore: 0.44,
});

const claudeHealthy = account({
  provider: "claude",
  windows: [window({
    provider: "claude",
    bucket: "seven_day",
    label: "Claude weekly",
    usedPercent: 62,
    remainingPercent: 38,
    bottleneckScore: 0.62,
  })],
  sources: [source({ source: "claude-oauth" })],
});

function overflowAccount(index: number): AccountState {
  const provider = index % 2 === 0 ? "codex" as const : "claude" as const;
  const accountId = `debug-${index + 1}`;
  const windows = [
    window({
      provider,
      account: accountId,
      bucket: provider === "codex" ? "codex:primary:300" : "five_hour",
      label: `${provider} 5h`,
      windowSeconds: 18_000,
      usedPercent: 20 + index,
      remainingPercent: 80 - index,
    }),
    window({
      provider,
      account: accountId,
      bucket: provider === "codex" ? "codex:primary:10080" : "seven_day",
      label: `${provider} weekly`,
      usedPercent: 50 + index,
      remainingPercent: 50 - index,
    }),
  ];
  return account({
    provider,
    account: accountId,
    accountLabel: `Debug ${index + 1}`,
    windows,
    sources: [source({ source: provider === "codex" ? "codex-appserver" : "claude-oauth" })],
  });
}

export const FIXTURES: Record<string, AccountState[]> = {
  // Normal: two accounts, no risk.
  normal: [account({ windows: [fiveHour, window()] }), claudeHealthy],
  // Pace risk: plenty remaining, but projected to run dry before the reset.
  "pace-risk": [
    account({
      windows: [fiveHour, window({
        usedPercent: 11,
        remainingPercent: 89,
        paceRatio: 7.94,
        exhaustsAtMs: NOW + 86_400_000,
        minutesBeforeReset: 8_742,
        riskLevel: "at-risk",
        bottleneckScore: 2.1,
      })],
    }),
    claudeHealthy,
  ],
  // Collection delayed: a last value exists, but it has gone stale.
  stale: [
    account({
      windows: [window({ freshness: "stale" })],
      sources: [source({ health: "stale-success", lastSuccessAtMs: NOW - 3_600_000 })],
    }),
    claudeHealthy,
  ],
  // Collection failed: an account that needs a login.
  failed: [
    account({ windows: [fiveHour, window()] }),
    account({
      provider: "claude",
      windows: [],
      sources: [source({
        source: "claude-oauth",
        health: "attempted-then-failed",
        lastSuccessAtMs: null,
        errorCategory: "auth-required",
        errorDetail: "no Claude login found — run `claude auth login` in a terminal",
      })],
    }),
  ],
  // No data: the account is enabled but has never been collected from.
  "no-data": [
    account({
      windows: [],
      sources: [source({ health: "never-attempted", lastAttemptAtMs: null, lastSuccessAtMs: null })],
    }),
  ],
  // Long list: check that only the body scrolls while the header and the
  // action bar stay pinned.
  overflow: Array.from({ length: 6 }, (_, index) => overflowAccount(index)),
};

const state = process.argv[2] ?? "normal";
const port = Number(process.argv[3] ?? 47_899);
const accounts = FIXTURES[state];
if (!accounts) {
  console.error(`unknown state: ${state} (have ${Object.keys(FIXTURES).join(", ")})`);
  process.exit(2);
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/status") return new Response("not found", { status: 404 });
    return new Response(
      JSON.stringify({
        nowMs: Date.now(),
        headline: buildHeadline(accounts, Date.now()),
        accounts,
        statuses: [],
        events: [],
      }),
      { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
    );
  },
});
console.log(`fixture ${state} on http://127.0.0.1:${port}`);
