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
        showUsageSpeed: true as boolean | undefined,
        personalBurnPerHour: 1.2,
        paceRatio: 1.1,
        exhaustsAtMs: null,
        reserveReachesAtMs: null as number | null,
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

async function render(language: string, payload = statusPayload()) {
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
  test("speed controls hide analysis when absent or off, then show reserve timing when on", async () => {
    const payload = statusPayload();
    const window = payload.accounts[0]!.windows[0]!;
    window.reserveReachesAtMs = Date.UTC(2026, 8, 15, 12);
    for (const language of ["en-US", "ko-KR"]) {
      const recent = language === "ko-KR" ? "현재 속도" : "Recent pace";
      const reserve = language === "ko-KR" ? "안전 여유 ETA" : "Safety margin ETA";
      for (const flag of [undefined, false]) {
        window.showUsageSpeed = flag;
        const page = await render(language, payload);
        const html = page.element("providers").innerHTML;
        expect(html).not.toContain(reserve);
        expect(html).not.toContain(language === "ko-KR" ? "학습 표본" : "Learning samples");
        expect(html).not.toContain('window warm');
        expect(html).toContain("28.0");
        expect(html).toContain(language === "ko-KR" ? "원본 관측" : "Source observation");
        expect(page.element("subtitle").textContent).toBe(language === "ko-KR" ? "한도 잔량 + 공급자 리셋 시각" : "Quota remaining + provider reset clock");
      }
      window.showUsageSpeed = true;
      const page = await render(language, payload);
      const html = page.element("providers").innerHTML;
      expect(html).toContain(recent);
      const date = new Date(window.reserveReachesAtMs).toLocaleString(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      expect(html).toContain(`${reserve} <strong>${date}</strong>`);
    }
  });

  test("stored credit additions render observed values and delta in both locales", async () => {
    const payload = statusPayload();
    const initial = payload.events[0]!;
    const creditPayload = { ...payload, events: [{ ...initial, kind: "credit_topup",
      details: { ...initial.details, balanceBefore: 0, balanceAfter: 62500 },
    }] };
    for (const language of ["en-US", "ko-KR"]) {
      const page = await render(language, creditPayload);
      const html = page.element("events").innerHTML;
      expect(html).toContain("0 → 62500");
      expect(html).toContain("+62500");
      expect(html).not.toContain(language === "ko-KR" ? "결제 완료" : "payment confirmed");
      expect(html).not.toContain("STORED_DAEMON_LANGUAGE_TEXT");
    }
  });

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
