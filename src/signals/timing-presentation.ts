import type { ResetSignal } from "./classify";
import type { ResetTimingCase } from "./timing-history";
import { evaluateForecast, type ForecastPublication } from "./forecast-model";
import type { Locale } from "../i18n";

export function resetTimingPresentation(signal: ResetSignal, cases: ResetTimingCase[], locale: Locale, timeZone: string,
  accounts: { provider: string; account: string; accountLabel: string }[], publications: ForecastPublication[] = []) {
  if ((signal.benefitKind ?? "reset") !== "reset" || signal.resetKind === "banked") {
    return { forecastText: null, timingHistoryText: null };
  }
  const ko = locale === "ko";
  const format = (ms: number) => new Intl.DateTimeFormat(ko ? "ko-KR" : "en-US", {
    timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short",
  }).formatToParts(ms).map(p=>p.type === "timeZoneName" && timeZone === "Asia/Seoul" ? "KST" : p.value).join("");
  const rows = cases.filter(r=> r.signalId === (signal.sourcePostId ?? signal.id) && r.provider === (signal.provider ?? "codex"));
  const label = (r:ResetTimingCase) => accounts.find(a=>a.provider===r.provider&&a.account===r.account)?.accountLabel ?? r.account;
  const latest=new Map<string,ForecastPublication>();
  for(const f of publications.filter(f=>f.signalId===(signal.sourcePostId??signal.id)&&f.provider===(signal.provider??"codex")).sort((a,b)=>a.issuedAtMs-b.issuedAtMs))latest.set(`${f.account}:${f.bucket}`,f);
  const forecasts=[...latest.values()].map(f=>{
    const account=accounts.find(a=>a.provider===f.provider&&a.account===f.account)?.accountLabel??f.account;
    const probability=f.actionProbabilityEstimate??f.candidateProbabilityEstimate;
    const label=probability==null?(ko?"확률 미정": "Probability unavailable"):
      `${Math.round(probability*100)}% · ${f.actionProbabilityEstimate==null?(ko?"검증 전 추정 · 확률 자동실행에 미사용":"unvalidated estimate · not used for probability-triggered execution"):(ko?"평가 통과":"validated")}`;
    const basis=f.anchorBasis==="publication-elapsed"?(ko?"게시 후 경과시간 · 원문 시간대 미정":"elapsed since publication · source timezone unspecified"):(ko?"원문 마감 대비 시차":"offset from source deadline");
    const interval=f.conditionalInterval?` · ${ko?"해당 마감까지 회복할 경우 중앙 80% 구간":"conditional central 80% interval if recovered by horizon"} ${format(f.conditionalInterval.lowerMs)}–${format(f.conditionalInterval.upperMs)}`:"";
    const r=rows.find(r=>r.account===f.account),e=r?evaluateForecast(f,r):null;
    const score=e?.interval?` · ${ko?"구간 점수":"interval score"} ${Math.round(e.interval.minimum/60000)}–${Math.round(e.interval.maximum/60000)} min` : "";
    const brier=e?.brier!=null?` · Brier ${e.brier.toFixed(3)}`:"";
    return `${account} · ${format(f.horizonAtMs)} ${ko?"까지 회복":"recovery by horizon"} ${label} · ${basis} · ${f.sampleCount}${ko?"건 학습":" training events"} / ${f.excludedCount}${ko?"건 제외":" excluded"}${interval}${score}${brier}`;
  });
  if(!forecasts.length)for(const r of rows.filter(r=>r.forecast)) {
    const f=r.forecast!;
    forecasts.push(`${label(r)} · ${ko ? "당시 예상" : "Estimate at issue"} ${format(f.earliestMs)}–${format(f.latestMs)} · ${f.sampleCount}${ko ? "개 독립 사건 · 조건부 구간 · 확정 아님" : " independent events · conditional interval · unconfirmed"}`);
  }
  const observed = cases.filter(r=>r.provider===(signal.provider??"codex") && r.author.toLowerCase()===signal.author.toLowerCase() &&
    r.status==="observed" && r.observation && r.publishedAtMs<=signal.publishedAtMs).slice(0,6);
  const history = observed.map(r=>{
    const o=r.observation!;
    return `${label(r)} · ${ko ? "실제 관측" : "Observed"} ${format(o.afterMs)}–${format(o.byMs)} · ${Math.round(o.remainingBefore)}% → ${Math.round(o.remainingAfter)}%`;
  });
  return { forecastText: forecasts.length ? forecasts.join("\n") : null,
    timingHistoryText: history.length ? history.join("\n") : rows.length ? (ko ? "실제 리셋 관측 이력 없음" : "No observed reset history") : null };
}
