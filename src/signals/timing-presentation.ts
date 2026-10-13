import type { ResetSignal } from "./classify";
import type { ResetTimingCase } from "./timing-history";
import type { Locale } from "../i18n";

export function resetTimingPresentation(signal: ResetSignal, cases: ResetTimingCase[], locale: Locale, timeZone: string,
  accounts: { provider: string; account: string; accountLabel: string }[]) {
  if ((signal.benefitKind ?? "reset") !== "reset" || signal.resetKind === "banked") {
    return { forecastText: null, timingHistoryText: null };
  }
  const ko = locale === "ko";
  const format = (ms: number) => new Intl.DateTimeFormat(ko ? "ko-KR" : "en-US", {
    timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short",
  }).formatToParts(ms).map(p=>p.type === "timeZoneName" && timeZone === "Asia/Seoul" ? "KST" : p.value).join("");
  const rows = cases.filter(r=> r.signalId === (signal.sourcePostId ?? signal.id) && r.provider === (signal.provider ?? "codex"));
  const label = (r:ResetTimingCase) => accounts.find(a=>a.provider===r.provider&&a.account===r.account)?.accountLabel ?? r.account;
  const forecasts = rows.filter(r=>r.forecast).map(r=>{
    const f=r.forecast!;
    return `${label(r)} · ${ko ? "당시 예상" : "Estimate at issue"} ${format(f.earliestMs)}–${format(f.latestMs)} · ${f.sampleCount}${ko ? "일 관측 · 확정 아님" : " observed days · unconfirmed"}`;
  });
  const observed = cases.filter(r=>r.provider===(signal.provider??"codex") && r.author.toLowerCase()===signal.author.toLowerCase() &&
    r.status==="observed" && r.observation && r.publishedAtMs<=signal.publishedAtMs).slice(0,6);
  const history = observed.map(r=>{
    const o=r.observation!;
    return `${label(r)} · ${ko ? "실제 관측" : "Observed"} ${format(o.afterMs)}–${format(o.byMs)} · ${Math.round(o.remainingBefore)}% → ${Math.round(o.remainingAfter)}%`;
  });
  return { forecastText: forecasts.length ? forecasts.join("\n") : null,
    timingHistoryText: history.length ? history.join("\n") : rows.length ? (ko ? "실제 리셋 관측 이력 없음" : "No observed reset history") : null };
}
