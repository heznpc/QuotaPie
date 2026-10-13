import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { createSharedWorkClient, type SharedWorkClient, type SharedWorkPolicy } from "../src/dots/work-client";
import { DotBridge } from "../src/dots/bridge";
import { DotStore } from "../src/dots/store";

test("Dots sends all mutations to resident collector with fresh local token and stable request id", async () => {
  const requests: Array<{url:string; options:any}> = [];
  const client = createSharedWorkClient(DEFAULT_CONFIG, (async (url, options) => {
    requests.push({url:String(url),options});
    return Response.json(String(url).endsWith("/api/status") ? {actionToken:"private-token"} : {policies:[]});
  }) as typeof fetch);
  await client.list(); await client.save({policy:{id:"one"},expectedRevision:null,requestId:"save-one"});
  await client.setEnabled({id:"one",enabled:true,expectedRevision:1,requestId:"enable-one"});
  await client.execute({id:"one",expectedRevision:2,requestId:"event-one"});
  expect(requests).toHaveLength(8);
  const calls=requests.filter(r=>r.options?.method==="POST");
  expect(calls.map(c=>JSON.parse(c.options.body).requestId)).toEqual(["save-one","enable-one","event-one"]);
  expect(calls.every(c=>c.options.headers["x-quotapie-action-token"]==="private-token")).toBeTrue();
  expect(calls.every(c=>c.options.redirect==="error")).toBeTrue();
  expect(()=>createSharedWorkClient({...DEFAULT_CONFIG,dashboard:{host:"external.example",port:1234}})).toThrow("shared-work-loopback-required");
});

function fixture(){
  const now=Date.now();
  let policy = { id:"shared",provider:"claude",account:"test",nativeSessionId:"11111111-2222-3333-4444-555555555555",
    dispatchOwner:"dots",enabled:true,trigger:"quota-ready",expiresAtMs:now+600000,revision:1,
    state:{turns:0},admission:{ready:true,reason:"ready"} } as SharedWorkPolicy;
  const calls:any[]=[];
  const shared:SharedWorkClient={list:async()=>({policies:[policy]}),targets:async()=>({targets:[{nativeSessionId:policy.nativeSessionId}]}),save:async a=>({saved:a}),setEnabled:async a=>({enabled:a}),execute:async a=>({executed:a})};
  const store=new DotStore(":memory:");
  const bridge=new DotBridge(store,async()=>{throw new Error("legacy-must-not-run")},async(_url,_headers,body)=>{
    const value=JSON.parse(body); calls.push(value);
    return {status:200,body:JSON.stringify(value.type==="verification"?{challenge:value.challenge}:{})};
  },()=>now,undefined,undefined,shared);
  return {store,bridge,calls,setPolicy:(next:Partial<SharedWorkPolicy>)=>{policy={...policy,...next}},getPolicy:()=>policy};
}
test("shared policy tools do not require a duplicate legacy target registration",async()=>{
  const f=fixture();
  try{
    const listed:any=await f.bridge.method("tools/list"); expect(listed.tools.some((t:any)=>t.name==="work_save")).toBeTrue();
    const schema=listed.tools.find((t:any)=>t.name==="work_save").inputSchema.properties.policy;
    expect(schema.required).toContain("budgetByBucket");expect(schema.properties.model).toBeUndefined();
    expect((await f.bridge.method("tools/call",{name:"work_targets",arguments:{provider:"claude",account:"test"}})).structuredContent).toEqual({targets:[{nativeSessionId:f.getPolicy().nativeSessionId}]});
    expect(((await f.bridge.method("tools/call",{name:"work_list"})).structuredContent as any).policies[0].id).toBe("shared");
    const args={id:"shared",expectedRevision:1,requestId:"event"};
    expect((await f.bridge.method("tools/call",{name:"work_execute",arguments:args})).structuredContent).toEqual({executed:args});
    expect(f.store.targets()).toHaveLength(0);
  }finally{f.store.db.close();}
});
test("shared Dots wakeups use collector admission and one delivery per policy revision and turn",async()=>{
  const f=fixture();
  try{
    await f.bridge.method("events/subscribe",{name:"quota.ready",arguments:{targetId:"shared"},delivery:{mode:"webhook",url:"https://callback.example/work",secret:"whsec_"+Buffer.alloc(32,7).toString("base64")}});
    await f.bridge.tick(); await f.bridge.tick();
    expect(f.calls.filter(v=>v.type!=="verification")).toHaveLength(1);
    f.setPolicy({state:{...f.getPolicy().state,turns:1}});
    await f.bridge.tick(); expect(f.calls.filter(v=>v.type!=="verification")).toHaveLength(2);
    f.setPolicy({revision:2,admission:{ready:false,reason:"quota-blocked"}});
    await f.bridge.tick(); expect(f.calls.filter(v=>v.type!=="verification")).toHaveLength(2);
    f.setPolicy({admission:{ready:true,reason:"ready"},dispatchOwner:"local"});
    await f.bridge.tick(); expect(f.calls.filter(v=>v.type!=="verification")).toHaveLength(2);
  }finally{f.store.db.close();}
});
