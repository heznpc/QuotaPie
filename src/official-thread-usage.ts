import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { codexProfileRoot, type CodexAccountConfig } from "./config";
export interface OfficialThreadCandidate { threadId:string; title:string; createdAtMs:number; descendantIds:string[]; ownershipBasis?:"profile"|"creator_account" }
export interface OfficialThreadUsage {
 threadId:string;title:string;createdAtMs:number;scope:"lifetime";descendantCount:number;ownershipBasis:"profile"|"creator_account";
 weeklyLimitPercent:number|null;fiveHourLimitPercent:number|null;dataStatus:string;
 groups:{model:string;reasoningEffort:string;weeklyLimitPercent:number|null;fiveHourLimitPercent:number|null}[];
}
export function readOfficialThreadCandidates(profile:CodexAccountConfig,expectedUpstreamAccount?:string):OfficialThreadCandidate[]{
 const root=realpathSync(codexProfileRoot(profile));
 const name=readdirSync(root).filter(n=>/^state_\d+\.sqlite$/.test(n)).sort((a,b)=>Number(b.match(/\d+/)![0])-Number(a.match(/\d+/)![0]))[0];
 if(!name)return [];
 const account=JSON.parse(readFileSync(join(root,"auth.json"),"utf8")).tokens?.account_id;
 if(typeof account!=="string"||!account||(expectedUpstreamAccount!==undefined&&account!==expectedUpstreamAccount))throw Error("thread_account_unknown");
 const dbPath=realpathSync(join(root,name));
 if(!dbPath.startsWith(root+"/"))throw Error("thread_metadata_outside_profile");
 const db=new Database(dbPath,{readonly:true});
 try{
  const edges=db.query("SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges LIMIT 10001").all() as {parent_thread_id:string;child_thread_id:string}[];
  if(edges.length>10000)throw Error("thread_metadata_too_large");
  const children=new Set(edges.map(e=>e.child_thread_id)),adj=new Map<string,string[]>();
  for(const e of edges)adj.set(e.parent_thread_id,[...(adj.get(e.parent_thread_id)??[]),e.child_thread_id]);
  const ownerRows=db.query("SELECT id,creator_account_id FROM threads LIMIT 10001").all() as {id:string;creator_account_id:string|null}[];
  if(ownerRows.length>10000)throw Error("thread_metadata_too_large");
  const ownership=new Map(ownerRows.map(r=>[r.id,r.creator_account_id]));
  const roots=db.query("SELECT id,title,created_at FROM threads WHERE id NOT IN (SELECT child_thread_id FROM thread_spawn_edges) ORDER BY updated_at DESC LIMIT 60").all() as {id:string;title:string;created_at:number}[];
  const result:OfficialThreadCandidate[]=[],claimed=new Set<string>();let count=0;
  for(const r of roots){
   if((ownership.get(r.id)!=null&&ownership.get(r.id)!==account)||children.has(r.id)||!r.id||!Number.isFinite(r.created_at)||r.created_at<=0)continue;
   const seen=new Set<string>([r.id]),pending=[...(adj.get(r.id)??[])];
   while(pending.length&&seen.size<=1000){const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);pending.push(...(adj.get(id)??[]));}
   if([...seen].some(id=>!ownership.has(id)||(ownership.get(id)!=null&&ownership.get(id)!==account))||seen.size>1000||count+seen.size>1000||[...seen].some(id=>claimed.has(id)))continue;
   for(const id of seen)claimed.add(id);count+=seen.size;
   result.push({threadId:r.id,title:r.title.slice(0,500),createdAtMs:r.created_at*1000,descendantIds:[...seen].filter(id=>id!==r.id),ownershipBasis:[...seen].every(id=>ownership.get(id)===account)?"creator_account":"profile"});
   if(result.length===20)break;
  }
  return result;
 }finally{db.close();}
}
const metric=(v:unknown):number|null=>v===null||v===undefined?null:typeof v==="number"&&Number.isFinite(v)&&v>=0?v:(()=>{throw Error("invalid_thread_response");})();
export function normalizeOfficialThreads(payload:any,candidates:OfficialThreadCandidate[]){
 if(!payload||!Array.isArray(payload.threads)||payload.threads.length>20)throw Error("invalid_thread_response");
 const requested=new Set(candidates.map(c=>c.threadId)),seen=new Set<string>();
 for(const row of payload.threads){if(!requested.has(row.thread_id)||seen.has(row.thread_id))throw Error("invalid_thread_response");seen.add(row.thread_id);}
 const threads:OfficialThreadUsage[]=candidates.map(c=>{
  const row=payload.threads.find((r:any)=>r.thread_id===c.threadId),available=row?.data_status==="available";
  if(row&&(!Array.isArray(row.groups)||row.groups.length>500))throw Error("invalid_thread_response");
  return {threadId:c.threadId,title:c.title,createdAtMs:c.createdAtMs,scope:"lifetime",ownershipBasis:c.ownershipBasis??"profile",descendantCount:c.descendantIds.length,dataStatus:available?"available":"unavailable",weeklyLimitPercent:available?metric(row.weekly_limit_percent):null,fiveHourLimitPercent:available?metric(row.five_hour_limit_percent):null,groups:available?row.groups.map((g:any)=>({model:typeof g.model==="string"?g.model.slice(0,200):"unknown",reasoningEffort:typeof g.reasoning_effort==="string"?g.reasoning_effort.slice(0,40):"unknown",weeklyLimitPercent:metric(g.weekly_limit_percent),fiveHourLimitPercent:metric(g.five_hour_limit_percent)})):[]};
 });
 return {threads,threadsAsOfMs:typeof payload.data_as_of==="string"&&Number.isFinite(Date.parse(payload.data_as_of))?Date.parse(payload.data_as_of):null,threadsError:null as string|null};
}
