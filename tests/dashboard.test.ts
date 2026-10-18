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

async function render(language: string, payload = statusPayload(), fetcher: (...args: any[]) => Promise<any> = async () => ({ json: async () => payload })) {
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
    fetch: fetcher,
    setInterval: () => 0,
  });

  // Loading the Korean catalog used to throw here because it called `t`
  // while `t` itself was still in the temporal dead zone.
  runInContext(dashboardScript, context);
  await runInContext("refresh()", context);

  return { documentElement, element, context };
}

describe("dashboard automatic quota resumption", () => {
  const feature = () => ({ accounts: [{ account: "personal", label: '<img src=x onerror="bad()">', enabled: false,
    enabledAtMs: null, lastScanAtMs: null, lastError: null }], incidents: ["waiting", "running", "resumed", "needs-review", "constructor"].map(state => ({
    id: state, account: "personal", threadId: 'thread<unsafe>', projectLabel: '<script>bad()</script>', state,
    reason: "private-error-text", detectedAtMs: Date.now(),
  })) });

  test("optional support, localized states, safe labels and waiting-only skip", async () => {
    const legacy = await render("ko-KR");
    expect(legacy.element("autoResume").innerHTML).toContain("로컬 서비스를 업데이트");
    for (const language of ["en-US", "ko-KR"]) {
      const page = await render(language, Object.assign(statusPayload(), { autoResume: feature(), actionToken: "fixture-token" }));
      const html = page.element("autoResume").innerHTML;
      expect(html).toContain(language === "ko-KR" ? "1회 재개 종료" : "One continuation ended");
      expect(html).toContain(language === "ko-KR" ? "상태 미확인" : "Status unverified");
      expect(html.match(/data-auto-skip=/g)).toHaveLength(1);
      expect(html).toContain('data-auto-skip="waiting"');
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("private-error-text");
    }
    const changed = feature();
    Object.assign(changed.accounts[0]!, { lastError: "account-binding-changed" });
    const changedPage = await render("ko-KR", Object.assign(statusPayload(), { autoResume: changed }));
    expect(changedPage.element("autoResume").innerHTML).toContain("연결된 계정이 바뀌었습니다");
  });

  test("authenticated enable/disable and skip, failed save, stale poll race", async () => {
    const before = Object.assign(statusPayload(), { autoResume: feature(), actionToken: "fixture-token" });
    const calls: Array<{ path: string; options: any }> = [];
    let deferred: ((value: unknown) => void) | undefined, deferStatus = false, rejectMutation = false, failStatus = false;
    const page = await render("ko-KR", before, async (path, options) => {
      if (path === "/api/status") {
        if (failStatus) throw new Error("offline");
        if (deferStatus) return new Promise(resolve => { deferred = resolve; });
        return { ok: true, json: async () => structuredClone(before) };
      }
      calls.push({ path, options });
      if (rejectMutation) return { ok: false, json: async () => ({ error: "PRIVATE_ERROR_BODY" }) };
      const reply = feature(), body = JSON.parse(options.body);
      if (body.action === "enabled") reply.accounts[0]!.enabled = body.enabled;
      if (body.action === "skip") reply.incidents.find(item => item.id === body.id)!.state = "skipped";
      return { ok: true, json: async () => ({ autoResume: reply }) };
    });
    deferStatus = true;
    const oldPoll = runInContext("refresh()", page.context);
    await runInContext('changeAutoResume({action:"enabled",account:"personal",enabled:true})', page.context);
    deferred!({ ok: true, json: async () => structuredClone(before) });
    await oldPoll;
    expect(page.element("autoResume").innerHTML).toContain('checked');
    await runInContext('changeAutoResume({action:"enabled",account:"personal",enabled:false})', page.context);
    expect(page.element("autoResume").innerHTML).not.toContain(' checked');
    await runInContext('changeAutoResume({action:"skip",id:"running"})', page.context);
    expect(calls).toHaveLength(2);
    await runInContext('changeAutoResume({action:"skip",id:"waiting"})', page.context);
    expect(calls).toHaveLength(3);
    for (const { path, options } of calls) {
      expect(path).toBe("/api/auto-resume");
      expect(options.method).toBe("POST");
      expect(options.headers["x-quotapie-action-token"]).toBe("fixture-token");
      expect(options.redirect).toBe("error");
    }
    expect(JSON.parse(calls[2]!.options.body)).toEqual({ action: "skip", id: "waiting" });
    rejectMutation = true;
    await runInContext('changeAutoResume({action:"enabled",account:"personal",enabled:true})', page.context);
    expect(page.element("autoResume").innerHTML).not.toContain(' checked');
    expect(page.element("autoResume").innerHTML).toContain("변경 결과를 확인하지 못했습니다");
    expect(page.element("autoResume").innerHTML).not.toContain("PRIVATE_ERROR_BODY");
    failStatus = true;
    await runInContext("refresh()", page.context);
    const beforeOffline = calls.length;
    await runInContext('changeAutoResume({action:"enabled",account:"personal",enabled:true})', page.context);
    expect(calls).toHaveLength(beforeOffline);
    expect(page.element("autoResume").innerHTML).toContain("disabled");
  });

  test("admission wait reasons stay informational and ready has no review prompt", async () => {
    for (const reason of ["reserve-reached", "quota-stale", "quota-unknown", "reset-unconfirmed", "host-goal-stale", "host-goal-unavailable", "ready"]) {
      const value = feature();
      value.incidents = [{ ...value.incidents[0]!, reason }];
      const page = await render("ko-KR", Object.assign(statusPayload(), { autoResume: value }));
      const html = page.element("autoResume").innerHTML;
      expect(html).not.toContain("Codex에서 대화를 열어 상태를 확인하세요");
      if (reason === "ready") expect(html).not.toContain("호스트 목표가");
      else expect(html).toContain(reason.startsWith("host-goal-") ? "호스트 목표가 현재 이어하기를 허용하지 않습니다" : "한도 회복이 확인되기를 기다립니다");
    }
  });
});

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
