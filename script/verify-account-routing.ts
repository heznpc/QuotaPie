// Real loopback HTTP backend + relay + dashboard. No provider/account/network access.
// Usage: bun script/verify-account-routing.ts /tmp/quotapie-routing-evidence.json
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AccountPool, savePoolPolicy, type PoolAccount, type PoolPolicy } from "../src/account-pool";
import { startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { startDashboard } from "../src/server";

const output = process.argv[2];
assert(output, "Evidence output path required");
const root = mkdtempSync(join(tmpdir(), "quotapie-routing-check-"));
const model = "gpt-6-astra", poolPath = join(root, "pool.sqlite3"), policyPath = join(root, "pool.json");
let now = Date.now();
const accounts: PoolAccount[] = ["a", "b"].map(id => ({ id, label: `Fixture ${id.toUpperCase()}`, identity:id,
  accessToken:`fixture-${id}`, upstreamAccount:`fixture-${id}`, models:[model], remaining: id === "a" ? 80 : 90,
  tokenExpiresAt:now+3600_000, validUntil:now+600_000 }));
const policy: PoolPolicy = {enabled:true, accounts:["a","b"], reservePercent:{a:30,b:10}};
savePoolPolicy(policy, policyPath);
const pool = new AccountPool({path:poolPath, sourceAccount:"a", accounts:()=>accounts, policy:()=>policy, now:()=>now});
const config = structuredClone(DEFAULT_CONFIG);
config.dashboard.port=0; config.accounts.claude=[]; config.collection.codexEnabled=false;
config.accounts.codex=accounts.map(a=>({id:a.id,label:a.label,enabled:true,codexHome:null}));
config.alerts.enabled=false; config.resetSignals.enabled=false;
const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
const dashboard = startDashboard(service,config,{poolDatabasePath:poolPath,poolPolicyPath:policyPath,compactionRoot:root});
const events: CompactionRequestEvent[] = [], receipts: {account:string; body:any}[] = [];
const completed = () => new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  {headers:{"content-type":"text/event-stream"}});
let respond: (request: Request)=>Response|Promise<Response> = () => completed();
const backend = Bun.serve({hostname:"127.0.0.1",port:0, async fetch(request) {
  const account = request.headers.get("chatgpt-account-id")!;
  const known = accounts.find(a=>a.upstreamAccount===account)!;
  assert(known); assert.equal(request.headers.get("authorization"),`Bearer ${known.accessToken}`);
  receipts.push({account:known.id,body:await request.json()});
  return respond(request);
}});
const relay = startCompactionProxy({accountPool:pool,onRequest:e=>events.push(e),
  taskSavings:{enabled:false,model:"gpt-5.6-luna",effort:"low"},
  fetchUpstream:(_url,init)=>fetch(`http://127.0.0.1:${backend.port}/responses`,init)});
const body = {model,stream:true,input:[{role:"user",content:"fixture: continue"}]};
const history = {...body,input:[...body.input,{type:"reasoning",encrypted_content:"fixture-foreign-cache"},
  {type:"function_call",id:"remote-id",call_id:"fixture-call",name:"fixture",arguments:"{}"},
  {type:"function_call_output",call_id:"fixture-call",output:"fixture saved progress"},
  {role:"assistant",content:"fixture progress"},{role:"user",content:"fixture next step"}]};
const thread=randomUUID();
const request=(input:any=body,id=thread)=>fetch(relay.baseUrl+"/responses",{method:"POST",
  headers:{authorization:"Bearer fixture-a","chatgpt-account-id":"fixture-a",session_id:id},body:JSON.stringify(input)});
const consume=async(response:Response,status=200)=>{assert.equal(response.status,status);return response.text();};
const steps:any[]=[],uiSnapshots:any[]=[];
async function snapshot(name:string,expectedAccount:string,expectedError:string|null=null) {
  now++;
  for(const account of accounts) {
    const observed=Date.now();
    service.collection.recordAttempt("codex",account.id,"codex-appserver",observed,null,null);
    service.ingestCodexSnapshot([{provider:"codex",account:account.id,bucket:"codex:primary:300",label:"5h",windowSeconds:18000,
      usedPercent:100-(account.remaining??50),resetsAtMs:observed+3600_000,observedAtMs:observed,
      source:"codex-app-server",quality:"authoritative"}]);
  }
  const payload:any=await(await fetch(`http://127.0.0.1:${dashboard.port}/api/status`)).json();
  delete payload.actionToken;
  assert.equal(payload.accountPool.recent[0].account,expectedAccount);
  assert.equal(payload.accountPool.error,expectedError);
  const routed=payload.accounts.find((a:any)=>a.account===expectedAccount);
  const remaining=routed.windows[0].remainingPercent;
  steps.push({name,actualBackendAccount:receipts.at(-1)?.account,displayedRouteAccount:expectedAccount,
    routeState:payload.accountPool.recent[0].state,error:expectedError,backendCalls:receipts.length,remaining});
  if(["threshold-transfer","upstream-auth-failed","credential-recovery","partial-stream-failed","opaque-history-blocked","opaque-history-recovered"].includes(name))
    uiSnapshots.push({name,payload,expected:{account:`codex/${expectedAccount}`,remaining,error:expectedError}});
}
try {
  await consume(await request()); assert.equal(receipts.at(-1)!.account,"a");
  await snapshot("initial-source","a");
  accounts[0]!.remaining=30;
  await consume(await request(history)); assert.equal(receipts.at(-1)!.account,"b");
  assert(!JSON.stringify(receipts.at(-1)!.body).includes("fixture-foreign-cache"));
  assert(JSON.stringify(receipts.at(-1)!.body).includes("fixture saved progress"));
  await snapshot("threshold-transfer","b");
  let calls=receipts.length;
  accounts[0]!.remaining=20; accounts[1]!.remaining=10;
  await consume(await request(history),409); assert.equal(receipts.length,calls);
  await snapshot("no-eligible-account","b","pool_reserve_reached");
  accounts[1]!.remaining=null; accounts[1]!.validUntil=0;
  const stale=await request(history); assert.equal(stale.status,409);
  assert.equal((await stale.json() as any).error.code,"pool_reserve_quota_unavailable");
  assert.equal(receipts.length,calls);
  steps.push({name:"stale-quota",error:"pool_reserve_quota_unavailable",backendCalls:receipts.length});
  accounts[1]!.remaining=90; accounts[1]!.validUntil=now+600_000;
  await consume(await request(history)); await snapshot("quota-recovery","b");
  respond=()=>new Response("fixture unauthorized",{status:401});
  await consume(await request(history),401); await snapshot("upstream-auth-failed","b","pool_auth_cooldown");
  calls=receipts.length; await consume(await request(history),401); assert.equal(receipts.length,calls);
  accounts[1]!.accessToken="fixture-refreshed-b"; respond=()=>completed();
  await consume(await request(history)); await snapshot("credential-recovery","b");
  accounts[0]!.remaining=80;
  respond=req=>req.headers.get("chatgpt-account-id")==="fixture-b"
    ? new Response("fixture limited",{status:429,headers:{"retry-after":"1"}}) : completed();
  calls=receipts.length; await consume(await request(history)); assert.equal(receipts.length,calls+2);
  assert.deepEqual(receipts.slice(-2).map(r=>r.account),["b","a"]);
  assert.equal(events.at(-1)!.retryCount,1); await snapshot("rate-limit-recovery","a");
  respond=()=>new Response('data: {"type":"response.output_text.delta","delta":"fixture partial"}\n\n',
    {headers:{"content-type":"text/event-stream"}});
  calls=receipts.length; await consume(await request(history)); assert.equal(receipts.length,calls+1);
  await snapshot("partial-stream-failed","a","pool_request_failed");
  respond=()=>completed(); await consume(await request(history)); await snapshot("stream-recovery","a");
  now+=1001; accounts[0]!.remaining=30;
  calls=receipts.length;
  await consume(await request({...body,input:[...body.input,{type:"compaction",encrypted_content:"fixture-opaque"}]}),409);
  assert.equal(receipts.length,calls); await snapshot("opaque-history-blocked","a","pool_recovery_requires_full_history");
  await consume(await request(history)); await snapshot("opaque-history-recovered","b");
  let controller:ReadableStreamDefaultController<Uint8Array>;
  respond=()=>new Response(new ReadableStream<Uint8Array>({start(c){controller=c;
    c.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"fixture held"}\n\n'));}}),
    {headers:{"content-type":"text/event-stream"}});
  const held=await request(history), reading=held.text();
  const drain:any=await(await fetch(relay.baseUrl+"/quotapie-drain",{method:"POST"})).json();
  assert.equal(drain.activeRequests,1); assert.equal(drain.draining,true);
  await consume(await request(history),503);
  controller!.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'));
  controller!.close(); await reading;
  const health:any=await(await fetch(relay.baseUrl+"/quotapie-health")).json();
  assert.equal(health.activeRequests,0);
  steps.push({name:"drain-preserves-inflight",activeBefore:1,activeAfter:0,newRequestsStatus:503});
  writeFileSync(output,JSON.stringify({result:"pass",kind:"isolated-loopback-http",steps,uiSnapshots,
    limits:["No real account threshold was consumed or changed.","Opaque compaction cannot migrate; full portable history is required."]},null,2)+"\n");
  console.log(JSON.stringify({result:"pass",scenarios:steps.length,backendCalls:receipts.length,evidence:output}));
} finally {relay.stop();backend.stop(true);dashboard.stop(true);pool.close();service.close();rmSync(root,{recursive:true,force:true});}
