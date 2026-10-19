import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {QuotaStorage} from "../src/storage/database";
import {WorkStore} from "../src/work/store";
import type {WorkPolicyInput} from "../src/work/types";
import {InstallMaintenance,type MaintenanceOwner,type MaintenanceOwnerProbe} from "../script/install-maintenance";

function fixture() {
  const directory=mkdtempSync(join(tmpdir(),"quotapie-maintenance-")), path=join(directory,"quotapie.sqlite3");
  const storage=new QuotaStorage(path), store=new WorkStore(storage);
  const input:WorkPolicyInput={id:"work",provider:"codex",account:"plus",accountKey:"account",profileKey:"profile",nativeSessionId:"thread",cwd:"/tmp",
    prompt:"continue",objective:"finish",completionCriteria:["proof"],dispatchOwner:"local",enabled:true,trigger:"quota-ready",resetWithinMinutes:0,
    budgetByBucket:{"codex:primary":{reservePercent:0,maxUsagePercent:100}},maxTurns:1,maxDurationSeconds:60,maxTotalDurationSeconds:60,
    expiresAtMs:Date.now()+3600000,priority:0,onReset:"continue"};
  store.save(input,null,"create");
  return {storage,store,path,input,close(){storage.close();rmSync(directory,{recursive:true,force:true});}};
}
const accounts=[{provider:"codex" as const,account:"plus"}];

test("installation fences block real claims across connections without changing consent or existing fences",()=>{
  const f=fixture();let maintenance:InstallMaintenance|null=null;
  const other=new QuotaStorage(f.path), runner=new WorkStore(other);
  try {
    const saved=f.store.get("work");
    const legacy={id:"other-owner",provider:"claude" as const,account:"other",accountKey:"other",reason:"existing-owner"};
    f.store.fenceLegacy(legacy);
    maintenance=InstallMaintenance.acquire(f.path,"install-test",accounts)!;
    expect(maintenance).not.toBeNull();maintenance.assertHeldAndIdle();
    expect(runner.claimRequest("work","local",1,"during-install").execution).toBeNull();
    expect(f.store.get("work")).toEqual(saved);
    expect(f.store.fences()).toHaveLength(2);
    maintenance.release();maintenance=null;
    expect(f.store.fences()).toEqual([legacy]);
    expect(runner.claimRequest("work","local",1,"after-install").execution).not.toBeNull();
  } finally {maintenance?.close();other.close();f.close();}
});

test("any unfinished execution including one beyond the HTTP page prevents installing a fence",()=>{
  for(const status of ["claimed","dispatched","uncertain"]) {
    const f=fixture();
    try {
      for(let n=0;n<205;n++) f.storage.db.query("INSERT INTO work_executions(id,policy_id,value) VALUES(?,?,?)")
        .run("history-"+n,"work",JSON.stringify({status:n===0?status:"finished"}));
      expect(()=>InstallMaintenance.acquire(f.path,"blocked",accounts)).toThrow("Managed work");
      expect(f.store.fences()).toEqual([]);
    } finally {f.close();}
  }
});

test("legacy review and unknown enabled accounts remain blocked even with an idle shared ledger",()=>{
  const f=fixture();
  try {
    expect(()=>InstallMaintenance.acquire(f.path,"uncovered",[])).toThrow("outside installation maintenance");
    f.storage.db.query("INSERT INTO jobs(id,job_key,spec_json,provider,account,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)")
      .run("legacy","legacy","{}","codex","plus","review",0,0);
    expect(()=>InstallMaintenance.acquire(f.path,"legacy",accounts)).toThrow("Managed work");
    expect(f.store.fences()).toEqual([]);
  } finally {f.close();}
});

test("a failed recovery keeps fences durable; release never removes another owner's changed fence",()=>{
  const f=fixture();let maintenance:InstallMaintenance|null=null;
  try {
    maintenance=InstallMaintenance.acquire(f.path,"retained",accounts)!;
    maintenance.close();maintenance=null;
    expect(()=>InstallMaintenance.acquire(f.path,"second",accounts)).toThrow("earlier installation");
    const fence=f.store.fences()[0]!;
    f.store.releaseLegacy(fence.id);
    maintenance=InstallMaintenance.acquire(f.path,"changed",accounts)!;
    const changed=f.store.fences()[0]!;
    f.store.fenceLegacy({...changed,reason:"changed-by-another-owner"});
    expect(()=>maintenance!.assertHeldAndIdle()).toThrow("fence changed");
    expect(()=>maintenance!.release()).toThrow("fence changed");
    expect(f.store.fences()[0]!.reason).toBe("changed-by-another-owner");
  } finally {maintenance?.close();f.close();}
});

const requestKey="a".repeat(64);
const owner=(start="2000000000.000001",pid=process.pid):MaintenanceOwner=>({pid,uid:process.getuid!(),start});
function setSavedOwner(f:ReturnType<typeof fixture>,saved:MaintenanceOwner){
 for(const row of f.storage.db.query<{id:string;value:string},[]>("SELECT id,value FROM work_fences WHERE id LIKE 'install:%'").all()){
  const value=JSON.parse(row.value);value.consolidation.owner=saved;
  f.storage.db.query("UPDATE work_fences SET value=? WHERE id=?").run(JSON.stringify(value),row.id);
 }
}
test("same migration request recovers only a provably dead owner without changing work consent",()=>{
 const f=fixture();let fence:InstallMaintenance|null=null;const self=owner(),dead=owner("1999999999.000001",999999);
 const probe:MaintenanceOwnerProbe=pid=>pid===process.pid?self:null;
 try{
  const saved=f.store.get("work");fence=InstallMaintenance.acquireConsolidation(f.path,requestKey,accounts,probe)!;
  fence.close();fence=null;setSavedOwner(f,dead);
  fence=InstallMaintenance.acquireConsolidation(f.path,requestKey,accounts,probe)!;
  expect((f.store.fences()[0] as any).consolidation.owner).toEqual(self);expect(f.store.get("work")).toEqual(saved);
  expect(f.store.claimRequest("work","local",1,"held").execution).toBeNull();
  fence.release();fence=null;expect(f.store.fences()).toEqual([]);
 }finally{fence?.close();f.close();}
});
test("recovery-only inspection never creates a migration fence",()=>{
 const f=fixture(),self=owner();
 try{
  const saved=f.store.get("work");
  expect(InstallMaintenance.recoverConsolidation(f.path,requestKey,accounts,()=>self)).toBeNull();
  expect(f.store.fences()).toEqual([]);expect(f.store.get("work")).toEqual(saved);
 }finally{f.close();}
});
for(const scenario of ["alive","unknown","wrong-key","other-install","modified","busy"])
test(`migration recovery preserves ${scenario} fence without weakening ordinary installation`,()=>{
 const f=fixture();let fence:InstallMaintenance|null=null;const self=owner(),saved=owner("1999999999.000001",999999);
 const probe:MaintenanceOwnerProbe=pid=>pid===process.pid?self:null;
 try{
  fence=scenario==="other-install"?InstallMaintenance.acquire(f.path,"ordinary-install",accounts):InstallMaintenance.acquireConsolidation(f.path,requestKey,accounts,probe);
  fence!.close();fence=null;
  if(scenario!=="other-install")setSavedOwner(f,saved);
  if(scenario==="busy")f.storage.db.query("INSERT INTO work_executions(id,policy_id,value) VALUES(?,?,?)").run("busy","work",JSON.stringify({status:"claimed"}));
  const before=f.store.fences();
  const inspect:MaintenanceOwnerProbe=pid=>{
   if(pid===process.pid)return self;
   if(scenario==="alive")return saved;
   if(scenario==="unknown")return "unknown";
   if(scenario==="modified"){
    const row:any=f.storage.db.query("SELECT id,value FROM work_fences LIMIT 1").get();const value=JSON.parse(row.value);value.reason="changed";
    f.storage.db.query("UPDATE work_fences SET value=? WHERE id=?").run(JSON.stringify(value),row.id);
   }
   return null;
  };
  expect(()=>InstallMaintenance.acquireConsolidation(f.path,scenario==="wrong-key"?"b".repeat(64):requestKey,accounts,inspect)).toThrow();
  if(scenario!=="modified")expect(f.store.fences()).toEqual(before);else expect(f.store.fences()[0]?.reason).toBe("changed");
  expect(()=>InstallMaintenance.acquire(f.path,"ordinary-retry",accounts)).toThrow();
 }finally{fence?.close();f.close();}
});
test("an orphaned apply helper keeps the fence after collector death until its exact generation exits",()=>{
 const f=fixture();let fence:InstallMaintenance|null=null;let self=owner(),helper:MaintenanceOwner|null=owner("2000000000.000002",999998);
 const probe:MaintenanceOwnerProbe=pid=>pid===process.pid?self:pid===999998?helper:null;
 try{
  fence=InstallMaintenance.acquireConsolidation(f.path,requestKey,accounts,probe)!;fence.protectProcess(999998);
  expect(()=>fence!.release()).toThrow("helper-active");fence.close();fence=null;
  self=owner("2000000001.000001");
  expect(()=>InstallMaintenance.acquireConsolidation(f.path,requestKey,accounts,probe)).toThrow("helper-active");
  helper=null;fence=InstallMaintenance.acquireConsolidation(f.path,requestKey,accounts,probe)!;
  fence.assertHeldAndIdle();fence.release();fence=null;expect(f.store.fences()).toEqual([]);
 }finally{fence?.close();f.close();}
});
