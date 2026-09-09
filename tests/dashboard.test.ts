import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const dashboard = readFileSync(new URL("../src/dashboard.html", import.meta.url), "utf8");
const dashboardMatch = dashboard.match(/<script>([\s\S]*?)<\/script>/);
if (!dashboardMatch?.[1]) throw new Error("dashboard script not found");
const dashboardScript = dashboardMatch[1];

interface FakeElement {
  textContent: string;
  innerHTML: string;
}

function statusPayload() {
  const nowMs = Date.now();
  return {
    nowMs,
    accounts: [{
      provider: "claude",
      account: "work",
      accountLabel: "Work",
      collection: {
        health: "recent-success",
        activeSource: "claude-statusline",
        lastSuccessAtMs: nowMs,
        errorCategory: null,
        errorDetail: null,
        sources: [],
      },
      windows: [{
        provider: "claude",
        account: "work",
        bucket: "weekly",
        label: "Claude weekly",
        windowSeconds: 604_800,
        source: "claude-statusline",
        quality: "authoritative",
        freshness: "fresh",
        observedAtMs: nowMs - 60_000,
        usedPercent: 72,
        remainingPercent: 28,
        resetsAtMs: null,
        timeToResetMs: null,
        reservePercent: 20,
        recentBurnPerHour: 1.5,
        personalBurnPerHour: 1.2,
        paceRatio: 1.1,
        exhaustsAtMs: null,
        confidence: "high",
        sampleCount: 8,
        activeHoursUntilReset: 12,
      }],
      bottleneckBucket: "weekly",
      updatedAtMs: nowMs,
    }],
    statuses: [],
    events: [{
      provider: "claude",
      account: "work",
      bucket: "weekly",
      kind: "external_relief",
      severity: "info",
      occurredAtMs: nowMs,
      confidence: "high",
      displayText: "STORED_DAEMON_LANGUAGE_TEXT",
      details: {
        label: "Claude weekly",
        usedPercentBefore: 70,
        usedPercentAfter: 5,
      },
    }],
  };
}

async function render(language: string) {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    let value = elements.get(id);
    if (!value) {
      value = { textContent: "", innerHTML: "" };
      elements.set(id, value);
    }
    return value;
  };
  const documentElement = { lang: "" };
  const payload = statusPayload();
  const context = createContext({
    navigator: { language, languages: [language] },
    document: { documentElement, getElementById: element },
    fetch: async () => ({ json: async () => payload }),
    setInterval: () => 0,
  });

  // Loading the Korean catalog used to throw here because it called `t`
  // while `t` itself was still in the temporal dead zone.
  runInContext(dashboardScript, context);
  await runInContext("refresh()", context);

  return { documentElement, element };
}

describe("dashboard localization", () => {
  test("uses the semantic wire key for sentences and a label namespace for short names", () => {
    expect(dashboard).toContain('"event.external_relief": "{label} was refilled ahead of schedule."');
    expect(dashboard).toContain('"event.label.external_relief": "Early refill"');
    expect(dashboard).not.toContain('"event.message.');
  });

  test("the inline script starts and renders its English semantic values", async () => {
    const page = await render("en-US");

    expect(page.documentElement.lang).toBe("en");
    expect(page.element("subtitle").textContent).toBe("Provider clock + personal burn rate");
    expect(page.element("providers").innerHTML).toContain("Claude status line");
    expect(page.element("providers").innerHTML).toContain("authoritative");
    expect(page.element("providers").innerHTML).toContain("high");
    expect(page.element("providers").innerHTML).toContain("Reset time unknown");
    expect(page.element("events").innerHTML).toContain('<span class="kind">Early refill</span>');
    expect(page.element("events").innerHTML).toContain("Claude weekly was refilled ahead of schedule.");
    expect(page.element("events").innerHTML).not.toContain("STORED_DAEMON_LANGUAGE_TEXT");
  });

  test("the same payload is rebuilt in Korean from kind and details", async () => {
    const page = await render("ko-KR");

    expect(page.documentElement.lang).toBe("ko");
    expect(page.element("subtitle").textContent).toBe("공급자 원본 시계 + 개인 사용 속도");
    expect(page.element("providers").innerHTML).toContain("Claude 상태줄");
    expect(page.element("providers").innerHTML).toContain("공식 원본");
    expect(page.element("providers").innerHTML).toContain("높음");
    expect(page.element("providers").innerHTML).toContain("갱신 시각 미확인");
    expect(page.element("events").innerHTML).toContain('<span class="kind">예정 밖 충전</span>');
    expect(page.element("events").innerHTML).toContain("Claude weekly에 예정 밖 충전이 감지됐습니다.");
    expect(page.element("events").innerHTML).toContain("신뢰도 높음");
    expect(page.element("events").innerHTML).not.toContain("STORED_DAEMON_LANGUAGE_TEXT");
  });
});
