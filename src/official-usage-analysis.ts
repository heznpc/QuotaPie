import type { OfficialUsageDay, OfficialUsageRow } from "./official-usage";
const DAY=86400000;
const date=(ms:number)=>new Date(ms).toISOString().slice(0,10);
export interface OfficialUsageComparisonRow { key:string; current:number; previous:number; delta:number; changePercent:number|null }
export interface OfficialUsageAnalysis {
  status:"observed_days"|"unavailable"; reason:string|null; boundaryMs:number|null; boundarySource:"observed"|"supplied"|"unavailable"; boundaryKind:string|null; exactResetStatus:"unavailable"; timezone:"UTC";
  currentStartDate:string; currentEndDate:string; previousStartDate:string; previousEndDate:string;
  excludedDates:string[]; currentTotal:number; previousTotal:number; changePercent:number|null;
  currentFeatureTotal:number; previousFeatureTotal:number; featureChangePercent:number|null;
  models:OfficialUsageComparisonRow[]; features:OfficialUsageComparisonRow[];
  speeds:OfficialUsageComparisonRow[]; triggers:OfficialUsageComparisonRow[];
  conversationStatus:"unavailable"; conversationReason:"lifetime_no_date_filter";
  freshnessConfirmed:boolean; basis:"separate_model_and_attribution_relative_scales";
}
export function officialAnalysisRange(boundaryMs:number,endDate:string,now:number){
  const boundaryDay=Math.floor(boundaryMs/DAY)*DAY;
  const end=Math.min(Date.parse(endDate),Math.floor(now/DAY)*DAY-DAY);
  const start=boundaryDay+DAY, count=Math.floor((end-start)/DAY)+1;
  if(count<1||count>44)return null;
  return {currentStartDate:date(start),currentEndDate:date(end),previousStartDate:date(boundaryDay-count*DAY),previousEndDate:date(boundaryDay-DAY),count,excludedDates:[date(boundaryDay),...(Date.parse(endDate)>=Math.floor(now/DAY)*DAY?[date(now)]:[])]};
}
const ratio=(current:number,previous:number)=>previous>0?(current-previous)/previous*100:null;
function compare(current:OfficialUsageRow[],previous:OfficialUsageRow[]):OfficialUsageComparisonRow[]{
  const a=new Map<string,number>(),b=new Map<string,number>();
  for(const row of current)a.set(row.key,(a.get(row.key)??0)+row.value);
  for(const row of previous)b.set(row.key,(b.get(row.key)??0)+row.value);
  return [...new Set([...a.keys(),...b.keys()])].map(key=>({key,current:a.get(key)??0,previous:b.get(key)??0,delta:(a.get(key)??0)-(b.get(key)??0),changePercent:ratio(a.get(key)??0,b.get(key)??0)})).sort((a,b)=>b.delta-a.delta||a.key.localeCompare(b.key));
}
export function buildOfficialUsageAnalysis(days:OfficialUsageDay[],boundaryMs:number,endDate:string,now:number,dataFreshnessMs:number|null):OfficialUsageAnalysis{
  const range=officialAnalysisRange(boundaryMs,endDate,now);
  const result:OfficialUsageAnalysis={status:"unavailable",reason:"insufficient_calendar_days",boundaryMs,boundarySource:"supplied",boundaryKind:null,exactResetStatus:"unavailable",timezone:"UTC",currentStartDate:range?.currentStartDate??"",currentEndDate:range?.currentEndDate??"",previousStartDate:range?.previousStartDate??"",previousEndDate:range?.previousEndDate??"",excludedDates:range?.excludedDates??[date(boundaryMs)],currentTotal:0,previousTotal:0,changePercent:null,currentFeatureTotal:0,previousFeatureTotal:0,featureChangePercent:null,models:[],features:[],speeds:[],triggers:[],conversationStatus:"unavailable",conversationReason:"lifetime_no_date_filter",freshnessConfirmed:range!==null&&dataFreshnessMs!==null&&dataFreshnessMs>=Date.parse(range.currentEndDate)+DAY,basis:"separate_model_and_attribution_relative_scales"};
  if(!range)return result;
  const current=days.filter(d=>d.date>=range.currentStartDate&&d.date<=range.currentEndDate),previous=days.filter(d=>d.date>=range.previousStartDate&&d.date<=range.previousEndDate);
  // Missing dates are not zero, and today's empty bucket is not proof of no work.
  if(current.length!==range.count||previous.length!==range.count)return {...result,reason:"missing_daily_rows"};
  result.currentTotal=current.reduce((s,d)=>s+d.total,0);result.previousTotal=previous.reduce((s,d)=>s+d.total,0);result.changePercent=ratio(result.currentTotal,result.previousTotal);
  for(const dimension of ["models","features","speeds","triggers"] as const)result[dimension]=compare(current.flatMap(d=>d[dimension]),previous.flatMap(d=>d[dimension]));
  result.currentFeatureTotal=result.features.reduce((s,r)=>s+r.current,0);result.previousFeatureTotal=result.features.reduce((s,r)=>s+r.previous,0);result.featureChangePercent=ratio(result.currentFeatureTotal,result.previousFeatureTotal);
  result.status="observed_days";result.reason=null;return result;
}

export function unavailableOfficialUsageAnalysis(reason:string):OfficialUsageAnalysis {return {...buildOfficialUsageAnalysis([],Date.now(),new Date().toISOString().slice(0,10),Date.now(),null),status:"unavailable",reason,boundaryMs:null,boundarySource:"unavailable",excludedDates:[]};}
