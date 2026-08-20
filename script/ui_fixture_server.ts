// 메뉴 앱의 다섯 가지 표시 상태를 결정론적으로 재현하기 위한 픽스처 서버.
// 실제 수집을 기다리지 않고 UI를 검증하려고 둔 개발 전용 도구다.
// 사용법: bun run script/ui_fixture_server.ts <state> [port]
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

export const FIXTURES: Record<string, AccountState[]> = {
  // 정상: 위험 없는 두 계정
  normal: [account({ windows: [fiveHour, window()] }), claudeHealthy],
  // 속도 위험: 잔량은 넉넉하지만 갱신 전에 마를 전망
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
  // 수집 지연: 마지막 값은 있으나 오래됨
  stale: [
    account({
      windows: [window({ freshness: "stale" })],
      sources: [source({ health: "stale-success", lastSuccessAtMs: NOW - 3_600_000 })],
    }),
    claudeHealthy,
  ],
  // 수집 실패: 로그인이 필요한 계정
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
  // 데이터 없음: 계정은 켜져 있으나 한 번도 수집하지 않음
  "no-data": [
    account({
      windows: [],
      sources: [source({ health: "never-attempted", lastAttemptAtMs: null, lastSuccessAtMs: null })],
    }),
  ],
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
