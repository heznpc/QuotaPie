import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool, type PoolAccount } from "../src/account-pool";

const now = Date.now(), model = "gpt-6.1-sol";
const portable = { model, input: [{ role: "user", content: "Original" }, { role: "assistant", content: "Prior work" }] };
const opaque = { model, input: [{ type: "compaction", encrypted_content: "account-bound" }] };
async function fixture(run: (f: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "qp-proof-")), path = join(root, "pool.db");
  const accounts: PoolAccount[] = ["a", "b"].map((id,index) => ({ id,label:id,identity:id,accessToken:id,upstreamAccount:id,
    tokenExpiresAt:now+3600000,models:[model],remaining:index?80:0,validUntil:now+3600000,observedAtMs:now }));
  const make = () => new AccountPool({ path, sourceAccount:"a", accounts:()=>accounts, policy:()=>({enabled:true,accounts:["a","b"]}),now:()=>now+100 });
  const pool=make();
  const select=(p:AccountPool,id:string,body:any=portable)=>p.select({requestId:id,threadId:"thread",model,body,headers:new Headers({authorization:"Bearer a","chatgpt-account-id":"a"})});
  try { await run({pool,make,accounts,path,select}); } finally { pool.close(); rmSync(root,{recursive:true,force:true}); }
}

test("restart does not turn an unsent binding into proof for opaque target history",()=>fixture(async f=>{
  expect(f.select(f.pool,"first")?.route.account).toBe("b");
  const restarted=f.make();
  try {
    expect(()=>f.select(restarted,"opaque",opaque)).toThrow("pool_recovery_requires_full_history");
    const repeated=f.select(restarted,"portable")!;
    restarted.response("portable",repeated.identity,200,null,repeated.credentialDigest); restarted.finish("portable","completed");
    expect(f.select(restarted,"confirmed",opaque)?.route.account).toBe("b");
  } finally {restarted.close();}
}));

test("rollback preserves a later selection but unconfirmed concurrent ownership still rejects opaque replay",()=>fixture(async f=>{
  f.select(f.pool,"first"); f.select(f.pool,"later");
  await f.pool.rollbackUnsentAsync("first");
  const db=new Database(f.path,{readonly:true});
  expect(db.query("SELECT account FROM bindings").get()).toMatchObject({account:"b"});db.close();
  expect(()=>f.select(f.pool,"opaque",opaque)).toThrow("pool_recovery_requires_full_history");
  await f.pool.rollbackUnsentAsync("later");
  expect(()=>f.select(f.pool,"opaque-again",opaque)).toThrow("pool_recovery_requires_full_history");
}));

test("model exhaustion obeys observation order and exhaustion wins timestamp ties",()=>fixture(async f=>{
  f.accounts[0].remaining=70;f.accounts[0].observedAtMs=now+1;f.accounts[1].remaining=0;
  f.accounts[0].modelQuota={[model]:{remaining:0,validUntil:now+60000,observedAtMs:now+10}};
  expect(()=>f.select(f.pool,"denied")).toThrow("pool_source_quota_exhausted");
  f.accounts[0].modelQuota[model]={remaining:80,validUntil:now+60000,observedAtMs:now+9};
  expect(()=>f.select(f.pool,"older-positive")).toThrow("pool_source_quota_exhausted");
  f.accounts[0].modelQuota[model].observedAtMs=now+10;
  expect(()=>f.select(f.pool,"tied-positive")).toThrow("pool_source_quota_exhausted");
  f.accounts[0].modelQuota[model].observedAtMs=now+11;
  expect(f.select(f.pool,"recovered")?.route.account).toBe("a");
  f.accounts[0].modelQuota[model]={remaining:0,validUntil:now+60000,observedAtMs:now+10};
  expect(f.select(f.pool,"late-old-zero")?.route.account).toBe("a");
}));
