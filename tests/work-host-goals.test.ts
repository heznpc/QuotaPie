import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { QuotaDatabase } from "../src/db";
import { QuotaPieService } from "../src/service";
import { CodexGoalUnsupportedError } from "../src/providers/codex-appserver";
import { resumeProfileKey } from "../src/resume-gate";
import { startDashboard } from "../src/server";
import type { WorkPolicyInput } from "../src/work/types";
import type { HostGoalStatus } from "../src/host-goals";
import { fakeCodexLogin } from "./helpers/account";

const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const cleanup: Array<() => Promise<void>> = [];

function fixture(usedPercent = 20) {
  const root = mkdtempSync(join(tmpdir(), "quotapie-work-goal-"));
  const profile = join(root, "profile");
  fakeCodexLogin(profile);
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{id:"fixture",label:"Fixture",codexHome:profile,enabled:true}];
  config.accounts.claude = [];
  config.collection.codexEnabled = false;
  config.alerts.enabled = false;
  config.dashboard.port = 0;
  const service = new QuotaPieService(config, new QuotaDatabase(":memory:"));
  const now = Date.now() - 1000;
  service.ingest([{provider:"codex",account:"fixture",bucket:"codex:primary:300",label:"5h",windowSeconds:18000,
    usedPercent,observedAtMs:now,resetsAtMs:now+3600000,source:"fixture",quality:"authoritative"}]);
  let reads = 0, runs = 0;
  let status:HostGoalStatus = "active", objective = "Finish this work";
  const client = {
    listThreads:async()=>({data:[{id:SESSION,cwd:root,name:"First"},{id:OTHER,cwd:root,name:"Second"}],nextCursor:null}),
    readThreadGoal:async(id:string):Promise<any>=>{reads++;return {threadId:id,objective,status};},
    close:async()=>{},
  };
  (service as any).goalClients.set("fixture", client);
  service.work.deps.inspect = async()=>({profileKey:resumeProfileKey(config,"codex","fixture")!,
    accountKey:(service as any).accountBindings.identityKey(profile)!,cwd:root});
  service.work.deps.legacyBusy = ()=>false;
  service.work.deps.minimumReserveByBucket = ()=>({});
  service.work.deps.execute = async(_p,_id,authorized)=>{
    expect(authorized()).toBe(true); runs++;
    return {status:"turn-finished",remainingWork:"One more check",summary:"A turn finished"};
  };
  const policy:WorkPolicyInput = {id:"fixture-work",provider:"codex",account:"fixture",profileKey:"",accountKey:"",cwd:root,
    nativeSessionId:SESSION,prompt:"Continue the reviewed work",objective,completionCriteria:["Evidence is recorded"],
    dispatchOwner:"local",enabled:true,trigger:"quota-ready",resetWithinMinutes:60,
    budgetByBucket:{"codex:primary:300":{reservePercent:0,maxUsagePercent:20}},maxTurns:5,maxDurationSeconds:60,
    maxTotalDurationSeconds:300,expiresAtMs:now+3600000,priority:0,onReset:"stop"};
  cleanup.push(async()=>{await service.close();rmSync(root,{recursive:true,force:true});});
  return {root,profile,config,service,policy,client,reads:()=>reads,runs:()=>runs,
    goal:(next:HostGoalStatus,value=objective)=>{status=next;objective=value;}};
}

afterEach(async()=>{for(const close of cleanup.splice(0)) await close();});

async function saveAndRead(f:ReturnType<typeof fixture>, input:WorkPolicyInput, revision:number|null, id:string, linked?:boolean, objective?:string) {
  const saved=await f.service.saveWorkPolicy(input,revision,id,linked,objective);
  await f.service.refreshHostGoals(true);
  const policy=f.service.work.store.get(saved.policy.id)!;
  return {policy:{...policy,hostGoal:f.service.workHostGoalStatus(policy)}};
}

test("selected-session goal preview is read-only and distinguishes absent, missing and unsupported",async()=>{
  const f=fixture();
  expect(await f.service.previewWorkHostGoal("codex","fixture",SESSION)).toMatchObject({readState:"ready",objective:f.policy.objective});
  expect(f.service.work.store.list()).toEqual([]);
  expect(f.service.workHostGoalLinks.list()).toEqual([]);
  f.client.readThreadGoal=async()=>null;
  expect((await f.service.previewWorkHostGoal("codex","fixture",SESSION)).readState).toBe("no_goal");
  f.client.readThreadGoal=async()=>{throw new CodexGoalUnsupportedError("unsupported");};
  expect((await f.service.previewWorkHostGoal("codex","fixture",SESSION)).readState).toBe("unsupported");
  f.client.listThreads=async()=>({data:[],nextCursor:null});
  expect((await f.service.previewWorkHostGoal("codex","fixture",SESSION)).readState).toBe("error");
  expect(f.runs()).toBe(0);
});

test("an enabled policy commits its loading gate before the first goal read finishes",async()=>{
  const f=fixture();
  const read=f.client.readThreadGoal;
  let started!:()=>void, release!:(goal:any)=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  f.client.readThreadGoal=async()=>{started();return new Promise(resolve=>{release=resolve;});};
  const saved=await f.service.saveWorkPolicy(f.policy,null,"save-linked",true,f.policy.objective);
  expect(saved.policy.hostGoal?.readState).toBe("loading");
  await entered;
  expect(f.service.work.list()[0]!.admission.reason).toBe("host-goal-loading");
  f.service.work.tick();expect(f.runs()).toBe(0);
  release({threadId:SESSION,objective:f.policy.objective,status:"active"});
  f.client.readThreadGoal=read;
  await f.service.refreshHostGoals(true);
  expect(f.service.workStatus().policies[0]?.hostGoal?.readState).toBe("ready");
  f.client.readThreadGoal=read;
  await f.service.work.dispatch(f.policy.id,"local",1,"turn-one");await f.service.work.settle();
  expect(f.runs()).toBe(1);
  expect(f.service.work.store.get(f.policy.id)?.state.status).toBe("turn-finished");
  expect(f.service.workStatus().policies[0]?.hostGoal?.hostStatus).toBe("active");
});

test("host pause, blocking, budget and completion hold execution without claiming local completion",async()=>{
  const f=fixture();await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
  for(const [state,reason] of [["paused","paused"],["blocked","blocked"],["budgetLimited","budget-limited"],["complete","complete"]] as const){
    f.goal(state);await f.service.refreshHostGoals(true);
    expect(f.service.work.list()[0]!.admission.reason).toBe("host-goal-"+reason);
    expect(f.service.work.store.get(f.policy.id)?.state.status).toBe("waiting");
  }
  f.goal("usageLimited");await f.service.refreshHostGoals(true);
  expect(f.service.work.list()[0]!.admission.ready).toBe(true);
  await f.service.work.dispatch(f.policy.id,"local",1,"recovered");await f.service.work.settle();
  expect(f.runs()).toBe(1);
});

test("dispatch rereads an otherwise fresh goal before a turn and rechecks host completion",async()=>{
  const f=fixture();await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
  expect(f.service.work.list()[0]!.admission.ready).toBe(true);
  f.goal("complete");
  await expect(f.service.work.dispatch(f.policy.id,"local",1,"late-complete")).rejects.toThrow("work-admission-changed");
  expect(f.runs()).toBe(0);expect(f.service.work.store.executions()).toEqual([]);
});

test("a changed host objective requires explicit relinking, and ordinary edits preserve the baseline",async()=>{
  const f=fixture();await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
  f.goal("active","A different objective");await f.service.refreshHostGoals(true);
  expect(f.service.work.list()[0]!.admission.reason).toBe("host-goal-objective-changed");
  await f.service.saveWorkPolicy({...f.policy,priority:1},1,"ordinary-edit");
  expect(f.service.work.list()[0]!.admission.reason).toBe("host-goal-objective-changed");
  await f.service.changeWorkHostGoal(f.policy.id,2,"link","A different objective");
  await f.service.refreshHostGoals(true);
  expect(f.service.work.list()[0]!.admission.ready).toBe(true);
  expect(f.service.work.store.get(f.policy.id)?.objective).toBe("Finish this work");
});

test("explicit save/relink changes the baseline atomically and request replay cannot resurrect an unlink",async()=>{
  const f=fixture();await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
  f.goal("active","Updated goal");await f.service.refreshHostGoals(true);
  const edited={...f.policy,objective:"Updated goal"};
  await saveAndRead(f,edited,1,"relink",true,edited.objective);
  expect(f.service.work.list()[0]!.admission.ready).toBe(true);
  await f.service.changeWorkHostGoal(f.policy.id,2,"unlink");
  await saveAndRead(f,edited,1,"relink",true,edited.objective);
  expect(f.service.workStatus().policies[0]!.hostGoal).toBeNull();
  await expect(f.service.saveWorkPolicy(edited,1,"relink",false)).rejects.toThrow("work-request-id-reused");
});

test("failed reads retain stale evidence, expiry holds work, and changed accounts redact cached goals",async()=>{
  const f=fixture();const saved=await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
  const link=f.service.workHostGoalLinks.get(f.policy.id)!;
  expect(f.service.workHostGoalStatus(saved.policy,saved.policy.hostGoal!.expiresAtMs!)?.readState).toBe("stale");
  f.client.readThreadGoal=async()=>{throw new Error("PRIVATE_ERROR");};
  await f.service.refreshHostGoals(true);
  expect(f.service.workStatus().policies[0]!.hostGoal).toMatchObject({readState:"error",objective:f.policy.objective});
  expect(f.service.work.list()[0]!.admission.reason).toBe("host-goal-error");
  f.service.workHostGoalLinks.record(link,"ready",Date.now()-f.config.collection.staleAfterSeconds*1000-1,{objective:f.policy.objective,status:"active"});
  expect(f.service.work.list()[0]!.admission.reason).toBe("host-goal-stale");
  fakeCodexLogin(f.profile,"different-account");
  expect(f.service.workStatus().policies[0]!.hostGoal).toMatchObject({readState:"account_changed",objective:null,hostStatus:null});
  expect(f.service.work.list()[0]!.admission.reason).toBe("host-goal-account-changed");
  expect(JSON.stringify(f.service.workStatus().policies[0]!.hostGoal)).not.toContain("PRIVATE_ERROR");
});

test("an unlink or account change during a read cannot install the late goal",async()=>{
  const f=fixture();await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
  f.client.readThreadGoal=async()=>{await f.service.changeWorkHostGoal(f.policy.id,1,"unlink");return {threadId:SESSION,objective:"Late",status:"active"};};
  await f.service.changeWorkHostGoal(f.policy.id,1,"refresh");
  await f.service.refreshHostGoals(true);
  expect(f.service.workHostGoalLinks.get(f.policy.id)).toBeNull();
  f.client.readThreadGoal=async()=>{fakeCodexLogin(f.profile,"switched");return {threadId:SESSION,objective:"Wrong account",status:"active"};};
  const result=await f.service.changeWorkHostGoal(f.policy.id,2,"link",f.policy.objective);
  expect(result.hostGoal?.readState).toBe("loading");
  await f.service.refreshHostGoals(true);
  expect(f.service.workStatus().policies[0]!.hostGoal).toMatchObject({readState:"account_changed",objective:null});
});

test("editing the selected session cannot carry the old goal binding to a different session",async()=>{
  const f=fixture();await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
  await f.service.saveWorkPolicy({...f.policy,nativeSessionId:OTHER},1,"edit-session");
  expect(f.service.work.list()[0]!.admission.reason).toBe("host-goal-account-changed");
  expect(f.service.workStatus().policies[0]!.hostGoal?.objective).toBeNull();
  await f.service.changeWorkHostGoal(f.policy.id,2,"link",f.policy.objective);
  await f.service.refreshHostGoals(true);
  expect(f.service.work.list()[0]!.admission.ready).toBe(true);
});

test("a save survives unavailable goal API and can be refreshed without duplicate registration",async()=>{
  const f=fixture(),read=f.client.readThreadGoal;
  f.client.readThreadGoal=async()=>{throw new CodexGoalUnsupportedError("unsupported");};
  const saved=await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
  expect(saved.policy.hostGoal?.readState).toBe("unsupported");
  expect(f.service.work.store.list()).toHaveLength(1);
  f.client.readThreadGoal=read;
  expect((await f.service.changeWorkHostGoal(f.policy.id,1,"refresh")).hostGoal?.readState).toBe("unsupported");
  await f.service.refreshHostGoals(true);
  expect(f.service.workStatus().policies[0]!.hostGoal?.readState).toBe("ready");
  await f.service.changeWorkHostGoal(f.policy.id,1,"unlink");
  const reads=f.reads();await f.service.refreshHostGoals(true);expect(f.reads()).toBe(reads);
  expect(f.service.work.list()[0]!.admission.ready).toBe(true);
});

test("HTTP preview, policy save and goal controls share action authentication and expose no private goal binding",async()=>{
  const f=fixture();const server=startDashboard(f.service,f.config,{compactionRoot:join(f.root,"empty")});
  const base=`http://127.0.0.1:${server.port}`;
  try {
    const {actionToken}=await(await fetch(base+"/api/status")).json() as any;
    const headers={"x-quotapie-action-token":actionToken,"content-type":"application/json"};
    const path="/api/work/host-goal?provider=codex&account=fixture&session="+SESSION;
    expect((await fetch(base+path)).status).toBe(403);
    expect((await fetch(base+path,{headers:{...headers,origin:"https://untrusted.example"}})).status).toBe(403);
    const preview=await(await fetch(base+path,{headers})).json() as any;expect(preview.hostGoal.readState).toBe("ready");
    const saved=await(await fetch(base+"/api/work",{method:"POST",headers,body:JSON.stringify({action:"save",policy:f.policy,expectedRevision:null,requestId:"http-save",hostGoalLinked:true,reviewedObjective:f.policy.objective})})).json() as any;
    expect(saved.policy.hostGoal.readState).toBe("loading");
    await f.service.refreshHostGoals(true);
    const status=await(await fetch(base+"/api/work",{headers})).json() as any;
    const snapshot=JSON.stringify(status.policies[0].hostGoal);
    for(const secret of [SESSION,f.profile,"binding_key","linked_objective"])expect(snapshot).not.toContain(secret);
    expect((await fetch(base+"/api/work/host-goal",{method:"POST",headers,body:JSON.stringify({id:f.policy.id,expectedRevision:9,action:"unlink"})})).status).toBe(409);
    const unlinked=await(await fetch(base+"/api/work/host-goal",{method:"POST",headers,body:JSON.stringify({id:f.policy.id,expectedRevision:1,action:"unlink"})})).json() as any;
    expect(unlinked.hostGoal).toBeNull();
  } finally {server.stop(true);}
});

test("preview-to-save and relink races never substitute an unreviewed objective",async()=>{
  const f=fixture();
  const preview=await f.service.previewWorkHostGoal("codex","fixture",SESSION);
  f.goal("active","Changed after preview");
  const saved=await saveAndRead(f,f.policy,null,"save",true,preview.objective!);
  expect(saved.policy.hostGoal?.objectiveChanged).toBe(true);
  expect(f.service.work.list()[0]!.admission.reason).toBe("host-goal-objective-changed");
  const reviewed=saved.policy.hostGoal!.objective!;
  f.goal("active","Changed again before relink");
  await f.service.changeWorkHostGoal(f.policy.id,1,"link",reviewed);
  await f.service.refreshHostGoals(true);
  expect(f.service.work.list()[0]!.admission.reason).toBe("host-goal-objective-changed");
  await expect(f.service.changeWorkHostGoal(f.policy.id,2,"link")).rejects.toThrow("work-host-goal-review-required");
  expect(f.runs()).toBe(0);
});

test("background and manual reads serialize so an older observation cannot overwrite the newest goal",async()=>{
  const f=fixture();await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
  let entered!:()=>void,release!:(goal:any)=>void,calls=0;
  const firstStarted=new Promise<void>(resolve=>{entered=resolve;});
  f.client.readThreadGoal=async()=>{
    calls++;
    if(calls===1){entered();return new Promise(resolve=>{release=resolve;});}
    return {threadId:SESSION,objective:f.policy.objective,status:"complete"};
  };
  const first=f.service.refreshHostGoals(true);await firstStarted;
  const second=f.service.changeWorkHostGoal(f.policy.id,1,"refresh");
  await Promise.resolve();expect(calls).toBe(1);
  release({threadId:SESSION,objective:f.policy.objective,status:"active"});
  await Promise.all([first,second]);
  await (f.service as any).goalLinkReads.get("work:"+f.policy.id);
  expect(calls).toBe(2);
  expect(f.service.workStatus().policies[0]!.hostGoal?.hostStatus).toBe("complete");
  expect(f.service.work.list()[0]!.admission.reason).toBe("host-goal-complete");
});

test("quota recovery executes linked usageLimited work only when its explicit reset policy allows continuation",async()=>{
  for(const onReset of ["continue","stop"] as const){
    const f=fixture(100);f.goal("usageLimited");
    await saveAndRead(f,{...f.policy,onReset},null,"save",true,f.policy.objective);
    expect(f.service.work.list()[0]!.admission.ready).toBe(false);
    f.service.work.tick();expect(f.runs()).toBe(0);
    const recoveredAt=Date.now();
    f.service.ingest([{provider:"codex",account:"fixture",bucket:"codex:primary:300",label:"5h",windowSeconds:18000,
      usedPercent:0,observedAtMs:recoveredAt,resetsAtMs:recoveredAt+7200000,source:"fixture",quality:"authoritative"}]);
    if(onReset==="continue"){
      let started!:()=>void;const begun=new Promise<void>(resolve=>{started=resolve;});
      const execute=f.service.work.deps.execute;
      f.service.work.deps.execute=async(...args)=>{const result=await execute(...args);started();return result;};
      f.service.work.tick();
      await Promise.race([begun,Bun.sleep(1000).then(()=>{throw new Error("recovered work did not start");})]);
      await f.service.work.settle();
      expect(f.runs()).toBe(1);
      expect(f.service.work.store.get(f.policy.id)?.state.status).toBe("turn-finished");
    }else{
      f.service.work.tick();await f.service.work.settle();
      expect(f.runs()).toBe(0);expect(f.service.work.store.get(f.policy.id)?.enabled).toBe(false);
    }
    expect(f.service.workStatus().policies[0]!.hostGoal?.hostStatus).toBe("usageLimited");
  }
});

test("link changes revoke the existing execution permanently and stale unlink requests cannot remove a new link",async()=>{
  for(const change of ["unlink","relink","complete-then-unlink"] as const){
    const f=fixture();await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
    let authorized!:()=>boolean,signal!:AbortSignal,finish!:()=>void;
    const pending=new Promise<void>(resolve=>{finish=resolve;});
    f.service.work.deps.execute=async(_policy,_id,allowed,abort)=>{
      authorized=allowed;signal=abort;await pending;return {status:"activity-paused",reason:"reviewed-link-change"};
    };
    await f.service.work.dispatch(f.policy.id,"local",1,"running");
    expect(authorized()).toBe(true);
    if(change==="complete-then-unlink"){
      f.goal("complete");await f.service.refreshHostGoals(true);expect(authorized()).toBe(false);
    }
    const changed=await f.service.changeWorkHostGoal(f.policy.id,1,change==="relink"?"link":"unlink",f.policy.objective);
    expect(changed.revision).toBe(2);expect(signal.aborted).toBe(true);expect(authorized()).toBe(false);
    f.goal("active");
    if(change!=="relink")await f.service.changeWorkHostGoal(f.policy.id,2,"link",f.policy.objective);
    await f.service.refreshHostGoals(true);
    expect(f.service.workStatus().policies[0]!.hostGoal?.readState).toBe("ready");
    expect(authorized()).toBe(false);
    await expect(f.service.changeWorkHostGoal(f.policy.id,1,"unlink")).rejects.toThrow("work-revision-conflict");
    expect(f.service.workHostGoalLinks.get(f.policy.id)).not.toBeNull();
    finish();await f.service.work.settle();
  }
});

test("manual refresh preserves fresh execution authority while a slow read is pending",async()=>{
  const f=fixture();await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
  let authorized!:()=>boolean,signal!:AbortSignal,finish!:()=>void;
  const pending=new Promise<void>(resolve=>{finish=resolve;});
  f.service.work.deps.execute=async(_policy,_id,allowed,abort)=>{authorized=allowed;signal=abort;await pending;return {status:"turn-finished",remainingWork:"Next"};};
  await f.service.work.dispatch(f.policy.id,"local",1,"running");
  let release!:(goal:any)=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  f.client.readThreadGoal=async()=>{entered();return new Promise(resolve=>{release=resolve;});};
  const refreshing=await f.service.changeWorkHostGoal(f.policy.id,1,"refresh");await started;
  expect(refreshing.revision).toBe(1);expect(refreshing.hostGoal?.readState).toBe("ready");
  expect(authorized()).toBe(true);expect(signal.aborted).toBe(false);
  release({threadId:SESSION,objective:f.policy.objective,status:"active"});
  await (f.service as any).goalLinkReads.get("work:"+f.policy.id);
  expect(authorized()).toBe(true);expect(signal.aborted).toBe(false);
  finish();await f.service.work.settle();
});

test("a late goal read cannot cross a policy's session edit",async()=>{
  const f=fixture();await saveAndRead(f,f.policy,null,"save",true,f.policy.objective);
  let release!:(goal:any)=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  f.client.readThreadGoal=async()=>{entered();return new Promise(resolve=>{release=resolve;});};
  await f.service.changeWorkHostGoal(f.policy.id,1,"refresh");await started;
  await f.service.saveWorkPolicy({...f.policy,nativeSessionId:OTHER},1,"edit-session");
  release({threadId:SESSION,objective:"Late old-session result",status:"active"});
  await (f.service as any).goalLinkReads.get("work:"+f.policy.id);
  expect(f.service.workStatus().policies[0]!.hostGoal).toMatchObject({readState:"account_changed",objective:null});
  expect(f.service.work.list()[0]!.admission.ready).toBe(false);
});
