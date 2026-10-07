import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { AccountPool, isFreshTextTurn, PoolError, poolStatus, savePoolPolicy, type PoolAccount } from "../src/account-pool";
import { startCompactionProxy } from "../src/codex-compaction";

const now=2_000_000_000_000;
const body={model:"gpt-6-astra",input:[{role:"user",content:"synthetic"}],stream:true};
const inlineImage = { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" };
function account(id:string,remaining:number|null):PoolAccount {return {id,label:id,identity:id+"-identity",accessToken:id+"-token",upstreamAccount:id+"-remote",tokenExpiresAt:now+3600_000,models:[body.model],remaining,validUntil:now+60_000};}
function fixture(work:(f:{pool:AccountPool; accounts:PoolAccount[]; policy:{enabled:boolean;accounts:string[]};path:string;select:(thread?:string,input?:unknown)=>ReturnType<AccountPool["select"]>})=>void, initialSourceRemaining: number | null = 0) {
  const dir=mkdtempSync(join(tmpdir(),"qp-pool-test-")),path=join(dir,"pool.sqlite3");
  const accounts=[account("a",initialSourceRemaining),account("b",75)],policy={enabled:true,accounts:["a","b"]};
  const pool=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now});
  const select=(thread:string=randomUUID(),input:unknown=body)=>pool.select({threadId:thread,requestId:randomUUID(),body:input,model:body.model,
    headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})});
  try {work({pool,accounts,policy,path,select});} finally {pool.close();rmSync(dir,{recursive:true,force:true});}
}

test("new text work uses a healthy other account without persisting credentials",()=>fixture(({path,select})=>{
  const result=select()!;
  expect(result.route).toMatchObject({sourceAccount:"a",account:"b",reason:"new"});
  expect(result.headers.get("authorization")).toBe("Bearer b-token");
  expect(result.headers.get("chatgpt-account-id")).toBe("b-remote");
  const status=poolStatus(path,join(dirname(path),"missing.json"));
  expect(JSON.stringify(status)).not.toContain("token");
  expect(JSON.stringify(status)).not.toContain("synthetic");
}));

test("bindings survive restart, quota ordering changes and disabling new selection",()=>fixture(({pool,path,accounts,policy,select})=>{
  const thread=randomUUID(); select(thread); accounts[0]!.remaining=99; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1; policy.enabled=false;
  const second=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now});
  try {
    const selected=second.select({threadId:thread,requestId:randomUUID(),body:{...body,previous_response_id:"response"},model:body.model,
      headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})});
    expect(selected?.route).toMatchObject({account:"b",reason:"pinned"});
    expect(select()).toBeNull();
  } finally {second.close();}
}));

test("an unregistered continuation never migrates its account",()=>fixture(({select,accounts})=>{
  accounts[0]!.remaining=20; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  for (const input of [{...body,previous_response_id:"resp"},{...body,input:[{role:"assistant",content:"old"}]},
    {...body,input:[{type:"compaction",encrypted_content:"opaque"}]},{...body,input:[{role:"user",content:[{type:"input_image",image_url:"file"}]}]}])
    expect(select(randomUUID(),input)?.route).toMatchObject({account:"a",reason:"existing"});
}));

test("exhausted source quota blocks paid fallback when no eligible account exists",()=>fixture(({select,accounts})=>{
  for (const patch of [{remaining:0},{remaining:null},{validUntil:now-1},{tokenExpiresAt:now-1},{models:[]}]) {
    Object.assign(accounts[1]!,account("b",75),patch);
    expect(()=>select()).toThrow("pool_source_quota_exhausted");
  }
}));

test("source fallback creates a durable binding when another account later recovers",()=>fixture(({select,accounts})=>{
  accounts[0]!.remaining=null; accounts[1]!.remaining=null;
  const thread=randomUUID();
  expect(select(thread)?.route.account).toBe("a");
  accounts[1]!.remaining=90;
  expect(select(thread,{...body,previous_response_id:"original-login-response"})?.route).toMatchObject({account:"a",reason:"pinned"});
}, null));

test("an exhausted bound account cannot forward nonportable history to paid usage",()=>fixture(({select,accounts})=>{
  const thread=randomUUID();
  expect(select(thread)?.route.account).toBe("b");
  accounts[1]!.remaining=0; accounts[0]!.remaining=99; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  expect(()=>select(thread,{...body,input:[{type:"compaction",encrypted_content:"opaque"}]}))
    .toThrow("pool_recovery_requires_full_history");
}));

test("a portable continuation returns to its original login when quota recovers",()=>fixture(({select,accounts})=>{
  const thread=randomUUID();
  expect(select(thread)?.route).toMatchObject({account:"b",reason:"new"});
  accounts[0]!.remaining=99; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  const returned=select(thread,{...body,input:[...body.input,{role:"assistant",content:"previous reply"},
    {role:"user",content:"continue"}]})!;
  expect(returned.route).toMatchObject({account:"a",reason:"recovered",previousAccountLabel:"b"});
  expect(select(thread)?.route).toMatchObject({account:"a",reason:"pinned"});
}));

test("an account-bound continuation waits until its source recovers before returning",()=>fixture(({select,accounts})=>{
  const thread=randomUUID(); select(thread);
  accounts[0]!.remaining=99; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  expect(select(thread,{...body,previous_response_id:"other-account-response"})?.route)
    .toMatchObject({account:"b",reason:"pinned"});
}));

test("credential identity changes and account removal never silently rebind",()=>fixture(({select,accounts,policy})=>{
  const thread=randomUUID();select(thread);accounts[1]!.identity="replaced";
  expect(()=>select(thread)).toThrow("pool_bound_identity_changed");
  accounts[1]!.identity="b-identity";policy.accounts=["a"];
  expect(()=>select(thread)).toThrow("pool_bound_account_removed");
}));

test("upstream 429 keeps the selected identity on cooldown with its retry delay",()=>fixture(({pool,select,accounts})=>{
  const thread=randomUUID();select(thread);
  pool.response("not-a-request","b-identity",429,"120");
  try { select(thread); throw new Error("Expected cooldown"); }
  catch (error) {
    expect(error).toBeInstanceOf(PoolError);
    expect(error).toMatchObject({code:"pool_account_cooldown",status:429,retryAfterSeconds:120});
  }
  accounts[0]!.remaining=40; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  expect(select()?.route.account).toBe("a");
}));

for (const status of [401,403]) test(`upstream ${status} quarantines only the rejected token and refresh preserves the binding`,()=>fixture(({pool,select,accounts})=>{
  const thread=randomUUID(), selected=select(thread)!;
  expect(selected.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
  pool.response("not-a-request",selected.identity,status,null,selected.credentialDigest);
  try { select(thread); throw new Error("Expected authentication cooldown"); }
  catch(error) {
    expect(error).toBeInstanceOf(PoolError);
    expect(error).toMatchObject({code:"pool_auth_cooldown",status,retryAfterSeconds:60});
  }
  accounts[1]!.accessToken="b-refreshed-token";
  const refreshed=select(thread)!;
  expect(refreshed.route).toMatchObject({account:"b",reason:"pinned"});
  expect(refreshed.credentialDigest).not.toBe(selected.credentialDigest);
  // A delayed failure for the old request must not quarantine the new token.
  pool.response("late-request",selected.identity,status,null,selected.credentialDigest);
  expect(select(thread)?.headers.get("authorization")).toBe("Bearer b-refreshed-token");
}));

test("cooldown expires when no alternate account has capacity",()=>{
  let time=now;
  const accounts=[account("a",0),account("b",75)];
  const pool=new AccountPool({path:":memory:",sourceAccount:"a",accounts:()=>accounts,
    policy:()=>({enabled:true,accounts:["a","b"]}),now:()=>time});
  const input={threadId:randomUUID(),requestId:randomUUID(),body,model:body.model,
    headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})};
  try {
    pool.select(input);
    pool.response(input.requestId,"b-identity",429,"2"); time+=1001;
    expect(()=>pool.select({...input,requestId:randomUUID()})).toThrow("pool_account_cooldown");
    time+=999;
    expect(pool.select({...input,requestId:randomUUID()})?.route).toMatchObject({account:"b",reason:"pinned"});
  } finally {pool.close();}
});

test("missing thread identity and caller credential mismatch fail closed",()=>fixture(({pool})=>{
  const input={threadId:null,requestId:randomUUID(),body,model:body.model,headers:new Headers()};
  expect(()=>pool.select(input)).toThrow("pool_thread_identity_required");
  expect(()=>pool.select({...input,threadId:randomUUID()})).toThrow("pool_source_identity_mismatch");
}));

test("first text input accepts system context but rejects opaque continuation",()=>{
  expect(isFreshTextTurn({...body,input:[{role:"developer",content:"rules"},...body.input,...body.input]})).toBe(true);
  expect(isFreshTextTurn({...body,conversation:"old"})).toBe(false);
  expect(isFreshTextTurn({...body,input:[]})).toBe(false);
});

test("a pinned conversation accepts inline images and keeps its account on follow-up", () => fixture(({ select, policy, accounts }) => {
  const thread = randomUUID();
  expect(select(thread)?.route.account).toBe("b");
  accounts[0]!.remaining = 99; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  policy.enabled = false;
  const imageTurn = { ...body, input: [...body.input, { role: "assistant", content: "previous response" },
    { role: "user", content: [inlineImage, { type: "input_text", text: "describe" }] }] };
  expect(select(thread, imageTurn)?.route).toMatchObject({ account: "b", reason: "pinned" });
  expect(select(thread, { ...imageTurn, input: [...imageTurn.input, { role: "user", content: "follow-up" }] })?.route.account).toBe("b");
  expect(select(thread, { ...body, input: [{ type: "function_call_output", output: [inlineImage] }] })?.route.account).toBe("b");
}));

test("account-scoped or unverified attachment references cannot silently switch a binding", () => fixture(({ select }) => {
  const thread = randomUUID(); select(thread);
  for (const attachment of [
    { type: "input_image", file_id: "file-private" },
    { ...inlineImage, file_id: "file-private" },
    { type: "input_image", image_url: "https://example.com/private-image" },
    { type: "input_image", image_url: "data:image/png;base64," },
    { type: "input_file", file_id: "file-private" },
  ]) {
    for (const item of [{ role: "user", content: [attachment] }, { type: "function_call_output", output: [attachment] }])
      expect(() => select(thread, { ...body, input: [item] })).toThrow("pool_attachment_account_unverified");
  }
  expect(select(thread)?.route.account).toBe("b");
}));

test("a first image turn stays on the source account", () => fixture(({ select, accounts }) => {
  accounts[0]!.remaining = 20; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  expect(select(randomUUID(), { ...body, input: [{ role: "user", content: [inlineImage] }] })?.route.account).toBe("a");
}));

test("proxy forwards compressed inline images unchanged through the pinned account", async () => {
  const pool = new AccountPool({ path: ":memory:", sourceAccount: "a", accounts: () => [account("a", 0), account("b", 75)],
    policy: () => ({ enabled: true, accounts: ["a", "b"] }), now: () => now });
  const forwarded: Uint8Array[] = [];
  const events: any[] = [];
  const proxy = startCompactionProxy({ accountPool: pool, onRequest: e => events.push(e), fetchUpstream: async (_, init) => {
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer b-token");
    forwarded.push(new Uint8Array(init.body as Uint8Array));
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const headers = { authorization: "Bearer a-token", "chatgpt-account-id": "a-remote", session_id: randomUUID() };
    await (await fetch(proxy.baseUrl + "/responses", { method: "POST", headers, body: JSON.stringify(body) })).text();
    const compressed = gzipSync(JSON.stringify({ ...body, input: [{ role: "user", content: [inlineImage] }] }));
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST", headers: { ...headers, "content-encoding": "gzip" }, body: compressed });
    expect(response.status).toBe(200); await response.text();
    expect(forwarded).toHaveLength(2);
    expect(forwarded[1]).toEqual(new Uint8Array(compressed));
    expect(events.filter(e => e.phase === "completed").map(e => e.inlineImageCount)).toEqual([0, 1]);
  } finally { proxy.stop(); pool.close(); }
});

test("real proxy records selected account and never replays a 429",async()=>{
  const accounts=[account("a",0),account("b",75)];
  const pool=new AccountPool({path:":memory:",sourceAccount:"a",accounts:()=>accounts,policy:()=>({enabled:true,accounts:["a","b"]}),now:()=>now});
  let calls=0; const events:any[]=[];
  const proxy=startCompactionProxy({accountPool:pool,onRequest:e=>events.push(e),fetchUpstream:async(_,init)=>{
    calls++; expect(new Headers(init.headers).get("authorization")).toBe("Bearer b-token");
    return new Response("exhausted",{status:429,headers:{"retry-after":"60"}});
  }});
  try {
    const response=await fetch(proxy.baseUrl+"/responses",{method:"POST",headers:{authorization:"Bearer a-token","chatgpt-account-id":"a-remote",session_id:randomUUID()},body:JSON.stringify(body)});
    expect(response.status).toBe(429);await response.text();
    expect(calls).toBe(1);expect(events.at(-1).accountRouting.account).toBe("b");
    expect(JSON.stringify(events)).not.toContain("b-token");
  } finally {proxy.stop();pool.close();}
});

test("interrupted pooled response is not replayed or reassigned", async () => {
  const accounts = [account("a", 0), account("b", 75)];
  const pool = new AccountPool({ path: ":memory:", sourceAccount: "a", accounts: () => accounts,
    policy: () => ({ enabled: true, accounts: ["a", "b"] }), now: () => now });
  let calls = 0;
  const events: any[] = [];
  const proxy = startCompactionProxy({ accountPool: pool, onRequest: e => events.push(e), fetchUpstream: async () => {
    calls++;
    return new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const thread = randomUUID();
    const response = await fetch(proxy.baseUrl + "/responses", { method: "POST",
      headers: { authorization: "Bearer a-token", "chatgpt-account-id": "a-remote", session_id: thread }, body: JSON.stringify(body) });
    await response.text();
    expect(calls).toBe(1);
    expect(events.at(-1).phase).toBe("failed");
    accounts[0]!.remaining = 99; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
    expect(pool.select({ threadId: thread, requestId: randomUUID(), body, model: body.model,
      headers: new Headers({ authorization: "Bearer a-token", "chatgpt-account-id": "a-remote" }) })?.route)
      .toMatchObject({account:"a",reason:"recovered"});
  } finally { proxy.stop(); pool.close(); }
});

test("separate relay processes agree on a single durable account for concurrent first requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qp-pool-race-"));
  const path = join(directory, "pool.sqlite3"), threadId = randomUUID();
  // Disagree on which account has more quota. Only the first transaction may
  // choose; the other process must observe and retain that committed binding.
  const children = [0, 1].map(index => {
    const accounts = [account("a", index ? 90 : 10), account("b", index ? 10 : 90)];
    const code = `import {AccountPool} from ${JSON.stringify(resolve(import.meta.dir, "../src/account-pool.ts"))};
      const pool = new AccountPool({path:${JSON.stringify(path)}, sourceAccount:"a", accounts:()=>${JSON.stringify(accounts)},
        policy:()=>({enabled:true,accounts:["a","b"]}),now:()=>${now}});
      try {const result=pool.select({threadId:${JSON.stringify(threadId)}, requestId:${JSON.stringify(randomUUID())},
        body:${JSON.stringify(body)},model:${JSON.stringify(body.model)},
        headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})});
        console.log(result.route.account);}finally{pool.close();}`;
    return Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  });
  try {
    const results = await Promise.all(children.map(async child => {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr).toBe(""); expect(code).toBe(0);
      return stdout.trim();
    }));
    expect(["a", "b"]).toContain(results[0]!);
    expect(results[0]).toBe(results[1]);
  } finally { for (const child of children) child.kill(); rmSync(directory, { recursive: true, force: true }); }
});

test("observed source credentials survive refresh and relay restart without accepting another login", () => fixture(({pool, accounts, policy, path, select}) => {
  const thread = randomUUID(); select(thread);
  accounts[0]!.accessToken = "a-refreshed-token";
  expect(select(thread)?.headers.get("authorization")).toBe("Bearer b-token");
  const restarted = new AccountPool({path, sourceAccount:"a", accounts:()=>accounts, policy:()=>policy, now:()=>now});
  const input = {threadId:thread, requestId:randomUUID(), body, model:body.model,
    headers:new Headers({authorization:"Bearer a-token", "chatgpt-account-id":"a-remote"})};
  try {
    expect(restarted.select(input)?.route.account).toBe("b");
    input.headers.set("authorization", "Bearer forged-token");
    expect(()=>restarted.select({...input,requestId:randomUUID()})).toThrow("pool_source_identity_mismatch");
    accounts[0]!.identity = "another-login";
    input.headers.set("authorization", "Bearer a-token");
    expect(()=>restarted.select({...input,requestId:randomUUID()})).toThrow("pool_source_identity_mismatch");
  } finally {restarted.close();}
}));

test("observed file credentials survive a rejected routing transaction and another refresh",()=>fixture(({pool,accounts,policy,path,select})=>{
  const thread=randomUUID(); select(thread);
  accounts[0]!.accessToken="a-first-refresh";
  expect(()=>select(thread,{...body,input:[{role:"user",content:[{type:"input_file",file_id:"account-scoped"}]}]}))
    .toThrow("pool_attachment_account_unverified");
  accounts[0]!.accessToken="a-second-refresh";
  const restarted=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now});
  try {
    const input={threadId:thread,requestId:randomUUID(),body,model:body.model,
      headers:new Headers({authorization:"Bearer a-first-refresh","chatgpt-account-id":"a-remote"})};
    expect(restarted.select(input)?.route).toMatchObject({account:"b",reason:"pinned"});
    input.headers.set("authorization","Bearer never-observed-token");
    expect(()=>restarted.select({...input,requestId:randomUUID()})).toThrow("pool_source_identity_mismatch");
  } finally {restarted.close();}
}));

test("request rejection history is distinct from pool health and only the same task's success proves recovery",()=>fixture(({pool,path})=>{
  const rejectedThread=randomUUID(), rejectedRequest=randomUUID();
  pool.reject("pool_lineage_unavailable",{requestId:rejectedRequest,threadId:rejectedThread,status:409});
  const complete=(threadId:string)=>{
    const requestId=randomUUID();
    const selected=pool.select({threadId,requestId,body,model:body.model,
      headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})})!;
    pool.response(requestId,selected.identity,200,null,selected.credentialDigest);
    pool.finish(requestId,"completed");
  };
  complete(randomUUID());
  const status=poolStatus(path,join(dirname(path),"missing.json"));
  expect(status.error).toBeNull();
  expect(status.unresolvedRejections).toEqual({count:1,latestCode:"pool_lineage_unavailable",latestAtMs:now});
  expect(status.rejected).toEqual([expect.objectContaining({requestId:rejectedRequest,threadId:rejectedThread,
    sourceAccount:"a",code:"pool_lineage_unavailable",status:409,recovered:false})]);
  expect(status.recent).toHaveLength(1);
  expect(status.recent[0]).toMatchObject({account:"b",state:"completed"});
  complete(rejectedThread);
  const recovered=poolStatus(path,join(dirname(path),"missing.json"));
  expect(recovered.error).toBeNull();
  expect(recovered.unresolvedRejections).toBeNull();
  expect(recovered.rejected[0]?.recovered).toBe(true);
}));

test("an old unresolved rejection stays visible after unrelated requests succeed and failed retries do not resolve it",()=>fixture(({pool,path,accounts,policy})=>{
  const threadId=randomUUID();
  pool.reject("pool_lineage_unavailable",{requestId:randomUUID(),threadId,status:409});
  const later=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now+86400_000});
  // Keep synthetic credentials valid, without changing the rejection timestamp.
  for (const a of accounts) { a.tokenExpiresAt=now+2*86400_000; a.validUntil=now+2*86400_000; }
  try {
    for (const [thread,status] of [[randomUUID(),200],[threadId,400]] as const) {
      const requestId=randomUUID();
      const selected=later.select({threadId:thread,requestId,body,model:body.model,
        headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})})!;
      later.response(requestId,selected.identity,status,null,selected.credentialDigest);
      later.finish(requestId,"completed");
    }
    const status=poolStatus(path,join(dirname(path),"missing.json"));
    expect(status.error).toBeNull();
    expect(status.unresolvedRejections).toEqual({count:1,latestCode:"pool_lineage_unavailable",latestAtMs:now});
    expect(status.rejected[0]?.recovered).toBe(false);
  } finally {later.close();}
}));

test("legacy errors clear only after a later successful HTTP response completes",()=>fixture(({pool,path})=>{
  const status=()=>poolStatus(path,join(dirname(path),"missing.json"));
  const request=()=>{
    const requestId=randomUUID();
    const selected=pool.select({threadId:randomUUID(),requestId,body,model:body.model,
      headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})})!;
    return {requestId,selected};
  };
  pool.reject("pool_no_eligible_account");
  const failed=request();
  pool.response(failed.requestId,failed.selected.identity,400,null,failed.selected.credentialDigest);
  pool.finish(failed.requestId,"completed");
  expect(status().error).toBe("pool_no_eligible_account");
  const recovered=request();
  expect(status().error).toBe("pool_no_eligible_account");
  pool.response(recovered.requestId,recovered.selected.identity,200,null,recovered.selected.credentialDigest);
  expect(status().error).toBe("pool_no_eligible_account");
  pool.finish(recovered.requestId,"completed");
  expect(status().error).toBeNull();
}));

test("a completing request preserves legacy errors recorded after it started",()=>fixture(({pool,path,accounts,policy})=>{
  const requestId=randomUUID();
  const selected=pool.select({threadId:randomUUID(),requestId,body,model:body.model,
    headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})})!;
  const later=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now+1});
  try {
    later.reject("pool_request_rejected");
    pool.response(requestId,selected.identity,200,null,selected.credentialDigest);
    pool.finish(requestId,"completed");
    expect(poolStatus(path,join(dirname(path),"missing.json")).error).toBe("pool_request_rejected");
  } finally {later.close();}
}));

test("expired remembered source credentials are rejected", () => {
  let time = now;
  const accounts = [account("a", 20), account("b", 75)];
  accounts[0]!.tokenExpiresAt = now + 60_000;
  const pool = new AccountPool({path:":memory:",sourceAccount:"a",accounts:()=>accounts,policy:()=>({enabled:true,accounts:["a","b"]}),now:()=>time});
  accounts[0]!.accessToken = "refreshed"; accounts[0]!.tokenExpiresAt = now + 3600_000; time += 60_000;
  try { expect(()=>pool.select({threadId:randomUUID(),requestId:randomUUID(),body,model:body.model,
    headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})})).toThrow("pool_source_identity_mismatch"); }
  finally {pool.close();}
});

test("forks inherit the ancestor binding even after new selection is disabled", () => fixture(({select, accounts, policy, path}) => {
  const parent=randomUUID(), child=randomUUID(), middle=randomUUID(); select(parent);
  accounts[0]!.remaining=99; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1; policy.enabled=false;
  const parents:Record<string,string> = {[child]:middle,[middle]:parent};
  const pool=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now,
    forkParent:thread=>({status:"known",parentId:parents[thread]??null})});
  try {
    expect(pool.select({threadId:child,requestId:randomUUID(),body:{...body,input:[{type:"compaction",encrypted_content:"opaque"}]},model:body.model,
      headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})})?.route).toMatchObject({account:"b",reason:"pinned"});
    expect(select(child)?.route.account).toBe("b");
    accounts[1]!.identity="replaced";
    expect(()=>select(child)).toThrow("pool_bound_identity_changed");
  } finally {pool.close();}
}));

test("unavailable history or cyclic fork metadata cannot create a source binding", () => fixture(({accounts, policy, path}) => {
  const thread=randomUUID(); let cycle=false;
  const pool=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now,
    forkParent:()=>cycle?{status:"known",parentId:thread}:{status:"unknown"}});
  const input={threadId:thread,requestId:randomUUID(),body:{...body,previous_response_id:"opaque"},model:body.model,
    headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})};
  try {
    expect(()=>pool.select(input)).toThrow("pool_lineage_unavailable"); cycle=true;
    expect(()=>pool.select(input)).toThrow("pool_lineage_invalid");
  } finally {pool.close();}
}));

test("an ephemeral fresh turn stays on its authenticated source and keeps quota protection", () => fixture(({accounts, policy, path}) => {
  let parent: string | null = null;
  const pool=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now,
    forkParent:()=>parent?{status:"known",parentId:parent}:{status:"unknown"}});
  const input={threadId:randomUUID(),requestId:randomUUID(),body,model:body.model,
    headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})};
  try {
    expect(()=>pool.select(input)).toThrow("pool_source_quota_exhausted");
    accounts[0]!.remaining=90; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
    expect(()=>pool.select({...input,headers:new Headers({authorization:"Bearer wrong","chatgpt-account-id":"a-remote"})})).toThrow("pool_source_identity_mismatch");
    expect(pool.select(input)?.route).toMatchObject({account:"a",reason:"existing"});
    expect(pool.select({...input,requestId:randomUUID(),body:{...body,previous_response_id:"own-response"}})?.route.account).toBe("a");
    parent=randomUUID();
    expect(()=>pool.select({...input,threadId:randomUUID(),requestId:randomUUID()})).toThrow("pool_lineage_invalid");
  } finally {pool.close();}
}));

test("an ephemeral source-only helper can continue portable history with account-bound replay caches removed",()=>fixture(({accounts,policy,path})=>{
  accounts[0]!.remaining=90; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  const pool=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now,
    forkParent:()=>({status:"unknown"})});
  const threadId=randomUUID(), helperModel="gpt-6-luna";
  const history={model:helperModel,input:[
    {role:"user",content:"synthetic"},
    {type:"reasoning",id:"old-reasoning",encrypted_content:"account-bound-cache"},
    {type:"message",role:"assistant",id:"old-message",content:[{type:"output_text",text:"previous reply"}]},
    {type:"function_call",id:"old-call",call_id:"call-1",name:"tool",arguments:"{}"},
    {type:"function_call_output",id:"old-output",call_id:"call-1",output:"result"},
    {role:"user",content:"continue"}
  ]};
  const input={threadId,requestId:randomUUID(),body:history,model:helperModel,
    headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})};
  try {
    expect(isFreshTextTurn(history)).toBe(false);
    const selected=pool.select(input)!;
    const replay=selected.body as {input:any[]};
    expect(selected.route).toMatchObject({account:"a",reason:"existing"});
    expect(selected.headers.get("authorization")).toBe("Bearer a-token");
    expect(replay.input).toHaveLength(history.input.length-1);
    expect(replay.input.every((item:any)=>item.type!=="reasoning" && item.id==null)).toBe(true);
    expect(replay.input.find((item:any)=>item.type==="function_call_output")?.output).toBe("result");
    expect(pool.select({...input,requestId:randomUUID()})?.body).toEqual(selected.body);
    expect(history.input[1]?.encrypted_content).toBe("account-bound-cache");
  } finally {pool.close();}
}));

test("ephemeral portable history never bypasses source quota, reserve, or authentication guards",()=>fixture(({accounts,policy,path})=>{
  const protectedPolicy={...policy,reservePercent:{a:30}};
  const pool=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>protectedPolicy,now:()=>now,
    forkParent:()=>({status:"unknown"})});
  const input={threadId:randomUUID(),requestId:randomUUID(),body:{...body,input:[...body.input,{role:"assistant",content:"history"}]},model:body.model,
    headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})};
  try {
    expect(()=>pool.select(input)).toThrow("pool_source_quota_exhausted");
    accounts[0]!.remaining=20; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
    expect(()=>pool.select(input)).toThrow("pool_reserve_reached");
    accounts[0]!.remaining=null;
    expect(()=>pool.select(input)).toThrow("pool_reserve_quota_unavailable");
    accounts[0]!.remaining=90; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
    expect(()=>pool.select({...input,headers:new Headers({authorization:"Bearer wrong","chatgpt-account-id":"a-remote"})}))
      .toThrow("pool_source_identity_mismatch");
    expect(pool.select(input)?.route.account).toBe("a");
  } finally {pool.close();}
}));

test("unknown lineage still rejects opaque references and incomplete tool history",()=>fixture(({accounts,policy,path})=>{
  accounts[0]!.remaining=90; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  const pool=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now,
    forkParent:()=>({status:"unknown"})});
  const histories=[
    {...body,previous_response_id:"response"}, {...body,conversation:"conversation"},
    {...body,input:[...body.input,{type:"compaction",encrypted_content:"opaque"}]},
    {...body,input:[{role:"user",content:[{type:"input_file",file_id:"file"}]}]},
    {...body,input:[...body.input,{type:"function_call",call_id:"call",name:"tool",arguments:"{}"}]},
    {...body,input:[...body.input,{type:"function_call_output",call_id:"call",output:"result"}]},
  ];
  try {
    for (const history of histories) expect(()=>pool.select({threadId:randomUUID(),requestId:randomUUID(),body:history,model:body.model,
      headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})})).toThrow("pool_lineage_unavailable");
  } finally {pool.close();}
}));

test("portable history cannot erase known fork ancestry when its parent metadata is unavailable",()=>fixture(({accounts,policy,path})=>{
  accounts[0]!.remaining=90; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  const child=randomUUID(), parent=randomUUID();
  const pool=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now,
    forkParent:thread=>thread===child?{status:"known",parentId:parent}:{status:"unknown"}});
  try {
    expect(()=>pool.select({threadId:child,requestId:randomUUID(),body:{...body,input:[...body.input,{role:"assistant",content:"history"}]},model:body.model,
      headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})})).toThrow("pool_lineage_unavailable");
  } finally {pool.close();}
}));

test("an ephemeral helper fallback cannot redirect a known foreign-account fork to its source",()=>fixture(({accounts,policy,path,select})=>{
  const parent=randomUUID(), child=randomUUID(), helperModel="gpt-6-luna";
  expect(select(parent)?.route.account).toBe("b");
  accounts[0]!.remaining=90; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  accounts[1]!.models.push(helperModel);
  const pool=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now,
    forkParent:thread=>thread===child?{status:"known",parentId:parent}:{status:"unknown"}});
  try {
    expect(()=>pool.select({threadId:child,requestId:randomUUID(),body:{model:helperModel,input:[...body.input,{role:"assistant",content:"history"}]},model:helperModel,
      headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})})).toThrow("pool_quota_scope_unsupported");
  } finally {pool.close();}
}));

for (const excluded of [false,true]) test(`ephemeral replay retains source authentication and cleanup when ${excluded?"the source leaves the pool":"new assignments are disabled"}`,()=>fixture(({accounts,policy,path,select})=>{
  // Existing bindings require lineage checks even after policy membership changes.
  select(randomUUID());
  accounts[0]!.remaining=90; accounts[0]!.observedAtMs = (accounts[0]!.observedAtMs ?? now) + 1;
  if (excluded) policy.accounts=["b"];
  else policy.enabled=false;
  const pool=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now,
    forkParent:()=>({status:"unknown"})});
  const input={threadId:randomUUID(),requestId:randomUUID(),body:{...body,input:[...body.input,
    {type:"reasoning",encrypted_content:"foreign-cache"},{role:"assistant",id:"foreign-id",content:"history"}]},model:body.model,
    headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})};
  try {
    expect(()=>pool.select({...input,headers:new Headers({authorization:"Bearer wrong","chatgpt-account-id":"a-remote"})}))
      .toThrow("pool_source_identity_mismatch");
    const selected=pool.select(input)!;
    expect(selected.route).toMatchObject({account:"a",reason:"existing"});
    expect(selected.body).toEqual({...body,input:[...body.input,{role:"assistant",content:"history"}]});
  } finally {pool.close();}
}));

test("the relay forwards an ephemeral helper's complete history on its verified source",async()=>{
  const accounts=[account("a",90),account("b",75)], helperModel="gpt-6-luna";
  const pool=new AccountPool({path:":memory:",sourceAccount:"a",accounts:()=>accounts,
    policy:()=>({enabled:true,accounts:["a","b"]}),now:()=>now,forkParent:()=>({status:"unknown"})});
  let calls=0;
  const proxy=startCompactionProxy({accountPool:pool,fetchUpstream:async(_,init)=>{
    calls++;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer a-token");
    const forwarded=JSON.parse(typeof init.body==="string"?init.body:new TextDecoder().decode(init.body as Uint8Array));
    expect(forwarded.model).toBe(helperModel);
    expect(forwarded.input).toEqual([...body.input,{role:"assistant",content:"history"},{role:"user",content:"continue"}]);
    return new Response('data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      {headers:{"content-type":"text/event-stream"}});
  }});
  try {
    const response=await fetch(proxy.baseUrl+"/responses",{method:"POST",
      headers:{authorization:"Bearer a-token","chatgpt-account-id":"a-remote",session_id:randomUUID()},
      body:JSON.stringify({model:helperModel,stream:true,input:[...body.input,
        {type:"reasoning",encrypted_content:"foreign-cache"},{role:"assistant",id:"foreign-id",content:"history"},
        {role:"user",content:"continue"}]})});
    expect(response.status).toBe(200);
    await response.text();
    expect(calls).toBe(1);
  } finally {proxy.stop();pool.close();}
});

test("anonymous routing rejection resolves when the same source later routes a complete response",()=>fixture(({pool,path})=>{
  const requestId=randomUUID(), headers=new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"});
  pool.reject("pool_thread_identity_required",{requestId:randomUUID(),threadId:null,status:409});
  const status=()=>poolStatus(path,join(dirname(path),"missing.json"));
  expect(status().unresolvedRejections?.latestCode).toBe("pool_thread_identity_required");
  const route=pool.select({threadId:randomUUID(),requestId,body,model:body.model,headers})!;
  pool.response(requestId,route.identity,200,null,route.credentialDigest);
  expect(status().unresolvedRejections?.latestCode).toBe("pool_thread_identity_required");
  pool.finish(requestId,"completed");
  expect(status().error).toBeNull();
  expect(status().rejected).toHaveLength(1);
}));
