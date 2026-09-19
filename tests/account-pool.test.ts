import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AccountPool, isFreshTextTurn, poolStatus, savePoolPolicy, type PoolAccount } from "../src/account-pool";
import { startCompactionProxy } from "../src/codex-compaction";

const now=2_000_000_000_000;
const body={model:"gpt-6-astra",input:[{role:"user",content:"synthetic"}],stream:true};
function account(id:string,remaining:number):PoolAccount {return {id,label:id,identity:id+"-identity",accessToken:id+"-token",upstreamAccount:id+"-remote",tokenExpiresAt:now+3600_000,models:[body.model],remaining,validUntil:now+60_000};}
function fixture(work:(f:{pool:AccountPool; accounts:PoolAccount[]; policy:{enabled:boolean;accounts:string[]};path:string;select:(thread?:string,input?:unknown)=>ReturnType<AccountPool["select"]>})=>void) {
  const dir=mkdtempSync(join(tmpdir(),"qp-pool-test-")),path=join(dir,"pool.sqlite3");
  const accounts=[account("a",0),account("b",75)],policy={enabled:true,accounts:["a","b"]};
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
  const thread=randomUUID(); select(thread); accounts[0]!.remaining=99; policy.enabled=false;
  const second=new AccountPool({path,sourceAccount:"a",accounts:()=>accounts,policy:()=>policy,now:()=>now});
  try {
    const selected=second.select({threadId:thread,requestId:randomUUID(),body:{...body,previous_response_id:"response"},model:body.model,
      headers:new Headers({authorization:"Bearer a-token","chatgpt-account-id":"a-remote"})});
    expect(selected?.route).toMatchObject({account:"b",reason:"pinned"});
    expect(select()).toBeNull();
  } finally {second.close();}
}));

test("an unregistered continuation never migrates its account",()=>fixture(({select,accounts})=>{
  accounts[0]!.remaining=20;
  for (const input of [{...body,previous_response_id:"resp"},{...body,input:[{role:"assistant",content:"old"}]},
    {...body,input:[{type:"compaction",encrypted_content:"opaque"}]},{...body,input:[{role:"user",content:[{type:"input_image",image_url:"file"}]}]}])
    expect(select(randomUUID(),input)?.route).toMatchObject({account:"a",reason:"existing"});
}));

test("stale, unknown, expired and unsupported candidates cannot receive new work",()=>fixture(({select,accounts})=>{
  for (const patch of [{remaining:null},{validUntil:now-1},{tokenExpiresAt:now-1},{models:[]}]) {
    Object.assign(accounts[1]!,account("b",75),patch);
    expect(()=>select()).toThrow("pool_no_eligible_account");
  }
}));

test("credential identity changes and account removal never silently rebind",()=>fixture(({select,accounts,policy})=>{
  const thread=randomUUID();select(thread);accounts[1]!.identity="replaced";
  expect(()=>select(thread)).toThrow("pool_bound_identity_changed");
  accounts[1]!.identity="b-identity";policy.accounts=["a"];
  expect(()=>select(thread)).toThrow("pool_bound_account_removed");
}));

test("429 and authentication errors quarantine the selected identity",()=>fixture(({pool,select,accounts})=>{
  const thread=randomUUID();select(thread);
  pool.response("not-a-request","b-identity",429,"120");
  expect(()=>select(thread)).toThrow("pool_bound_account_exhausted");
  accounts[0]!.remaining=40;
  expect(select()?.route.account).toBe("a");
}));

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
    accounts[0]!.remaining = 99;
    expect(pool.select({ threadId: thread, requestId: randomUUID(), body, model: body.model,
      headers: new Headers({ authorization: "Bearer a-token", "chatgpt-account-id": "a-remote" }) })?.route.account).toBe("b");
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
