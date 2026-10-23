import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../src/config";
import { createRelayRuntime, type RuntimeMemory } from "../src/codex-relay-runtime";
import { profileReference } from "../src/work-boundary";

const model = "gpt-6.1-sol";
const complete = () => new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  { headers: { "content-type": "text/event-stream" } });
async function fixture(run: (f: any) => Promise<void>, relayOptions: any = {}) {
  const root = mkdtempSync(join(tmpdir(), "qp-interactive-pool-")), data = join(root, "data"), configPath = join(root, "config.json");
  mkdirSync(data); const now = Date.now(), thread = randomUUID(), memory: RuntimeMemory = {};
  const config = structuredClone(DEFAULT_CONFIG); config.accounts.claude = [];
  const accounts = ["a", "b"].map((id, index) => {
    const home = join(root, id); mkdirSync(home);
    const token = `test.${Buffer.from(JSON.stringify({ sub: id, exp: (now + 3600000) / 1000 })).toString("base64url")}.test`;
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: id, access_token: token } }));
    utimesSync(authPath, (now - 5000) / 1000, (now - 5000) / 1000);
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: model }] }));
    const rollout = join(home, "rollout.jsonl");
    writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: thread } }) + "\n");
    const db = new Database(join(home, "state_1.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT,rollout_path TEXT)"); db.query("INSERT INTO threads VALUES (?,?)").run(thread, rollout); db.close();
    return { id, home, token, row: { provider: "codex", account: id, profileKey: profileReference(home), collectionState: "recent-success", collectionErrorCategory: null,
      windows: [{ bucket: "codex:primary:300", quality: "authoritative", freshness: "fresh", remainingPercent: index ? 90 : 0,
        observedAtMs: now - 1000, resetsAtMs: now + 3600000, validUntilMs: now + 600000 }] as any[] } };
  });
  config.accounts.codex = accounts.map(a => ({ id: a.id, label: a.id, enabled: true, codexHome: a.home }));
  writeFileSync(configPath, JSON.stringify(config));
  const policy: any = { enabled: true, accounts: ["a", "b"] };
  const publish = () => {
    writeFileSync(join(data, "account-pool.json"), JSON.stringify(policy));
    writeFileSync(join(data, "work-state.json"), JSON.stringify({ schemaVersion: 1, generatedAtMs: now - 1000, expiresAtMs: now + 600000, accounts: accounts.map(a => a.row) }));
  }; publish();
  const previous = { home: process.env.QUOTAPIE_HOME, config: process.env.QUOTAPIE_CONFIG, fetch: globalThis.fetch };
  process.env.QUOTAPIE_HOME = data; process.env.QUOTAPIE_CONFIG = configPath;
  const sent: any[] = []; let serve = async (_request: any): Promise<Response> => complete();
  globalThis.fetch = (async (url: any, init: any) => {
    const request = { url: String(url), headers: new Headers(init.headers), body: await new Response(init.body).text() };
    sent.push(request); return serve(request);
  }) as any;
  const runtime = createRelayRuntime({ port: 45001, token: "a".repeat(48), codex_home: accounts[0]!.home,
    route: { from: "gpt-6-astra", to: "gpt-6-astra", effort: "low" }, taskSavings: { enabled: false, model: "gpt-5.6-luna", effort: "low" }, ...relayOptions }, memory);
  const history = [ { role: "user", content: "Task" }, { type: "reasoning", encrypted_content: "old-cache" },
    { type: "function_call", id: "old-id", call_id: "same-call", name: "tool", arguments: "{}" },
    { type: "function_call_output", call_id: "same-call", output: "done" }, { role: "assistant", content: "Finished earlier part" }, { role: "user", content: "Continue" } ];
  const request = (input: any = { model, input: history, stream: true }, headers: any = {}) => runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/responses`, {
    method: "POST", headers: { authorization: `Bearer ${accounts[0]!.token}`, "chatgpt-account-id": "a", "session_id": thread, ...headers }, body: JSON.stringify(input) }));
  try { await run({ config, accounts, data, policy, publish, sent, request, runtime, memory, thread, history, serve: (f: any) => { serve = f; } }); }
  finally {
    runtime.close(); memory.dispose?.(); globalThis.fetch = previous.fetch;
    if (previous.home === undefined) delete process.env.QUOTAPIE_HOME; else process.env.QUOTAPIE_HOME = previous.home;
    if (previous.config === undefined) delete process.env.QUOTAPIE_CONFIG; else process.env.QUOTAPIE_CONFIG = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
}


import { ExecutionTargetLeaseStore } from "../src/work/execution-target-lease";
import { executionPoolPolicyHash } from "../src/work/execution-target";
import { readPoolPolicy, poolAccounts } from "../src/account-pool";
const turnHeaders = (turn: string) => ({ "x-codex-turn-metadata": JSON.stringify({turn_id:turn}) });
async function prepared(f: any, recordFailure = true) {
  const failed = randomUUID(), turn = randomUUID();
  f.policy.enabled = false; f.publish();
  f.serve(async () => new Response(JSON.stringify({error:{code:"usage_limit_reached"}}), {status:429,headers:{"content-type":"application/json"}}));
  if (recordFailure) await (await f.request(undefined,turnHeaders(failed))).text();
  f.policy.enabled = true; f.publish(); f.sent.length = 0; f.serve(async()=>complete());
  const now = Date.now(), accounts = poolAccounts(f.config), source = accounts.find(a=>a.id==="a")!, targetAccount = accounts.find(a=>a.id==="b")!;
  const bucket = "codex:primary:300", policyId = "auto-test", prompt = `[QuotaPie quota recovery:${policyId}]\nContinue exactly once.`;
  const target:any = { account:"b",profileKey:profileReference(f.accounts[1].home), accountKey:"b".repeat(64),
    identity:targetAccount.identity,sourceIdentity:source.identity,poolPolicyHash:executionPoolPolicyHash(readPoolPolicy()),
    selectedAtMs:now,expiresAtMs:now+60000,budgetByBucket:{[bucket]:{reservePercent:5,maxUsagePercent:10}},
    baselineByBucket:{[bucket]:{observationId:"real-boundary",atMs:f.accounts[1].row.windows[0].observedAtMs,remainingPercent:90,epoch:String(f.accounts[1].row.windows[0].resetsAtMs)}} };
  const policy:any = { id:policyId,revision:1,provider:"codex",purpose:"quota-resume",dispatchOwner:"local",maxTurns:1,
    account:"a",profileKey:profileReference(f.accounts[0].home),accountKey:"a".repeat(64),nativeSessionId:f.thread,model,prompt,
    quotaResume:{turnId:failed,stamp:"real-failure"}};
  const store = new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  const lease = store.request(policy,randomUUID(),randomUUID(),target,now,{pid:123,startedAtMs:now-60000});
  store.close();
  const ack = () => f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/quotapie-execution-target/ack`,
    {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({executionId:lease.executionId,digest:lease.digest})}));
  const recover = (text=prompt,headers:any=turnHeaders(turn)) => f.request({model,input:[...f.history.slice(0,-1),{role:"user",content:text}],stream:true},headers);
  return {lease,target,turn,failed,ack,recover,policy};
}

test("fixed execution requires same live source failure then pins exact target through the same turn",()=>fixture(async f=>{
  const p=await prepared(f); const ack=await p.ack(); expect(ack.status).toBe(200);
  expect(await ack.json()).toMatchObject({executionId:p.lease.executionId,digest:p.lease.digest,targetIdentity:p.target.identity});
  await (await p.recover()).text(); expect(f.sent).toHaveLength(1); expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
  expect(f.sent[0].headers.get("session_id")).toBe(f.thread);
  const result=await f.request({model,input:[{type:"compaction",encrypted_content:"B-owned"}]},turnHeaders(p.turn));
  expect(result.status).toBe(200); await result.text(); expect(f.sent).toHaveLength(2); expect(f.sent[1].headers.get("chatgpt-account-id")).toBe("b");
}));
test("a hot-reloaded relay replaces an obsolete DB adapter while retaining generation and existing leases",()=>fixture(async f=>{
  const p=await prepared(f);expect((await p.ack()).status).toBe(200);
  const memory=f.memory.executionTarget,previous=memory.store,generation=memory.instanceId;
  Object.defineProperty(previous,"runtimeApiVersion",{value:6});
  Object.defineProperty(previous,"bindRequest",{value:()=>{throw new Error("obsolete-v6-binding");}});
  Object.defineProperty(previous,"validateLocalRecoveryPermit",{value:undefined});
  expect((await p.ack()).status).toBe(200);
  expect(memory.store).not.toBe(previous);expect(memory.instanceId).toBe(generation);
  expect(memory.store.runtimeApiVersion).toBe(ExecutionTargetLeaseStore.RUNTIME_API_VERSION);
  expect(memory.store.get(p.lease.executionId)?.digest).toBe(p.lease.digest);
  expect(()=>previous.get(p.lease.executionId)).toThrow();
  const response=await p.recover();expect(response.status).toBe(200);await response.text();
  expect(f.sent).toHaveLength(1);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));

test("ACK without this listener's actual failed source turn does not dispatch",()=>fixture(async f=>{
  const p=await prepared(f,false); const ack=await p.ack(); expect(ack.status).toBe(409);
  expect(await ack.json()).toMatchObject({error:{code:"execution-target-native-route-unverified"}});
  const result=await p.recover(); expect(result.status).toBeGreaterThanOrEqual(400); await result.text();expect(f.sent).toHaveLength(0);
}));

for(const targetAccount of ["a","b"])test(`consolidated B consent uses physical A proof and freezes ${targetAccount}; B auth change revokes it`,()=>fixture(async f=>{
  const previous=await prepared(f),accounts=poolAccounts(f.config),a=accounts.find(v=>v.id==="a")!,b=accounts.find(v=>v.id==="b")!;
  f.accounts[0].row.windows[0].remainingPercent=90;f.publish();
  const policy={...previous.policy,account:"b",profileKey:profileReference(f.accounts[1].home),accountKey:"b".repeat(64)};
  const owner={account:"a",profileKey:profileReference(f.accounts[0].home)!,accountKey:"a".repeat(64),identity:a.identity,manifestSHA256:"c".repeat(64)};
  const target={...previous.target,account:targetAccount,identity:targetAccount==="a"?a.identity:b.identity,
    profileKey:profileReference(f.accounts[targetAccount==="a"?0:1].home),accountKey:targetAccount.repeat(64),sessionOwner:owner,consentIdentity:b.identity};
  const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  try{
    store.closeLease(previous.lease.executionId,previous.lease.digest,"fixture-replaced");
    const lease=store.request(policy,randomUUID(),randomUUID(),target,Date.now(),previous.lease.source.nativeOwner);
    const relay=createExecutionTargetRelay({sourceAccount:"a",codexHome:f.accounts[0].home,config:()=>f.config,
      sourceGuard:createSubscriptionGuard({sourceAccount:"a",codexHome:f.accounts[0].home,config:()=>f.config,executionMode:"interactive",quotaObservationMode:"advisory"}),
      memory:f.memory.executionTarget,sessionLocation:()=>({account:"b",ownerAccount:"a",credentialRoot:realpathSync(f.accounts[1].home),
        sessionRoot:realpathSync(f.accounts[0].home),consolidated:true,threadIds:new Set([f.thread]),manifestSHA256:owner.manifestSHA256})});
    const ack=await relay.acknowledge({executionId:lease.executionId,digest:lease.digest});
    expect(ack.sourceProfileKey).toBe(owner.profileKey);
    const request={threadId:f.thread,turnId:randomUUID(),body:{input:[{role:"user",content:policy.prompt}]},model};
    const selected=await relay.resolve(request);expect(selected?.account.id).toBe(targetAccount);
    expect(selected?.lease.source.account).toBe("a");expect(selected?.lease.source.consent?.account).toBe("b");
    writeFileSync(join(f.accounts[1].home,"auth.json"),JSON.stringify({auth_mode:"chatgpt",tokens:{account_id:"changed",access_token:f.accounts[1].token}}));
    await expect(relay.resolve(request)).rejects.toThrow("pool_execution_target_source_changed");
    expect(f.sent).toHaveLength(0);
  }finally{store.close();}
}));

test("fixed target 429 never selects source or any other account",()=>fixture(async f=>{
  const p=await prepared(f); await (await p.ack()).text(); f.accounts[0].row.windows[0].remainingPercent=100; f.publish();
  f.serve(async()=>new Response("quota",{status:429})); const result=await p.recover(); expect(result.status).toBe(429);await result.text();
  expect(f.sent).toHaveLength(1);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));
test("a proven fixed B quota failure permits the same source session after only B recovers",()=>fixture(async f=>{
  const p=await prepared(f);expect((await p.ack()).status).toBe(200);
  f.serve(async()=>new Response(JSON.stringify({error:{code:"usage_limit_reached"}}),{status:429,
    headers:{"content-type":"application/json","retry-after":"0"}}));
  const failed=await p.recover();expect(failed.status).toBe(429);await failed.text();
  expect(f.memory.executionTarget.routes.has(f.thread+":"+p.turn)).toBe(true);
  expect(f.sent).toHaveLength(1);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
  f.accounts[1].row.windows[0].remainingPercent=0;f.publish();
  await new Promise(resolve=>setTimeout(resolve,1100));
  f.accounts[1].row.windows[0].remainingPercent=90;f.accounts[1].row.windows[0].observedAtMs=Date.now();f.publish();
  expect(f.accounts[0].row.windows[0].remainingPercent).toBe(0);
  const policy={...p.policy,id:"after-b-reset",prompt:"[QuotaPie quota recovery:after-b-reset]\nContinue once.",quotaResume:{turnId:p.turn,stamp:"fixed-b-quota-failure"}};
  const target=structuredClone(p.target);target.selectedAtMs=Date.now();target.expiresAtMs=Date.now()+60000;
  target.baselineByBucket["codex:primary:300"].atMs=f.accounts[1].row.windows[0].observedAtMs;
  target.baselineByBucket["codex:primary:300"].observationId="recovered-b";
  const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  try{
    const next=store.request(policy,randomUUID(),randomUUID(),target,Date.now(),p.lease.source.nativeOwner);
    const ack=await f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/quotapie-execution-target/ack`,
      {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({executionId:next.executionId,digest:next.digest})}));
    expect(ack.status).toBe(200);await ack.text();f.serve(async()=>complete());
    const response=await f.request({model,input:[{role:"user",content:policy.prompt}],stream:true},turnHeaders(randomUUID()));
    expect(response.status).toBe(200);await response.text();expect(f.sent).toHaveLength(2);
    expect(f.sent[1].headers.get("chatgpt-account-id")).toBe("b");expect(f.sent[1].headers.get("session_id")).toBe(f.thread);
  }finally{store.close();}
}));
test("ordinary pooled B quota errors never create a native source recovery proof",()=>fixture(async f=>{
  const turn=randomUUID();
  f.serve(async()=>new Response(JSON.stringify({error:{code:"usage_limit_reached"}}),{status:429,headers:{"content-type":"application/json"}}));
  const response=await f.request(undefined,turnHeaders(turn));expect(response.status).toBe(429);await response.text();
  expect(f.sent).toHaveLength(1);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
  expect(f.memory.executionTarget.routes.has(f.thread+":"+turn)).toBe(false);
}));
for(const variant of ["verified","compaction","missing-manifest","wrong-source","wrong-thread","changed-stamp","not-enrolled","invalid-fixed-receipt"])
test(`consolidated ordinary pool failure needs exact primary route and fresh host evidence: ${variant}`,()=>fixture(async f=>{
  const p=await prepared(f,false),failed=randomUUID();
  const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  try{
    store.closeLease(p.lease.executionId,p.lease.digest,"fixture-replaced");
    f.serve(async()=>new Response(JSON.stringify({error:{code:"usage_limit_reached"}}),{status:429,headers:{"content-type":"application/json"}}));
    const response=variant==="compaction"?await f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/responses/compact`,{
      method:"POST",headers:{authorization:`Bearer ${f.accounts[0].token}`,"chatgpt-account-id":"a",session_id:f.thread,...turnHeaders(failed)},
      body:JSON.stringify({model,input:f.history})})):await f.request(undefined,turnHeaders(failed));
    expect(response.status).toBe(429);await response.text();
    const event=f.runtime.snapshot().recent.find((e:any)=>e.turnId===failed&&e.phase==="failed");expect(event).toBeDefined();
    const accounts=poolAccounts(f.config),a=accounts.find(v=>v.id==="a")!,b=accounts.find(v=>v.id==="b")!;
    const location={account:"b",ownerAccount:"a",credentialRoot:realpathSync(f.accounts[1].home),sessionRoot:realpathSync(f.accounts[0].home),
      consolidated:true,threadIds:new Set([f.thread]),manifestSHA256:"c".repeat(64)};
    const target={...p.target,consentIdentity:b.identity,sessionOwner:{account:"a",profileKey:profileReference(f.accounts[0].home),accountKey:"a".repeat(64),identity:a.identity,manifestSHA256:location.manifestSHA256}};
    const policy={...p.policy,account:"b",profileKey:profileReference(f.accounts[1].home),accountKey:"b".repeat(64),quotaResume:{turnId:variant==="invalid-fixed-receipt"?p.failed:failed,stamp:"actual-current-stamp"}};
    const lease=store.request(policy,randomUUID(),randomUUID(),target,Date.now(),p.lease.source.nativeOwner);
    if(variant==="invalid-fixed-receipt") {
      store.acknowledge(lease.executionId,lease.digest,f.memory.executionTarget.instanceId,lease.source.profileKey);
      store.bindCorrelatedTurn(lease.executionId,lease.digest,f.memory.executionTarget.instanceId,
        {threadId:f.thread,turnId:failed,clientUserMessageId:lease.clientUserMessageId});
    }
    const relay=createExecutionTargetRelay({sourceAccount:"a",codexHome:f.accounts[0].home,config:()=>f.config,memory:f.memory.executionTarget,
      sourceGuard:createSubscriptionGuard({sourceAccount:"a",codexHome:f.accounts[0].home,config:()=>f.config,executionMode:"interactive",quotaObservationMode:"advisory"}),
      sessionLocation:()=>location,sessionOrigins:()=>variant==="missing-manifest"?[]:[{account:"b",enabled:true,label:"B",sessionRoot:location.sessionRoot,threadIds:location.threadIds}],
      readFailureEvidence:async()=>({threadId:variant==="wrong-thread"?randomUUID():f.thread,turnId:failed,stamp:variant==="changed-stamp"?"changed":policy.quotaResume.stamp,
        failedAtMs:Date.parse(event.at),cwd:"/fixture",model})});
    if(variant==="not-enrolled"){f.policy.accounts=["a"];f.publish();}
    relay.recordRoute(variant==="wrong-source"?{...event,accountRouting:{...event.accountRouting,sourceAccount:"b"}}:event);
    const key=f.thread+":"+failed;
    if(["missing-manifest","wrong-source","not-enrolled","invalid-fixed-receipt"].includes(variant))expect(f.memory.executionTarget.routes.has(key)).toBe(false);
    else expect(f.memory.executionTarget.routes.get(key)?.pooledHost).toMatchObject({account:"b",quotaAccount:"b",requestId:event.requestId});
    if(["verified","compaction"].includes(variant))expect(await relay.acknowledge({executionId:lease.executionId,digest:lease.digest})).toMatchObject({sourceProfileKey:target.sessionOwner.profileKey});
    else await expect(relay.acknowledge({executionId:lease.executionId,digest:lease.digest})).rejects.toThrow("pool_execution_target_native_route_unverified");
    expect(f.sent).toHaveLength(1);
  }finally{store.close();}
}));
test("fixed B route proof requires exact durable request, turn, target identity and provider origin",()=>fixture(async f=>{
  const p=await prepared(f);await(await p.ack()).text();
  f.serve(async()=>new Response("quota",{status:429}));await(await p.recover()).text();
  const memory=f.memory.executionTarget,key=f.thread+":"+p.turn;
  const event=f.runtime.snapshot().recent.find((event:any)=>event.turnId===p.turn&&event.phase==="failed");
  expect(event).toBeDefined();const relay=resolver(f,async()=>null);
  for(const patch of [{requestId:randomUUID()},{turnId:randomUUID()},{failureOrigin:"relay"},
    {accountRouting:{...event.accountRouting,account:"other"}},{accountRouting:{...event.accountRouting,sourceAccount:"other"}}]){
    memory.routes.delete(key);relay.recordRoute({...event,...patch});expect(memory.routes.has(key)).toBe(false);
    if(patch.turnId)expect(memory.routes.has(f.thread+":"+patch.turnId)).toBe(false);
  }
  const db=new Database(join(f.data,"execution-target-leases.sqlite3"));
  try{
    const row:any=db.query("SELECT value FROM execution_target_leases WHERE id=?").get(p.lease.executionId),lease=JSON.parse(row.value);
    for(const variant of ["identity","request","not-finished","generation"]){
      const changed=structuredClone(lease);
      if(variant==="identity")changed.upstreamResponse.identity="wrong";
      if(variant==="request")changed.targetRequest.requestId="wrong";
      if(variant==="not-finished")changed.targetRequest.state="started";
      if(variant==="generation")changed.relayInstanceId="wrong";
      db.query("UPDATE execution_target_leases SET value=? WHERE id=?").run(JSON.stringify(changed),lease.executionId);
      memory.routes.delete(key);relay.recordRoute(event);expect(memory.routes.has(key)).toBe(false);
    }
    db.query("UPDATE execution_target_leases SET value=? WHERE id=?").run(JSON.stringify(lease),lease.executionId);
    relay.recordRoute(event);expect(memory.routes.has(key)).toBe(true);
  }finally{db.close();}
}));

for(const reason of ["wrong-prompt","revoked","budget","unknown-turn","expired","identity"]) test(`fixed execution denies ${reason} without an ordinary routing escape`,()=>fixture(async f=>{
  const p=await prepared(f); expect((await p.ack()).status).toBe(200);
  if(reason==="revoked") {f.policy.enabled=false;f.publish();}
  if(reason==="budget") {f.accounts[1].row.windows[0].remainingPercent=79;f.publish();}
  if(reason==="identity") {writeFileSync(join(f.accounts[1].home,"auth.json"),JSON.stringify({auth_mode:"chatgpt",tokens:{account_id:"changed",access_token:f.accounts[1].token}}));}
  if(reason==="expired") {const db=new Database(join(f.data,"execution-target-leases.sqlite3"));const row:any=db.query("SELECT value FROM execution_target_leases WHERE id=?").get(p.lease.executionId);const lease=JSON.parse(row.value);lease.authorizationValidUntilMs=Date.now()-1;db.query("UPDATE execution_target_leases SET value=? WHERE id=?").run(JSON.stringify(lease),lease.executionId);db.close();}
  const result=await p.recover(reason==="wrong-prompt"?p.policy.prompt+"changed":p.policy.prompt,reason==="unknown-turn"?{}:turnHeaders(p.turn));
  expect(result.status).toBeGreaterThanOrEqual(400);await result.text();expect(f.sent).toHaveLength(0);
}));

test("bound native tool and unknown turn remain inside target authorization",()=>fixture(async f=>{
  const p=await prepared(f);await(await p.ack()).text();await(await p.recover()).text();
  const result=await f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/alpha/search`,{
    method:"POST",headers:{authorization:`Bearer ${f.accounts[0].token}`,"chatgpt-account-id":"a",session_id:f.thread,...turnHeaders(p.turn)},body:"{}"}));
  expect(result.status).toBe(200);await result.text();expect(f.sent).toHaveLength(2);expect(f.sent[1].headers.get("chatgpt-account-id")).toBe("b");
  const missing=await f.request({model,input:[{type:"compaction",encrypted_content:"B-owned"}]});
  expect(missing.status).toBeGreaterThanOrEqual(400);await missing.text();expect(f.sent).toHaveLength(2);
}));

import { createExecutionTargetRelay, executionTargetRelayMemory } from "../src/execution-target-relay";
import { createSubscriptionGuard } from "../src/subscription-guard";
function resolver(f:any,correlate:any, restart=false) {
  return createExecutionTargetRelay({sourceAccount:"a",codexHome:f.accounts[0].home,config:()=>f.config,
    sourceGuard:createSubscriptionGuard({sourceAccount:"a",codexHome:f.accounts[0].home,config:()=>f.config,executionMode:"interactive",quotaObservationMode:"advisory"}),
    memory:restart?executionTargetRelayMemory():f.memory.executionTarget,correlate});
}
for(const variant of ["current","missing-receipt","other-receipt","closed","expired","forged-prompt","unknown-marker"])
test(`native pre-turn compact with historical recovery marker requires ${variant}`,()=>fixture(async f=>{
  const p=await prepared(f);expect((await p.ack()).status).toBe(200);
  const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  try{
    store.bindCorrelatedTurn(p.lease.executionId,p.lease.digest,f.memory.executionTarget.instanceId,
      {threadId:f.thread,turnId:p.turn,clientUserMessageId:p.lease.clientUserMessageId});
    store.closeLease(p.lease.executionId,p.lease.digest,"previous-host-turn-ended");
    const policy={...p.policy,id:"next-native-recovery",prompt:"[QuotaPie quota recovery:next-native-recovery]\nContinue."};
    const lease=store.request(policy,randomUUID(),randomUUID(),p.target,Date.now(),p.lease.source.nativeOwner);
    const ack=await f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/quotapie-execution-target/ack`,
      {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({executionId:lease.executionId,digest:lease.digest})}));
    expect(ack.status).toBe(200);await ack.text();
    const turn=randomUUID(),body={model,input:[{type:"compaction",encrypted_content:"original-history"},{role:"user",content:p.policy.prompt}]};
    if(variant==="closed")store.closeLease(lease.executionId,lease.digest,"authorization-ended");
    if(variant==="expired"){
      const db=new Database(join(f.data,"execution-target-leases.sqlite3")),current=store.get(lease.executionId)!;
      current.authorizationValidUntilMs=Date.now()-1;db.query("UPDATE execution_target_leases SET value=? WHERE id=?").run(JSON.stringify(current),lease.executionId);db.close();
    }
    if(variant==="forged-prompt")body.input[1]!.content=policy.prompt+" modified";
    if(variant==="unknown-marker")body.input[1]!.content="[QuotaPie quota recovery:never-authorized]\nChanged request";
    const correlated:string[]=[];
    const relay=resolver(f,async(candidate:any)=>{correlated.push(candidate.executionId);return variant==="missing-receipt"?null:{threadId:f.thread,turnId:variant==="other-receipt"?randomUUID():turn,status:"inProgress",errorCode:null,completedAtMs:null};});
    if(variant!=="current"){
      await expect(relay.resolve({threadId:f.thread,turnId:turn,body,model})).rejects.toThrow();
      expect(f.sent).toHaveLength(0);expect(store.get(lease.executionId)?.targetRequest).toBeUndefined();return;
    }
    expect((await relay.resolve({threadId:f.thread,turnId:turn,body,model}))?.lease.executionId).toBe(lease.executionId);
    expect(correlated).toEqual([lease.executionId]);
    f.serve(async()=>new Response(JSON.stringify({output:[{type:"compaction",encrypted_content:"B-compact"}]}),{headers:{"content-type":"application/json"}}));
    const response=await rawRecovery(f,{turn},JSON.stringify(body),"/responses/compact");expect(response.status).toBe(200);await response.text();
    expect(f.sent).toHaveLength(1);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
    expect(store.get(p.lease.executionId)?.state).toBe("closed");expect(store.get(p.lease.executionId)?.turnId).toBe(p.turn);
    expect(store.get(lease.executionId)?.turnId).toBe(turn);expect(store.get(lease.executionId)?.targetRequest?.state).toBe("completed");
  }finally{store.close();}
}));
for(const acknowledged of [false,true]) for(const context of [false,true])
test(`only a proven pre-ACK closure is ignored by the next recovery (old ACK ${acknowledged}, context ${context})`,()=>fixture(async f=>{
  const p=await prepared(f);
  if(acknowledged)expect((await p.ack()).status).toBe(200);
  const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  try{
    store.closeLease(p.lease.executionId,p.lease.digest,"preflight-unavailable");
    const next=store.request(p.policy,randomUUID(),randomUUID(),p.target,Date.now(),p.lease.source.nativeOwner);
    const ack=await f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/quotapie-execution-target/ack`,
      {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({executionId:next.executionId,digest:next.digest})}));
    expect(ack.status).toBe(200);await ack.text();
    const body={model,input:[...f.history.slice(0,-1),{role:"user",content:p.policy.prompt}],stream:true};
    if(context){
      body.input.push({role:"user",content:"<environment_context>current host context</environment_context>"});
      const correlated:string[]=[];
      const relay=resolver(f,async(lease:any)=>{correlated.push(lease.executionId);return {threadId:f.thread,turnId:p.turn,status:"inProgress",errorCode:null,completedAtMs:null};});
      if(acknowledged)await expect(relay.resolve({threadId:f.thread,turnId:p.turn,body,model})).rejects.toThrow();
      else {
        expect((await relay.resolve({threadId:f.thread,turnId:p.turn,body,model}))?.lease.executionId).toBe(next.executionId);
        expect(correlated).toEqual([next.executionId]);
      }
    }
    if(!context || !acknowledged){
      const response=await f.request(body,turnHeaders(p.turn));await response.text();
      if(acknowledged)expect(response.status).toBeGreaterThanOrEqual(400);else expect(response.status).toBe(200);
    }
    expect(f.sent).toHaveLength(acknowledged?0:1);
    if(!acknowledged){expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");expect(f.sent[0].headers.get("session_id")).toBe(f.thread);}
    expect(store.get(p.lease.executionId)?.state).toBe("closed");expect(store.get(p.lease.executionId)?.turnId).toBeUndefined();
    expect(store.list()).toHaveLength(2);
  }finally{store.close();}
}));
for(const variant of ["current-prompt","pre-turn-compact","missing-old","missing-current","old-completed","old-current-turn","old-wrong-thread","new-other-turn","forged-prompt","unknown-marker"])
test(`a new quota episode resolves an old unbound failed lease only with official receipts: ${variant}`,()=>fixture(async f=>{
  const p=await prepared(f);expect((await p.ack()).status).toBe(200);
  const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  try{
    store.closeLease(p.lease.executionId,p.lease.digest,"previous-host-turn-ended");
    const policy={...p.policy,id:"new-quota-episode",prompt:"[QuotaPie quota recovery:new-quota-episode]\nContinue."};
    const lease=store.request(policy,randomUUID(),randomUUID(),p.target,Date.now(),p.lease.source.nativeOwner);
    const ack=await f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/quotapie-execution-target/ack`,
      {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({executionId:lease.executionId,digest:lease.digest})}));
    expect(ack.status).toBe(200);await ack.text();
    const turn=randomUUID(),body={model,input:[{type:"compaction",encrypted_content:"original-history"},{role:"user",content:p.policy.prompt}]};
    if(variant!=="pre-turn-compact")body.input.push({role:"user",content:variant==="unknown-marker"?"[QuotaPie quota recovery:unknown]\nChanged":policy.prompt+(variant==="forged-prompt"?" altered":"")});
    const relay=resolver(f,async(candidate:any)=>{
      if(candidate.executionId===p.lease.executionId){
        if(variant==="missing-old")return null;
        return {threadId:variant==="old-wrong-thread"?randomUUID():f.thread,turnId:variant==="old-current-turn"?turn:p.turn,
          status:variant==="old-completed"?"completed":"failed",errorCode:null,completedAtMs:Math.floor(Date.now()/1000)*1000};
      }
      if(variant==="missing-current")return null;
      return {threadId:f.thread,turnId:variant==="new-other-turn"?randomUUID():turn,status:"inProgress",errorCode:null,completedAtMs:null};
    });
    if(!["current-prompt","pre-turn-compact"].includes(variant)){
      await expect(relay.resolve({threadId:f.thread,turnId:turn,body,model})).rejects.toThrow();
      expect(store.get(p.lease.executionId)?.turnId).toBeUndefined();expect(store.get(lease.executionId)?.turnId).toBeUndefined();expect(f.sent).toHaveLength(0);return;
    }
    expect((await relay.resolve({threadId:f.thread,turnId:turn,body,model}))?.lease.executionId).toBe(lease.executionId);
    expect(store.get(p.lease.executionId)?.turnId).toBe(p.turn);expect(store.get(p.lease.executionId)?.state).toBe("closed");
    expect(store.get(p.lease.executionId)?.targetRequest).toBeUndefined();expect(store.get(p.lease.executionId)?.localRecoveryPermit).toBeUndefined();
    const response=await rawRecovery(f,{turn},JSON.stringify(body),variant==="pre-turn-compact"?"/responses/compact":"/responses");
    expect(response.status).toBe(200);await response.text();expect(f.sent).toHaveLength(1);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
    expect(store.get(lease.executionId)?.turnId).toBe(turn);
  }finally{store.close();}
}));
test("one typed local repair uses original quota route proof, preserves old failed turn, and survives an unsent ACK failure",()=>fixture(async f=>{
  const p=await prepared(f);expect((await p.ack()).status).toBe(200);
  const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  try{
    store.closeLease(p.lease.executionId,p.lease.digest,"host-queue-execution-ended");
    const at=Date.now(),childPolicyId="auto-test-local-repair";
    const permit=store.createLocalRecoveryPermit({parentExecutionId:p.lease.executionId,childPolicyId,sourceQuotaTurnId:p.failed,goalFingerprint:"1".repeat(64),
      host:{threadId:f.thread,turnId:p.turn,clientUserMessageId:p.lease.clientUserMessageId,status:"failed",
        errorType:"quotapie_subscription_guard",errorCode:"subscription_pool_execution_target_conflict",completedAtMs:at},
      relay:{instanceId:f.memory.executionTarget.instanceId,requestId:randomUUID(),status:400,origin:"relay",reason:"pool_execution_target_conflict",observedAtMs:at}},at);
    const policy={...p.policy,id:childPolicyId,prompt:`[QuotaPie quota recovery:${childPolicyId}]\nContinue exactly once.`,
      quotaResume:{turnId:p.turn,stamp:"actual-local-failed-turn",localBeforeSendRecovery:{permitId:permit.id,parentExecutionId:p.lease.executionId,sourceQuotaTurnId:p.failed}}};
    const child=()=>store.request(policy,randomUUID(),randomUUID(),p.target,Date.now(),p.lease.source.nativeOwner);
    const ack=(lease:any)=>f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/quotapie-execution-target/ack`,
      {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({executionId:lease.executionId,digest:lease.digest})}));
    const blocked=child();f.accounts[1].row.windows[0].remainingPercent=0;f.publish();
    expect((await ack(blocked)).status).toBe(409);
    expect(store.get(p.lease.executionId)?.localRecoveryPermit?.consumedExecutionId).toBeUndefined();
    store.closeLease(blocked.executionId,blocked.digest,"preflight-unavailable");
    f.accounts[1].row.windows[0].remainingPercent=90;f.publish();
    const ready=child();expect((await ack(ready)).status).toBe(200);expect((await ack(ready)).status).toBe(200);
    expect(ready.source.failedTurnId).toBe(p.turn);expect(ready.source.sourceQuotaTurnId).toBe(p.failed);
    expect(f.memory.executionTarget.routes.has(f.thread+":"+p.turn)).toBe(false);
    expect(store.get(p.lease.executionId)?.turnId).toBe(p.turn);
    expect(store.get(p.lease.executionId)?.localRecoveryPermit?.consumedExecutionId).toBe(ready.executionId);
    const turn=randomUUID(),body={model,input:[...f.history.slice(0,-1),{role:"user",content:p.policy.prompt},{role:"user",content:policy.prompt}],stream:true};
    const result=await f.request(body,turnHeaders(turn));expect(result.status).toBe(200);await result.text();
    expect(f.sent).toHaveLength(1);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");expect(f.sent[0].headers.get("session_id")).toBe(f.thread);
    store.closeLease(ready.executionId,ready.digest,"host-queue-execution-ended");
    expect(()=>child()).toThrow();
    const replay=await p.recover();expect(replay.status).toBeGreaterThanOrEqual(400);await replay.text();expect(f.sent).toHaveLength(1);
    const manual=await f.request({model,input:[...body.input,{role:"assistant",content:"Done"},{role:"user",content:"New manual task"}],stream:true},turnHeaders(randomUUID()));
    expect(manual.status).toBe(200);await manual.text();expect(f.sent).toHaveLength(2);
  }finally{store.close();}
}));
for(const kind of ["current","other","missing","expired-current","closed-restart-other"]) test(`official message receipt distinguishes host context ${kind}`,()=>fixture(async f=>{
  const p=await prepared(f);await(await p.ack()).text();const other=randomUUID();
  if(kind.startsWith("expired") || kind.startsWith("closed")) {
    const db=new Database(join(f.data,"execution-target-leases.sqlite3"));const row:any=db.query("SELECT value FROM execution_target_leases WHERE id=?").get(p.lease.executionId);
    const lease=JSON.parse(row.value);lease.authorizationValidUntilMs=Date.now()-1;
    if(kind.startsWith("closed")) lease.state="closed";
    db.query("UPDATE execution_target_leases SET value=? WHERE id=?").run(JSON.stringify(lease),lease.executionId);db.close();
  }
  const different=kind==="other"||kind==="closed-restart-other";
  const proof=kind==="missing"?null:{threadId:f.thread,turnId:different?other:p.turn,status:different?"completed":"inProgress",errorCode:null,completedAtMs:different?Math.floor(Date.now()/1000)*1000:null};
  const relay=resolver(f,async()=>proof,kind==="closed-restart-other");
  const body={model,input:[...f.history.slice(0,-1),{role:"user",content:p.policy.prompt},{role:"user",content:"<environment_context>current host context</environment_context>"}]};
  if(kind==="missing"||kind==="expired-current") {
    await expect(relay.resolve({threadId:f.thread,turnId:p.turn,body,model})).rejects.toThrow();expect(f.sent).toHaveLength(0);
  } else if(different) {
    expect(await relay.resolve({threadId:f.thread,turnId:p.turn,body,model})).toBeNull();
  } else {
    expect((await relay.resolve({threadId:f.thread,turnId:p.turn,body,model}))?.account.id).toBe("b");
    const result=await f.request(body,turnHeaders(p.turn));expect(result.status).toBe(200);await result.text();expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
  }
}));

for(const count of [1,2]) test(`manual pre-turn compact reconciles ${count} closed unbound recovery markers without reauthorizing them`,()=>fixture(async f=>{
  const p=await prepared(f);expect((await p.ack()).status).toBe(200);
  const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  try{
    store.closeLease(p.lease.executionId,p.lease.digest,"host-queue-execution-ended");
    const historical=[{lease:p.lease,turn:p.turn,prompt:p.policy.prompt}];
    if(count===2){
      const policy={...p.policy,id:"second-failed-recovery",prompt:"[QuotaPie quota recovery:second-failed-recovery]\nContinue once."};
      const lease=store.request(policy,randomUUID(),randomUUID(),p.target,Date.now(),p.lease.source.nativeOwner);
      store.acknowledge(lease.executionId,lease.digest,f.memory.executionTarget.instanceId,lease.source.profileKey);
      store.closeLease(lease.executionId,lease.digest,"host-queue-execution-ended");
      historical.push({lease,turn:randomUUID(),prompt:policy.prompt});
    }
    const turn=randomUUID(),body={model,input:[{type:"compaction",encrypted_content:"native-history"},
      ...historical.map(old=>({role:"user",content:old.prompt}))]};
    const seen:string[]=[],relay=resolver(f,async(lease:any)=>{
      seen.push(lease.executionId);const old=historical.find(old=>old.lease.executionId===lease.executionId)!;
      return {threadId:f.thread,turnId:old.turn,status:"failed",errorCode:"other",completedAtMs:Math.floor(Date.now()/1000)*1000};
    });
    expect(await relay.resolve({threadId:f.thread,turnId:turn,body,model,historyOnly:true})).toBeNull();
    expect(seen).toHaveLength(count);
    for(const old of historical){
      expect(store.get(old.lease.executionId)).toMatchObject({state:"closed",turnId:old.turn});
      expect(store.get(old.lease.executionId)?.targetRequest).toBeUndefined();
    }
    f.serve(async()=>Response.json({output:[{type:"compaction",encrypted_content:"source-compact"}]}));
    const raw=JSON.stringify(body),response=await rawRecovery(f,{turn},raw,"/responses/compact");
    expect(response.status).toBe(200);await response.text();expect(f.sent).toHaveLength(1);
    expect(f.sent[0].body).toBe(raw);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("a");
    const replay=await rawRecovery(f,{turn:randomUUID()},raw,"/responses");
    expect(replay.status).toBe(400);await replay.text();expect(f.sent).toHaveLength(1);
  }finally{store.close();}
}));

for(const variant of ["missing","wrong-thread","current-turn","still-running","duplicate-turn","before-ack","future"])
test(`closed historical marker still fails closed without distinct terminal host receipts: ${variant}`,()=>fixture(async f=>{
  const p=await prepared(f);expect((await p.ack()).status).toBe(200);
  const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  try{
    store.closeLease(p.lease.executionId,p.lease.digest,"host-queue-execution-ended");
    if(variant==="duplicate-turn"){
      const policy={...p.policy,id:"second-failed-recovery",prompt:"[QuotaPie quota recovery:second-failed-recovery]\nContinue once."};
      const lease=store.request(policy,randomUUID(),randomUUID(),p.target,Date.now(),p.lease.source.nativeOwner);
      store.acknowledge(lease.executionId,lease.digest,f.memory.executionTarget.instanceId,lease.source.profileKey);
      store.closeLease(lease.executionId,lease.digest,"host-queue-execution-ended");
    }
    const turn=randomUUID(),body={model,input:[{role:"user",content:p.policy.prompt},
      ...(variant==="duplicate-turn"?[{role:"user",content:"[QuotaPie quota recovery:second-failed-recovery]\nContinue once."}]:[])]};
    const relay=resolver(f,async()=>variant==="missing"?null:{threadId:variant==="wrong-thread"?randomUUID():f.thread,
      turnId:variant==="current-turn"?turn:p.turn,status:variant==="still-running"?"inProgress":"failed",errorCode:"other",
      completedAtMs:variant==="before-ack"?Date.now()-60000:variant==="future"?Date.now()+60000:Math.floor(Date.now()/1000)*1000});
    await expect(relay.resolve({threadId:f.thread,turnId:turn,body,model,historyOnly:true})).rejects.toThrow("pool_execution_target_message_unverified");
    expect(store.get(p.lease.executionId)?.turnId).toBeUndefined();expect(store.get(p.lease.executionId)?.targetRequest).toBeUndefined();
    expect(f.sent).toHaveLength(0);
  }finally{store.close();}
}));

test("an acknowledged attempt closed before enqueue cannot block an unrelated new manual turn",()=>fixture(async f=>{
  const p=await prepared(f);expect((await p.ack()).status).toBe(200);
  const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  try{
    store.closeLease(p.lease.executionId,p.lease.digest,"queue-failed-before-enqueue");
    let correlations=0;const relay=resolver(f,async()=>{correlations++;return null;});
    const body={model,input:[{role:"user",content:"My unrelated new manual request"}]};
    expect(await relay.resolve({threadId:f.thread,turnId:randomUUID(),body,model})).toBeNull();
    expect(correlations).toBe(0);expect(store.get(p.lease.executionId)?.turnId).toBeUndefined();
  }finally{store.close();}
}));

for(const body of ["invalid-json",JSON.stringify({input:[]})]) test(`bound inference holds uninspected body ${body}`,()=>fixture(async f=>{
  const p=await prepared(f);await(await p.ack()).text();await(await p.recover()).text();
  const result=await f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/responses`,{method:"POST",
    headers:{authorization:`Bearer ${f.accounts[0].token}`,"chatgpt-account-id":"a",session_id:f.thread,...turnHeaders(p.turn)},body}));
  expect(result.status).toBeGreaterThanOrEqual(400);await result.text();expect(f.sent).toHaveLength(1);
}));

test("native tool cannot adopt target remote state before a completed target response",()=>fixture(async f=>{
  const p=await prepared(f);await(await p.ack()).text();
  const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  store.bindCorrelatedTurn(p.lease.executionId,p.lease.digest,f.memory.executionTarget.instanceId,{threadId:f.thread,turnId:p.turn,clientUserMessageId:p.lease.clientUserMessageId});store.close();
  const result=await f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/alpha/search`,{method:"POST",
    headers:{authorization:`Bearer ${f.accounts[0].token}`,"chatgpt-account-id":"a",session_id:f.thread,...turnHeaders(p.turn)},body:"{}"}));
  expect(result.status).toBeGreaterThanOrEqual(400);await result.text();expect(f.sent).toHaveLength(0);
}));

test("target response evidence is written only after provider response",()=>fixture(async f=>{
  const p=await prepared(f);await(await p.ack()).text();const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
  expect(store.get(p.lease.executionId)?.upstreamResponse).toBeUndefined();
  await(await p.recover()).text();expect(store.get(p.lease.executionId)?.upstreamResponse).toMatchObject({identity:p.target.identity,status:200,turnId:p.turn});store.close();
}));

test("native tool conflicting thread identity cannot escape its bound target",()=>fixture(async f=>{
  const p=await prepared(f);await(await p.ack()).text();await(await p.recover()).text();
  const result=await f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/alpha/search`,{method:"POST",
    headers:{authorization:`Bearer ${f.accounts[0].token}`,"chatgpt-account-id":"a",session_id:f.thread,"thread-id":randomUUID(),
      "x-codex-turn-metadata":JSON.stringify({thread_id:f.thread,turn_id:p.turn})},body:"{}"}));
  expect(result.status).toBeGreaterThanOrEqual(400);await result.text();expect(f.sent).toHaveLength(1);
}));

test("new manual turn after bound execution keeps ordinary continuation",()=>fixture(async f=>{
  const p=await prepared(f);await(await p.ack()).text();await(await p.recover()).text();
  const body={model,input:[...f.history.slice(0,-1),{role:"user",content:p.policy.prompt},{role:"assistant",content:"Recovery done"},{role:"user",content:"My new request"}]};
  const result=await f.request(body,turnHeaders(randomUUID()));expect(result.status).toBe(200);await result.text();expect(f.sent).toHaveLength(2);
}));

for(const reason of ["lease-expired","target-budget","source-identity"]) test(`fixed in-flight guard stops ${reason} without replay`,()=>fixture(async f=>{
  const p=await prepared(f);await(await p.ack()).text();
  f.serve(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));}}),{headers:{"content-type":"text/event-stream"}}));
  const response=await p.recover();
  if(reason==="target-budget"){f.accounts[1].row.windows[0].remainingPercent=79;f.publish();}
  else if(reason==="source-identity") writeFileSync(join(f.accounts[0].home,"auth.json"),JSON.stringify({auth_mode:"chatgpt",tokens:{account_id:"changed",access_token:f.accounts[0].token}}));
  else {const db=new Database(join(f.data,"execution-target-leases.sqlite3"));const row:any=db.query("SELECT value FROM execution_target_leases WHERE id=?").get(p.lease.executionId);const lease=JSON.parse(row.value);lease.authorizationValidUntilMs=Date.now()-1;db.query("UPDATE execution_target_leases SET value=? WHERE id=?").run(JSON.stringify(lease),lease.executionId);db.close();}
  const body=await response.text();expect(body).toContain("partial");expect(body).toContain("response.failed");expect(f.sent).toHaveLength(1);
}));

test("a restarted native owner cannot reuse a previous process's failed route proof",()=>fixture(async f=>{
  const p=await prepared(f);const db=new Database(join(f.data,"execution-target-leases.sqlite3"));const row:any=db.query("SELECT value FROM execution_target_leases WHERE id=?").get(p.lease.executionId);const lease=JSON.parse(row.value);lease.source.nativeOwner.startedAtMs=Date.now()+1;db.query("UPDATE execution_target_leases SET value=? WHERE id=?").run(JSON.stringify(lease),lease.executionId);db.close();
  const ack=await p.ack();expect(ack.status).toBe(409);expect(await ack.json()).toMatchObject({error:{code:"execution-target-native-route-unverified"}});expect(f.sent).toHaveLength(0);
}));

for(const variant of ["preserved","wrong-pid","wrong-profile","new-identity-age","future-event","wrong-source","non-quota","foreign-target","owner-restarted"]) test(`same listener hot reload proof ${variant}`,()=>fixture(async f=>{
  const p=await prepared(f), snapshot=structuredClone(f.runtime.snapshot()), memory=executionTargetRelayMemory();
  const event=snapshot.recent.find((e:any)=>e.turnId===p.failed&&e.phase==="failed");expect(event).toBeDefined();
  const inheritedSource={identity:f.memory.guard.boundIdentity,atMs:f.memory.guard.boundAuthAtMs};
  if(variant==="wrong-pid")snapshot.pid++;
  if(variant==="wrong-profile")snapshot.subscriptionGuard.profileKey="wrong";
  if(variant==="wrong-source")snapshot.subscriptionGuard.account="other";
  if(variant==="new-identity-age")inheritedSource.atMs=Date.parse(event.at)+1;
  if(variant==="future-event")event.at=new Date(Date.now()+10000).toISOString();
  if(variant==="non-quota")event.serverError={type:"rate_limit_error"};
  if(variant==="foreign-target")event.accountRouting={sourceAccount:"a",account:"b"};
  if(variant==="owner-restarted") {
    const db=new Database(join(f.data,"execution-target-leases.sqlite3"));const row:any=db.query("SELECT value FROM execution_target_leases WHERE id=?").get(p.lease.executionId);const lease=JSON.parse(row.value);lease.source.nativeOwner.startedAtMs=Date.parse(event.at)+1;
    db.query("UPDATE execution_target_leases SET value=? WHERE id=?").run(JSON.stringify(lease),lease.executionId);db.close();
  }
  const relay=createExecutionTargetRelay({sourceAccount:"a",codexHome:f.accounts[0].home,config:()=>f.config,memory,inheritedSource,
    sourceGuard:createSubscriptionGuard({sourceAccount:"a",codexHome:f.accounts[0].home,config:()=>f.config,executionMode:"interactive",quotaObservationMode:"advisory"}),
    readLiveSnapshot:async()=>snapshot});
  try {
    if(variant==="preserved") {
      expect(await relay.acknowledge({executionId:p.lease.executionId,digest:p.lease.digest})).toMatchObject({relayInstanceId:memory.instanceId});
      expect(memory.routes.get(f.thread+":"+p.failed)?.atMs).toBe(Date.parse(event.at));
    } else await expect(relay.acknowledge({executionId:p.lease.executionId,digest:p.lease.digest})).rejects.toThrow("pool_execution_target_native_route_unverified");
    expect(f.sent).toHaveLength(0);
  } finally {memory.store?.close();}
}));

for(const created of [false,true]) for(const context of [false,true]) test(`same-account recovery without a target lease remains native source with store ${created} context ${context}`,()=>fixture(async f=>{
  if(created){const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));store.close();}
  const turn=randomUUID(),body={model,input:[...f.history.slice(0,-1),{role:"user",content:"[QuotaPie quota recovery:source-only]\\nContinue"},{role:"user",content:"<environment_context>context</environment_context>"}]};
  if(!context)body.input.pop();
  const response=await f.request(body,turnHeaders(turn));expect(response.status).toBe(200);await response.text();expect(f.sent).toHaveLength(1);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("a");
  const next=await f.request({model,input:[{type:"compaction",encrypted_content:"source-only-cache"}]},turnHeaders(turn));expect(next.status).toBe(200);await next.text();expect(f.sent[1].headers.get("chatgpt-account-id")).toBe("a");
}));
for(const context of [false,true])test(`an unanswered historical recovery marker does not pin a new manual turn (context ${context})`,()=>fixture(async f=>{
  const body={model,input:[{role:"user",content:"[QuotaPie quota recovery:old-failed]\nContinue"},
    {role:"user",content:"My new manual request"}],stream:true};
  if(context)body.input.push({role:"user",content:"<environment_context>current host context</environment_context>"});
  const response=await f.request(body,turnHeaders(randomUUID()));expect(response.status).toBe(200);await response.text();
  expect(f.sent).toHaveLength(1);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
}));

for(const state of ["expired","closed"]) test(`historical target turn cannot escape ${state} fence by omitting turn identity`,()=>fixture(async f=>{
  const p=await prepared(f);await(await p.ack()).text();await(await p.recover()).text();
  const db=new Database(join(f.data,"execution-target-leases.sqlite3"));const row:any=db.query("SELECT value FROM execution_target_leases WHERE id=?").get(p.lease.executionId);const lease=JSON.parse(row.value);lease.expiresAtMs=Date.now()-1;
  if(state==="closed")lease.state="closed";
  db.query("UPDATE execution_target_leases SET value=? WHERE id=?").run(JSON.stringify(lease),lease.executionId);db.close();
  const result=await f.request({model,input:[{type:"compaction",encrypted_content:"B-cache"}]});expect(result.status).toBeGreaterThanOrEqual(400);await result.text();expect(f.sent).toHaveLength(1);
}));


function rawRecovery(f:any,p:any,body:string,path="/responses") {
  return f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex${path}`,{method:"POST",
    headers:{authorization:`Bearer ${f.accounts[0].token}`,"chatgpt-account-id":"a",session_id:f.thread,
      "content-type":"application/json",...turnHeaders(p.turn)},body}));
}
for (const path of ["/responses","/responses/compact"]) test(`native encrypted history stays byte-identical on fixed ${path}`,()=>fixture(async f=>{
  const p=await prepared(f);expect((await p.ack()).status).toBe(200);
  const input={model,input:[{type:"compaction",id:"original-compaction-id",encrypted_content:"native-encrypted-history"},
    {type:"reasoning",id:"original-reasoning-id",encrypted_content:"native-reasoning"},
    ...f.history.slice(2,-1),{role:"user",id:"original-user-id",content:p.policy.prompt}],reasoning:{effort:"high"},stream:true};
  const raw=JSON.stringify(input,null,3)+"\n";
  const response=await rawRecovery(f,p,raw,path);expect(response.status).toBe(200);await response.text();
  expect(f.sent).toHaveLength(1);expect(f.sent[0].body).toBe(raw);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
  expect(f.sent[0].headers.get("session_id")).toBe(f.thread);
  const db=new Database(join(f.data,"account-pool.sqlite3"));
  expect(db.query("SELECT COUNT(*) AS n FROM replay_filters").get()).toMatchObject({n:0});db.close();
},{route:{from:model,to:"gpt-5.6-luna",effort:"low"},taskSavings:{enabled:true,model:"gpt-5.6-luna",effort:"low"}}));

for(const outcome of ["completed","provider-rejected","truncated"])
  test(`native fixed compact then response retains one target and gates ${outcome}`,()=>fixture(async f=>{
    const p=await prepared(f);expect((await p.ack()).status).toBe(200);
    const compactOutput=[{type:"compaction",id:"new-compact-id",encrypted_content:"B-produced-ciphertext"}];
    f.serve(async()=>outcome==="provider-rejected"
      ? new Response(JSON.stringify({error:{code:"compact_rejected"}}),{status:400,headers:{"content-type":"application/json"}})
      : new Response(outcome==="truncated"?'{"output":':JSON.stringify({id:"compact-result",output:compactOutput}),{headers:{"content-type":"application/json"}}));
    const compactRaw=JSON.stringify({model,input:[{type:"compaction",id:"old-compact-id",encrypted_content:"source-ciphertext"},
      {role:"user",content:p.policy.prompt}],reasoning:{effort:"high"}},null,2)+"\n";
    const compact=await rawRecovery(f,p,compactRaw,"/responses/compact");await compact.text();
    expect(f.sent).toHaveLength(1);expect(f.sent[0].body).toBe(compactRaw);
    const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
    const first=store.get(p.lease.executionId)!;
    expect(first.targetRequest?.state).toBe(outcome==="completed"?"completed":outcome==="truncated"?"unverified":"failed");
    f.serve(async()=>complete());
    const responseRaw=JSON.stringify({model,input:compactOutput,stream:true},null,3)+"\n";
    const response=await rawRecovery(f,p,responseRaw);await response.text();
    if(outcome==="completed"){
      expect(response.status).toBe(200);expect(f.sent).toHaveLength(2);expect(f.sent[1].body).toBe(responseRaw);
      const final=store.get(p.lease.executionId)!;
      expect(final.turnId).toBe(p.turn);expect(final.targetRequest?.state).toBe("completed");
      expect(final.targetRequest?.requestId).not.toBe(first.targetRequest?.requestId);
      expect(final.targetRequestFingerprints).toHaveLength(2);
    }else{expect(response.status).toBeGreaterThanOrEqual(400);expect(f.sent).toHaveLength(1);}
    for(const sent of f.sent){expect(sent.headers.get("chatgpt-account-id")).toBe("b");expect(sent.headers.get("session_id")).toBe(f.thread);}
    store.close();
  },{route:{from:model,to:"gpt-5.6-luna",effort:"low"},taskSavings:{enabled:true,model:"gpt-5.6-luna",effort:"low"}}));

for(const kind of ["previous-response","conversation","item-reference","file","nested-file","remote-image","provider-tool","additional-provider-tool","wrong-model"])
  test(`native fixed import rejects ${kind} before provider`,()=>fixture(async f=>{
    const p=await prepared(f);await(await p.ack()).text();
    const input:any={model,input:[{type:"compaction",encrypted_content:"native-history"},{role:"user",content:p.policy.prompt}],stream:true};
    if(kind==="previous-response")input.previous_response_id="resp-foreign";
    if(kind==="conversation")input.conversation="conv-foreign";
    if(kind==="item-reference")input.input.unshift({type:"item_reference",id:"remote-item"});
    if(kind==="file")input.input.unshift({role:"user",content:[{type:"input_file",file_id:"foreign-file"}]});
    if(kind==="nested-file")input.input[0].metadata={nested:{file_id:"foreign-file"}};
    if(kind==="remote-image")input.input.unshift({role:"user",content:[{type:"input_image",image_url:"https://example.com/private.png"}]});
    if(kind==="provider-tool")input.tools=[{type:"file_search",vector_store_ids:["store-a"]}];
    if(kind==="additional-provider-tool")input.input.unshift({type:"additional_tools",role:"developer",tools:[{type:"code_interpreter",container:"container-a"}]});
    if(kind==="wrong-model")input.model="gpt-6-astra";
    const response=await rawRecovery(f,p,JSON.stringify(input));expect(response.status).toBeGreaterThanOrEqual(400);await response.text();expect(f.sent).toHaveLength(0);
  }));

for(const outcome of ["transport","401","403","429","500","partial"])
  test(`native fixed import ${outcome} is attempted only once and never proves ownership`,()=>fixture(async f=>{
    const p=await prepared(f);await(await p.ack()).text();
    f.serve(async()=>{
      if(outcome==="transport")throw Object.assign(new Error("connection lost"),{code:"ECONNRESET"});
      if(outcome==="partial")return new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n',{headers:{"content-type":"text/event-stream"}});
      return new Response(JSON.stringify({error:{type:"native_fixture_rejection"}}),{status:Number(outcome),headers:{"content-type":"application/json"}});
    });
    const input={model,input:[{type:"compaction",encrypted_content:"native-history"},{role:"user",content:p.policy.prompt}],stream:true};
    const response=await rawRecovery(f,p,JSON.stringify(input));await response.text();expect(f.sent).toHaveLength(1);
    expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("b");
    const db=new Database(join(f.data,"account-pool.sqlite3"));expect(db.query("SELECT COUNT(*) AS n FROM binding_proofs").get()).toMatchObject({n:0});db.close();
    const tool=await f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/alpha/search`,{method:"POST",
      headers:{authorization:`Bearer ${f.accounts[0].token}`,"chatgpt-account-id":"a",session_id:f.thread,...turnHeaders(p.turn)},body:"{}"}));
    expect(tool.status).toBeGreaterThanOrEqual(400);await tool.text();expect(f.sent).toHaveLength(1);
    const retried=await rawRecovery(f,p,JSON.stringify(input));expect(retried.status).toBeGreaterThanOrEqual(400);await retried.text();expect(f.sent).toHaveLength(1);
  }));


test("native concurrent inference and completed duplicate cannot send twice; next tool output can continue",()=>fixture(async f=>{
  const p=await prepared(f);await(await p.ack()).text();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});f.serve(async()=>{await gate;return complete();});
  const input={model,input:[{type:"compaction",encrypted_content:"native-history"},{role:"user",content:p.policy.prompt}],stream:true};
  const raw=JSON.stringify(input),first=rawRecovery(f,p,raw);
  for(let i=0;i<30&&!f.sent.length;i++)await new Promise(resolve=>setTimeout(resolve,2));
  expect(f.sent).toHaveLength(1);
  const second=await rawRecovery(f,p,raw);expect(second.status).toBe(409);await second.text();expect(f.sent).toHaveLength(1);
  release();await(await first).text();
  const duplicate=await rawRecovery(f,p,raw);expect(duplicate.status).toBe(409);await duplicate.text();expect(f.sent).toHaveLength(1);
  const next=await f.request({model,input:[...input.input,{type:"function_call",call_id:"new-call",name:"tool",arguments:"{}"},{type:"function_call_output",call_id:"new-call",output:"new result"}],stream:true},turnHeaders(p.turn));
  expect(next.status).toBe(200);await next.text();expect(f.sent).toHaveLength(2);
}));


for(const variant of ["completed-open","completed-then-foreign-same-chunk","partial-open"])
  test(`fixed target terminal frame admission handles ${variant}`,()=>fixture(async f=>{
    const p=await prepared(f);await(await p.ack()).text();let cancelled=false;
    f.serve(async()=>new Response(new ReadableStream({start(controller){
      const valid=variant==="partial-open"?{type:"response.output_text.delta",delta:"partial"}:{type:"response.completed",response:{status:"completed"}};
      const bad={type:"response.output_text.delta",internal_chat_message_metadata_passthrough:{turn_id:randomUUID()},delta:"foreign"};
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(valid)}\n\n`+
        (variant==="completed-then-foreign-same-chunk"?`data: ${JSON.stringify(bad)}\n\n`:"")));
    },cancel(){cancelled=true;}}),{headers:{"content-type":"text/event-stream"}}));
    const response=await p.recover(),reader=response.body!.getReader();await reader.read();
    const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
    expect(store.get(p.lease.executionId)?.targetRequest?.state).toBe(variant==="completed-open"?"completed":variant==="partial-open"?"started":"failed");store.close();
    f.serve(async()=>complete());
    const next=await f.request({model,input:[...f.history,{role:"user",content:p.policy.prompt},{type:"function_call",call_id:"next-call",name:"tool",arguments:"{}"},{type:"function_call_output",call_id:"next-call",output:"next result"}],stream:true},turnHeaders(p.turn));
    expect(next.status).toBe(variant==="completed-open"?200:variant==="partial-open"?409:400);await next.text();
    expect(f.sent).toHaveLength(variant==="completed-open"?2:1);
    if(variant!=="partial-open")expect(cancelled).toBe(true);
    await reader.cancel();
  }));


test("hot reload replaces obsolete pool routing for new requests and retains the old in-flight DB handle",()=>fixture(async f=>{
 let stream!:ReadableStreamDefaultController<Uint8Array>;
 f.serve(async()=>new Response(new ReadableStream<Uint8Array>({start(c){stream=c;c.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'))}}),{headers:{"content-type":"text/event-stream"}}));
 const inflight=await f.request(),old=f.memory.interactivePool;expect(old).toBeDefined();
 Object.defineProperty(old,"runtimeApiVersion",{value:4});
 const next=createRelayRuntime({port:45001,token:"a".repeat(48),codex_home:f.accounts[0].home,
   route:{from:"gpt-6-astra",to:"gpt-6-astra",effort:"low"},taskSavings:{enabled:false,model:"gpt-5.6-luna",effort:"low"}},f.memory);
 f.serve(async()=>complete());
 try{
  const response=await next.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/responses`,{method:"POST",
    headers:{authorization:`Bearer ${f.accounts[0].token}`,"chatgpt-account-id":"a",session_id:f.thread},body:JSON.stringify({model,input:f.history,stream:true})}));
  expect(response.status).toBe(200);await response.text();expect(f.memory.interactivePool).not.toBe(old);
  expect(f.memory.interactivePool.runtimeApiVersion).toBe(6);
  expect(await old.canRecoverAsync("a",model,{model,input:f.history})).toBe(true);
  stream.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'));stream.close();
  expect(await inflight.text()).toContain("response.completed");expect(f.sent).toHaveLength(2);
 }finally{next.close()}
}));

for(const behavior of ["completed","budget-change"])test(`recovered source frozen lease ${behavior} retains its own quota budget`,()=>fixture(async f=>{
 const p=await prepared(f);expect((await p.ack()).status).toBe(200);
 const store=new ExecutionTargetLeaseStore(join(f.data,"execution-target-leases.sqlite3"));
 try{
  store.closeLease(p.lease.executionId,p.lease.digest,"host-queue-execution-ended");
  const at=Date.now(),id="source-repair";
  const permit=store.createLocalRecoveryPermit({parentExecutionId:p.lease.executionId,childPolicyId:id,sourceQuotaTurnId:p.failed,goalFingerprint:"1".repeat(64),
    host:{threadId:f.thread,turnId:p.turn,clientUserMessageId:p.lease.clientUserMessageId,status:"failed",errorType:"quotapie_subscription_guard",errorCode:"subscription_pool_execution_target_conflict",completedAtMs:at},
    relay:{instanceId:f.memory.executionTarget.instanceId,requestId:randomUUID(),status:400,origin:"relay",reason:"pool_execution_target_conflict",observedAtMs:at}},at);
  f.accounts[0].row.windows[0].remainingPercent=90;f.accounts[0].row.windows[0].observedAtMs=Date.now();f.publish();
  const policy={...p.policy,id,prompt:`[QuotaPie quota recovery:${id}]\nContinue exactly once.`,quotaResume:{turnId:p.turn,stamp:"local-failure",
    localBeforeSendRecovery:{permitId:permit.id,parentExecutionId:p.lease.executionId,sourceQuotaTurnId:p.failed}}};
  const target={...p.target,account:"a",profileKey:p.policy.profileKey,accountKey:p.policy.accountKey,identity:p.target.sourceIdentity,
    selectedAtMs:Date.now(),baselineByBucket:{"codex:primary:300":{...p.target.baselineByBucket["codex:primary:300"],atMs:f.accounts[0].row.windows[0].observedAtMs}}};
  const lease=store.request(policy,randomUUID(),randomUUID(),target,Date.now(),p.lease.source.nativeOwner);
  const ack=await f.runtime.fetch(new Request(`http://127.0.0.1/${"a".repeat(48)}/backend-api/codex/quotapie-execution-target/ack`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({executionId:lease.executionId,digest:lease.digest})}));
  expect(ack.status).toBe(200);await ack.text();
  if(behavior==="budget-change")f.serve(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'))}}),{headers:{"content-type":"text/event-stream"}}));
  const response=await f.request({model,input:[{role:"user",content:policy.prompt}],stream:true},turnHeaders(randomUUID()));
  expect(response.status).toBe(200);expect(f.sent).toHaveLength(1);expect(f.sent[0].headers.get("chatgpt-account-id")).toBe("a");
  if(behavior==="budget-change"){f.accounts[0].row.windows[0].remainingPercent=79;f.accounts[0].row.windows[0].observedAtMs=Date.now();f.publish();}
  const text=await response.text();expect(text).toContain(behavior==="completed"?"response.completed":"response.failed");expect(f.sent).toHaveLength(1);
 }finally{store.close()}
}));
