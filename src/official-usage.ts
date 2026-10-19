import { normalizeOfficialThreads, type OfficialThreadCandidate, type OfficialThreadUsage } from "./official-thread-usage";
import { buildOfficialUsageAnalysis, unavailableOfficialUsageAnalysis, officialAnalysisRange, type OfficialUsageAnalysis } from "./official-usage-analysis";
import { poolAccounts, type PoolAccount } from "./account-pool";
import type { AppConfig } from "./config";

export interface OfficialUsageRow { key: string; value: number }
export interface OfficialUsageDimensions {
  features: OfficialUsageRow[]; models: OfficialUsageRow[];
  surfaces: OfficialUsageRow[]; triggers: OfficialUsageRow[]; speeds: OfficialUsageRow[];
}
export interface OfficialUsageDay extends OfficialUsageDimensions { date: string; total: number }
export interface OfficialUsagePeriod extends OfficialUsageDimensions {
  id: string; windowMinutes: number; startsAtMs: number; endsAtMs: number;
  usedPercent: number | null; accountingComplete: boolean;
}
export interface OfficialUsageAccount extends OfficialUsageDimensions {
  analysis: OfficialUsageAnalysis | null;
  threads:OfficialThreadUsage[];threadsAsOfMs:number|null;threadsError:string|null;
  account: string; label: string; status: "ready" | "unavailable"; error: string | null;
  units: string; dataFreshnessMs: number | null; days: OfficialUsageDay[]; total: number;
  periods: OfficialUsagePeriod[]; periodsAsOfMs: number | null;
  periodsComplete: boolean; periodsApproximate: boolean; periodsError: string | null; periodsRequestedDays: number;
}
export interface OfficialUsageReport {
  generatedAtMs: number; startDate: string; endDate: string; accounts: OfficialUsageAccount[];
}
const emptyDimensions = (): OfficialUsageDimensions => ({ features: [], models: [], surfaces: [], triggers: [], speeds: [] });
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const stamp = (value: unknown): number | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const rows = (values: Map<string, number>): OfficialUsageRow[] => [...values].map(([key, value]) => ({ key, value })).filter(r => r.value > 0).sort((a,b) => b.value-a.value || a.key.localeCompare(b.key));
const add = (map: Map<string,number>, key: unknown, value: unknown) => { if(typeof key === "string" && key.length <= 200 && number(value)) map.set(key,(map.get(key)??0)+value); };
function aggregate(all: OfficialUsageDimensions[]): OfficialUsageDimensions {
  return Object.fromEntries((["features","models","surfaces","triggers","speeds"] as const).map(dimension => {
    const map = new Map<string, number>();
    for (const item of all) for (const row of item[dimension]) add(map,row.key,row.value);
    return [dimension,rows(map)];
  })) as unknown as OfficialUsageDimensions;
}
export function normalizeOfficialDaily(payload: any, startDate: string, endDate: string) {
  if (!payload || !Array.isArray(payload.data) || payload.data.length > 100 || !["percent","credits"].includes(payload.units)) throw new Error("invalid_daily_response");
  const days: OfficialUsageDay[] = [];
  const seen = new Set<string>();
  for (const item of payload.data) {
    if (typeof item.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || item.date < startDate || item.date > endDate || seen.has(item.date)) throw new Error("invalid_daily_response");
    seen.add(item.date);
    const maps = {features:new Map<string,number>(),models:new Map<string,number>(),surfaces:new Map<string,number>(),triggers:new Map<string,number>(),speeds:new Map<string,number>()};
    if (!Array.isArray(item.models) || !Array.isArray(item.attribution)) throw new Error("invalid_daily_response");
    for (const model of item.models) { if (!number(model.credits)) throw new Error("invalid_daily_response"); add(maps.models,model.model,model.credits); add(maps.speeds,model.speed || "unknown",model.credits); }
    for (const record of item.attribution) {
      if (!number(record.value)) throw new Error("invalid_daily_response");
      add(maps.features,record.thread_source || "unknown",record.value); add(maps.surfaces,record.surface || "unknown",record.value); add(maps.triggers,record.turn_trigger || "unknown",record.value);
    }
    const dimensions = Object.fromEntries(Object.entries(maps).map(([key,map])=>[key,rows(map)])) as unknown as OfficialUsageDimensions;
    days.push({date:item.date,total:[...maps.models.values()].reduce((a,b)=>a+b,0),...dimensions});
  }
  days.sort((a,b)=>a.date.localeCompare(b.date));
  return {units:payload.units as string,dataFreshnessMs:stamp(payload.data_freshness_ts),days,total:days.reduce((sum,day)=>sum+day.total,0),...aggregate(days)};
}
export function normalizeOfficialPeriods(payload: any) {
  if (!payload || !Array.isArray(payload.periods) || payload.periods.length > 500) throw new Error("invalid_period_response");
  const periods: OfficialUsagePeriod[] = payload.periods.map((p:any) => {
    const start=stamp(p.starts_at),end=stamp(p.ends_at);
    if (typeof p.id!=="string" || start===null || end===null || end<=start || ![300,10080].includes(p.window_minutes) || (p.used_basis_points!==null && !number(p.used_basis_points))) throw new Error("invalid_period_response");
    const dimensions=emptyDimensions();
    const names:Record<string,keyof OfficialUsageDimensions>={thread_source:"features",model:"models",surface:"surfaces",turn_trigger:"triggers"};
    for(const breakdown of p.breakdowns??[]) {
      const dimension=names[breakdown.dimension]; if(!dimension)continue;
      const map=new Map<string,number>();
      for(const row of breakdown.rows??[]) {if(!number(row.basis_points))throw new Error("invalid_period_response");add(map,row.key,row.basis_points/100);}
      dimensions[dimension]=rows(map);
    }
    return {id:p.id,windowMinutes:p.window_minutes,startsAtMs:start,endsAtMs:end,usedPercent:p.used_basis_points===null?null:p.used_basis_points/100,accountingComplete:p.accounting_complete===true,...dimensions};
  });
  return {periods,periodsAsOfMs:stamp(payload.data_as_of),periodsComplete:payload.coverage_complete===true,periodsApproximate:payload.approximate!==false,periodsError:null as string|null};
}
export function parseOfficialUsageQuery(url:URL, config:AppConfig) {
  const startDate=url.searchParams.get("startDate"),endDate=url.searchParams.get("endDate"),account=url.searchParams.get("account");
  const valid=(s:string|null):s is string=>s!==null && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
  if(!valid(startDate)||!valid(endDate)||startDate>endDate||Date.parse(endDate)-Date.parse(startDate)>89*86400000|| (account!==null && !config.accounts.codex.some(a=>a.enabled&&a.id===account)))throw new Error("invalid_official_usage_query");
  const analysisBoundaryMs=url.searchParams.has("analysisBoundaryMs")?Number(url.searchParams.get("analysisBoundaryMs")):undefined;
  if(analysisBoundaryMs!==undefined&&(!Number.isSafeInteger(analysisBoundaryMs)||analysisBoundaryMs<Date.parse(startDate)||analysisBoundaryMs>=Date.parse(endDate)+86400000))throw new Error("invalid_analysis_boundary");
  const analysisDate=url.searchParams.get("analysisDate")??undefined,analysisTimeZone=url.searchParams.get("analysisTimeZone")??undefined;
  if(analysisDate!==undefined&&!valid(analysisDate))throw new Error("invalid_analysis_date");
  if(analysisTimeZone!==undefined){if(analysisTimeZone.length>100)throw new Error("invalid_analysis_timezone");try{new Intl.DateTimeFormat("en",{timeZone:analysisTimeZone}).format(0);}catch{throw new Error("invalid_analysis_timezone");}}
  return {startDate,endDate,account,analysisBoundaryMs,analysisDate,analysisTimeZone};
}
export interface OfficialUsageQuery {startDate:string;endDate:string;account:string|null;analysisBoundaryMs?:number;analysisDate?:string;analysisTimeZone?:string}
export type OfficialBoundaryResolver=(account:string,query:OfficialUsageQuery,now:number)=>{atMs:number;kind:string}|null;
export class OfficialUsageAPI {
  private cache=new Map<string,{at:number,value:Promise<OfficialUsageReport>}>();
  constructor(private config:AppConfig,private fetcher:typeof fetch=fetch,private accounts=()=>poolAccounts(config),private boundaryResolver?:OfficialBoundaryResolver,private threadCandidates:(profile:AppConfig["accounts"]["codex"][number],expectedUpstreamAccount:string)=>OfficialThreadCandidate[]=()=>[]){}
  async read(query:OfficialUsageQuery,now=Date.now(),refresh=false):Promise<OfficialUsageReport>{
    const credentials=this.accounts().filter(a=>query.account===null||a.id===query.account);
    // Account identity is part of the cache key; relogin never receives another account's report.
    const key=JSON.stringify([query,credentials.map(a=>[a.id,a.identity])]);
    const cached=this.cache.get(key);if(cached&&now-cached.at<(refresh?10000:300000))return cached.value;
    if(this.cache.size>=12)this.cache.delete(this.cache.keys().next().value!);
    const value=this.collect(query,credentials,now).catch(error=>{this.cache.delete(key);throw error;});this.cache.set(key,{at:now,value});return value;
  }
  private async collect(query:OfficialUsageQuery,credentials:PoolAccount[],now:number):Promise<OfficialUsageReport>{
    const profiles=this.config.accounts.codex.filter(a=>a.enabled&&(query.account===null||a.id===query.account));
    const collectAccount=async(profile:AppConfig["accounts"]["codex"][number]):Promise<OfficialUsageAccount>=>{
      const account=credentials.find(a=>a.id===profile.id);
      const result:OfficialUsageAccount={analysis:null,threads:[],threadsAsOfMs:null,threadsError:"not_requested",account:profile.id,label:profile.nickname||profile.label,status:"unavailable",error:"authentication_unavailable",units:"percent",dataFreshnessMs:null,days:[],total:0,...emptyDimensions(),periods:[],periodsAsOfMs:null,periodsComplete:false,periodsApproximate:true,periodsError:null,periodsRequestedDays:7};
      const observed=query.analysisDate?this.boundaryResolver?.(profile.id,query,now):null;
      const boundaryMs=observed?.atMs??(query.analysisDate?undefined:query.analysisBoundaryMs);
      if(query.analysisDate||query.analysisBoundaryMs!==undefined)result.analysis=unavailableOfficialUsageAnalysis(boundaryMs===undefined?"recovery_not_observed":"official_data_unavailable");
      if(account && account.tokenExpiresAt>now){
        const request=async(path:string,body?:unknown)=>{
          const response=await this.fetcher(`https://chatgpt.com/backend-api/wham/usage/${path}`,{method:body?"POST":"GET",...(body?{body:JSON.stringify(body)}:{}),redirect:"error",headers:{"content-type":"application/json",Authorization:`Bearer ${account.accessToken}`,"chatgpt-account-id":account.upstreamAccount,"x-openai-codex-usage-categories":"1"},signal:AbortSignal.timeout(15000)});
          if(!response.ok)throw new Error(`http_${response.status}`);
          const text=await response.text();if(text.length>8*1024*1024)throw new Error("response_too_large");return JSON.parse(text);
        };
        let candidates:OfficialThreadCandidate[]=[];
        try{candidates=this.threadCandidates(profile,account.upstreamAccount);result.threadsError=candidates.length?null:"no_local_threads";}catch{result.threadsError="thread_metadata_unavailable";}
        const threadRead=candidates.length?request("thread_usage/query_v2",{threads:candidates.map(c=>({thread_id:c.threadId,created_at:new Date(c.createdAtMs).toISOString(),descendant_thread_ids:c.descendantIds}))}).then(payload=>{Object.assign(result,normalizeOfficialThreads(payload,candidates));}).catch(error=>{result.threadsError=safeError(error);}):Promise.resolve();
        const analysisRange=boundaryMs!==undefined?officialAnalysisRange(boundaryMs,query.endDate,now):null;
        const fetchStart=analysisRange&&analysisRange.previousStartDate<query.startDate?analysisRange.previousStartDate:query.startDate;
        const [daily,periods]=await Promise.allSettled([request(`daily-token-usage-breakdown?${new URLSearchParams({start_date:fetchStart,end_date:query.endDate,group_by:"day"})}`),request("plan_limit_history?days=7")]);
        try {
          if(daily.status==="rejected")throw daily.reason;
          const combined=normalizeOfficialDaily(daily.value,fetchStart,query.endDate);
          const selectedDays=combined.days.filter(day=>day.date>=query.startDate);
          Object.assign(result,combined,{days:selectedDays,total:selectedDays.reduce((s,d)=>s+d.total,0),...aggregate(selectedDays),status:"ready",error:null});
          if(boundaryMs!==undefined){
            result.analysis=buildOfficialUsageAnalysis(combined.days,boundaryMs,query.endDate,now,combined.dataFreshnessMs);
            result.analysis.boundarySource=observed?"observed":"supplied";result.analysis.boundaryKind=observed?.kind??null;
          }
        }catch(error){result.error=safeError(error);}
        await threadRead;
        try {if(periods.status==="rejected")throw periods.reason;Object.assign(result,normalizeOfficialPeriods(periods.value));}catch(error){result.periodsError=safeError(error);}
      }
      return result;
    };
    const accounts:OfficialUsageAccount[]=[];
    // At most two accounts (six read-only HTTP requests) in flight.
    for(let index=0;index<profiles.length;index+=2) accounts.push(...await Promise.all(profiles.slice(index,index+2).map(collectAccount)));
    return {generatedAtMs:now,startDate:query.startDate,endDate:query.endDate,accounts};
  }
}
function safeError(error:unknown):string {const value=error instanceof Error?error.message:"";return /^(http_\d{3}|invalid_daily_response|invalid_period_response|invalid_thread_response|response_too_large)$/.test(value)?value:"request_failed";}
