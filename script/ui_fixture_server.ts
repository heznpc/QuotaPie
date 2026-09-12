// A fixture server that reproduces the menu bar app's display states
// deterministically. Development only: it exists so the UI can be verified
// without waiting for real collection.
// Usage: bun run script/ui_fixture_server.ts <state> [port]
import { buildHeadline } from "../src/analytics";
import type { AccountState, CollectionSourceState, WindowAnalysis } from "../src/types";

const NOW = Date.now();
const ACTION_TOKEN = "quotapie-fixture-action-token";
const CODEX_SESSION_ID = "2f269ad7-8463-4e25-b8a0-79aba5fd87ab";
const CLAUDE_SESSION_ID = "5fe1279c-1ab6-48ee-aa10-e07237646039";
const NOTIFICATION_ID = "f87f827d-7697-4507-bb3e-19e0f955dc25";
const NOTIFICATION_CLAIM = "quotapie-fixture-notification-claim";

type FixtureResumeTask = {
  id: string;
  provider: "codex" | "claude";
  account: string;
  accountLabel: string;
  projectLabel: string;
  state: "waiting" | "ready" | "approved";
  registeredAtMs: number;
  expectedResetAtMs: number | null;
  readyAtMs: number | null;
  errorDetail: string | null;
};

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
  // Compact overview: general quota leads over the separate Spark allowance.
  overview: [account({ windows: [window({ usedPercent: 86, remainingPercent: 14 }),
    window({ bucket: "codex_bengalfox:primary:300", label: "Spark 5h", windowSeconds: 18000,
      usedPercent: 0, remainingPercent: 100 })] }), claudeHealthy],
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
  "stale-zero": [account({ windows: [window({remainingPercent:0, usedPercent:100, freshness:"stale", windowSeconds:18000,
    bucket:"codex:primary:300", label:"Codex 5h"})], sources:[source({health:"stale-success", lastSuccessAtMs:NOW-900_000})] })],
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
  // Paused-work fixtures keep the normal quota rows beneath the new section.
  "resume-waiting": [account({ windows: [fiveHour, window()] }), claudeHealthy],
  "resume-ready": [account({ windows: [fiveHour, window()] }), claudeHealthy],
  // Native notification: exercise claim, UserNotifications scheduling, and ack.
  notification: [account({ windows: [fiveHour, window()] }), claudeHealthy],
};

function waitingTask(): FixtureResumeTask {
  return {
    id: "6a0422b9-e0f3-4899-905c-960a3d09eebd",
    provider: "claude",
    account: "work",
    accountLabel: "Work",
    projectLabel: "QuotaPie docs",
    state: "waiting",
    registeredAtMs: NOW - 45 * 60_000,
    expectedResetAtMs: NOW + 75 * 60_000,
    readyAtMs: null,
    errorDetail: null,
  };
}

function readyTask(): FixtureResumeTask {
  return {
    id: "81f249fc-eb21-4e6c-8f36-c4037387aeaf",
    provider: "codex",
    account: "default",
    accountLabel: "Main",
    projectLabel: "QuotaPie",
    state: "ready",
    registeredAtMs: NOW - 6 * 3_600_000,
    expectedResetAtMs: NOW - 5 * 60_000,
    readyAtMs: NOW - 4 * 60_000,
    errorDetail: null,
  };
}

const state = process.argv[2] ?? "normal";
const port = Number(process.argv[3] ?? 47_899);
const accounts = FIXTURES[state];
if (!accounts) {
  console.error(`unknown state: ${state} (have ${Object.keys(FIXTURES).join(", ")})`);
  process.exit(2);
}

let resumeTasks: FixtureResumeTask[] = state === "resume-waiting"
  ? [waitingTask()]
  : state === "resume-ready"
    ? [readyTask(), waitingTask()]
    : state === "overview" ? [readyTask(), waitingTask()] : [];
const resetSignals = state === "overview" ? {
  enabled: true, source: "reset-beacon", state: "ready", lastSuccessMs: NOW,
  signals: [0, 1, 2].map(index => ({
    id: String(index + 1), fingerprint: `fixture-${index}`, author: "openai",
    sourceUrl: `https://x.com/openai/status/${index + 1}`,
    text: "Synthetic UI fixture: a reset may become available later today. This is not a real announcement.",
    publishedAtMs: NOW - (index + 1) * 86_400_000,
    state: index === 1 ? "withdrawn" : "announced", resetKind: "unknown",
    observedVia: "reset-beacon", targetAtMs: NOW - (index + 1) * 3_600_000,
  })),
} : null;
let notificationClaimed = false;
let notificationCompleted = false;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/status") {
      return json({
        nowMs: Date.now(),
        headline: buildHeadline(accounts, Date.now()),
        accounts,
        statuses: [],
        events: [],
        actionToken: ACTION_TOKEN,
        resumeTasks,
        resetSignals,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/notifications/claim") {
      if (request.headers.get("x-quotapie-action-token") !== ACTION_TOKEN) {
        return json({ error: "invalid action token" }, 403);
      }
      if (state !== "notification" || notificationClaimed || notificationCompleted) {
        return json({ notification: null });
      }
      notificationClaimed = true;
      console.log(`notification claimed: ${NOTIFICATION_ID}`);
      return json({
        notification: {
          id: NOTIFICATION_ID,
          title: "QuotaPie native notification",
          message: "This banner is sent by QuotaPie.app, not the script runner.",
          severity: "info",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60 * 60_000,
          claimToken: NOTIFICATION_CLAIM,
        },
      });
    }

    const notificationAction = url.pathname.match(
      /^\/api\/notifications\/([^/]+)\/(scheduled|suppressed|expired|release|renew)$/,
    );
    if (request.method === "POST" && notificationAction) {
      if (request.headers.get("x-quotapie-action-token") !== ACTION_TOKEN) {
        return json({ error: "invalid action token" }, 403);
      }
      const [, notificationID, action] = notificationAction;
      if (notificationID !== NOTIFICATION_ID) return json({ error: "notification not found" }, 404);
      if (request.headers.get("x-quotapie-notification-claim") !== NOTIFICATION_CLAIM) {
        return json({ error: "claim conflict" }, 409);
      }
      if (action === "release") {
        notificationClaimed = false;
        console.log(`notification released: ${NOTIFICATION_ID}`);
        return json({ released: true });
      }
      if (action === "renew") {
        console.log(`notification renewed: ${NOTIFICATION_ID}`);
        return json({ renewed: true });
      }
      notificationCompleted = true;
      notificationClaimed = false;
      console.log(`notification ${action}: ${NOTIFICATION_ID}`);
      return json({ completed: true });
    }

    const match = url.pathname.match(/^\/api\/resume-tasks\/([^/]+)\/(approve|resumed|retry|dismiss)$/);
    if (request.method !== "POST" || !match) return new Response("not found", { status: 404 });
    if (request.headers.get("x-quotapie-action-token") !== ACTION_TOKEN) {
      return json({ error: "invalid action token" }, 403);
    }

    const [, taskID, action] = match;
    const task = resumeTasks.find((item) => item.id === taskID);
    if (!task) return json({ error: "resume task not found" }, 404);

    if (action === "approve") {
      if (task.state !== "ready") return json({ error: "resume task is not ready" }, 409);
      task.state = "approved";
      const workingDirectory = process.cwd();
      const isCodex = task.provider === "codex";
      return json({
        task,
        plan: {
          executable: isCodex ? "codex" : "claude",
          arguments: isCodex
            ? ["resume", "-C", workingDirectory, CODEX_SESSION_ID]
            : ["--resume", CLAUDE_SESSION_ID],
          environment: isCodex
            ? { CODEX_HOME: "/tmp/quotapie-fixture-codex" }
            : { CLAUDE_CONFIG_DIR: "/tmp/quotapie-fixture-claude" },
          workingDirectory,
        },
      });
    }

    if (action === "retry") {
      task.state = "ready";
      task.errorDetail = null;
      return json({ task });
    }

    resumeTasks = resumeTasks.filter((item) => item.id !== task.id);
    return json({ task: { ...task, state: action } });
  },
});
console.log(`fixture ${state} on http://127.0.0.1:${port}`);
