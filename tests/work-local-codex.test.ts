import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaStorage } from "../src/storage/database";
import { WorkStore } from "../src/work/store";
import { WorkController } from "../src/work/controller";
import type { WorkPolicyInput } from "../src/work/types";
import type { WindowAnalysis } from "../src/types";

test("Codex local work needs neither a Dots connection nor a Pro account, and shares the ledger when ownership changes", async () => {
  const now=Date.now(),db=new QuotaStorage(":memory:"),store=new WorkStore(db);
  const config=structuredClone(DEFAULT_CONFIG);
  config.accounts.codex=[{id:"plus-profile",label:"Plus subscription",enabled:true,codexHome:"/fixture/plus"}];
  const buckets=["codex:primary:300","codex:secondary:10080"];
  let observedAtMs=now-1,remainingPercent=80,calls=0;
  const windows=():WindowAnalysis[]=>buckets.map(bucket=>({provider:"codex",account:"plus-profile",bucket,
    remainingPercent,observedAtMs,resetsAtMs:now+3600000,quality:"authoritative",freshness:"fresh",reservePercent:15} as WindowAnalysis));
  const policy:WorkPolicyInput={id:"local-plus",provider:"codex",account:"plus-profile",profileKey:"plus-profile-hash",accountKey:"plus-identity",
    nativeSessionId:"original-plus-session",cwd:"/fixture/project",model:"original-model",prompt:"Finish reviewed work",objective:"Finish task",completionCriteria:["result exists"],
    dispatchOwner:"local",enabled:true,trigger:"quota-ready",resetWithinMinutes:60,budgetByBucket:Object.fromEntries(buckets.map(b=>[b,{reservePercent:0,maxUsagePercent:5}])),
    maxTurns:1,maxDurationSeconds:60,maxTotalDurationSeconds:120,expiresAtMs:now+600000,priority:0,onReset:"stop"};
  const controller=new WorkController(store,config,{now:()=>now,windows,announcement:()=>false,legacyBusy:()=>false,
    inspect:async input=>{expect(input.account).toBe("plus-profile");return {profileKey:policy.profileKey,accountKey:policy.accountKey,cwd:policy.cwd,model:policy.model};},
    execute:async(p,_id,authorized)=>{
      expect(p.nativeSessionId).toBe(policy.nativeSessionId);expect(authorized()).toBeTrue();calls++;
      return calls===1?{status:"turn-finished",remainingWork:"one check remains"}:{status:"objective-completed",summary:"verified",evidenceRefs:["result.json"],completionAssessment:"model-assessed"};
    }});
  try {
    await controller.save(policy,null,"create");
    // No bridge, DotStore, subscription, tunnel or Dots tool is instantiated.
    controller.tick();await new Promise(resolve=>setTimeout(resolve,0));await controller.settle();
    expect(calls).toBe(1);expect(store.executions()[0]?.owner).toBe("local");
    remainingPercent=79;observedAtMs=now;controller.observe();
    const local=store.get(policy.id)!;
    const switched=await controller.save({...local,dispatchOwner:"dots",maxTurns:2},local.revision,"switch");
    expect(switched.state.spentByBucket).toEqual(Object.fromEntries(buckets.map(b=>[b,1])));
    controller.tick();await controller.settle();expect(calls).toBe(1);
    const execution=await controller.dispatch(policy.id,"dots",switched.revision,"event");await controller.settle();
    expect((await controller.dispatch(policy.id,"dots",switched.revision,"event")).id).toBe(execution.id);
    expect(calls).toBe(2);expect(store.executions().map(e=>e.owner)).toEqual(["local","dots"]);
    expect(store.get(policy.id)?.state.turns).toBe(2);expect(store.get(policy.id)?.enabled).toBeFalse();
  } finally { await controller.close();db.close(); }
});
