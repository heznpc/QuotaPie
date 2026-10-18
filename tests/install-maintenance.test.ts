import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {QuotaStorage} from "../src/storage/database";
import {WorkStore} from "../src/work/store";
import type {WorkPolicyInput} from "../src/work/types";
import {InstallMaintenance} from "../script/install-maintenance";

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
