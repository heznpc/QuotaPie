import { Database } from "bun:sqlite";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface InstallAccount { provider: "codex" | "claude"; account: string }
export interface MaintenanceOwner { pid:number; uid:number; start:string }
export type MaintenanceOwnerProbe = (pid:number)=>MaintenanceOwner|null|"unknown";
interface ConsolidationOwner {version:1;requestKey:string;owner:MaintenanceOwner;helper?:MaintenanceOwner}
const ownerValid=(owner:MaintenanceOwner)=>Number.isSafeInteger(owner?.pid)&&owner.pid>0&&Number.isSafeInteger(owner.uid)&&owner.uid>=0&&typeof owner.start==="string"&&/^\d{1,12}\.\d{6}$/.test(owner.start);
const ownerEqual=(a:MaintenanceOwner,b:MaintenanceOwner)=>a.pid===b.pid&&a.uid===b.uid&&a.start===b.start;
/** Read one native process generation. No signals, process control or session
 * data are used. An unavailable inspection can never release a fence. */
export const inspectMaintenanceOwner:MaintenanceOwnerProbe=pid=>{
  if(process.platform!=="darwin"||!Number.isSafeInteger(pid)||pid<=0)return "unknown";
  const helper=fileURLToPath(new URL("./codex-host-wake.py",import.meta.url));
  const source=`import ctypes as C,errno,importlib.util,json,sys
s=importlib.util.spec_from_file_location('qp_identity',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
lib=C.CDLL('/usr/lib/libproc.dylib',use_errno=True);lib.proc_pidinfo.argtypes=[C.c_int,C.c_int,C.c_uint64,C.c_void_p,C.c_int]
p=int(sys.argv[2]);v=m.BSDInfo();C.set_errno(0);n=lib.proc_pidinfo(p,3,0,C.byref(v),C.sizeof(v))
if n==C.sizeof(v): print(json.dumps({'pid':p,'uid':v.uid,'start':str(v.start_sec)+'.'+str(v.start_usec).zfill(6)}))
elif n<=0 and C.get_errno()==errno.ESRCH: print('null')
else: print('"unknown"')`;
  try {
    const result=Bun.spawnSync(["/usr/bin/python3","-B","-c",source,helper,String(pid)],{stdout:"pipe",stderr:"ignore",timeout:3000,
      env:{PATH:"/usr/bin:/bin:/usr/sbin:/sbin",LANG:"en_US.UTF-8"}});
    if(result.exitCode!==0||result.stdout.length>1024)return "unknown";
    const value=JSON.parse(result.stdout.toString());return value===null?null:ownerValid(value)?value:"unknown";
  }catch{return "unknown";}
};

/** A durable admission fence understood by already-running collectors. This
 * opens existing tables only: installation must not migrate the live database. */
export class InstallMaintenance {
  private readonly fences: Array<{ id: string; value: string }>;
  private readonly identity: string;
  private closed = false;
  private constructor(private readonly path: string, private readonly db: Database,
    installationId: string, private readonly accounts: InstallAccount[], expectedIdentity: string,
    private consolidation?:ConsolidationOwner,private readonly probe?:MaintenanceOwnerProbe) {
    this.identity = this.fileIdentity();
    if (this.identity!==expectedIdentity) throw new Error("Installation database changed.");
    this.fences = accounts.map(account => {
      const id = `install:${installationId}:${createHash("sha256").update(JSON.stringify(account)).digest("hex")}`;
      return {id, value: JSON.stringify({...account, id, accountKey:`install:${installationId}`, reason:"installation-maintenance",...(consolidation?{consolidation}:{})})};
    });
  }
  static acquire(path: string, installationId: string, accounts: InstallAccount[]): InstallMaintenance | null {
    return this.acquireInternal(path,installationId,accounts);
  }
  static acquireConsolidation(path:string,requestKey:string,accounts:InstallAccount[],probe:MaintenanceOwnerProbe=inspectMaintenanceOwner):InstallMaintenance|null {
    return this.consolidationFence(path,requestKey,accounts,probe,false);
  }
  /** Recover an existing interrupted migration without creating a new fence
   * while its source host is still running. */
  static recoverConsolidation(path:string,requestKey:string,accounts:InstallAccount[],probe:MaintenanceOwnerProbe=inspectMaintenanceOwner):InstallMaintenance|null {
    return this.consolidationFence(path,requestKey,accounts,probe,true);
  }
  private static consolidationFence(path:string,requestKey:string,accounts:InstallAccount[],probe:MaintenanceOwnerProbe,existingOnly:boolean):InstallMaintenance|null {
    if(!/^[a-f0-9]{64}$/.test(requestKey))throw new Error("consolidation-fence-key-invalid");
    const owner=probe(process.pid);
    if(!owner||owner==="unknown"||!ownerValid(owner)||owner.pid!==process.pid||owner.uid!==process.getuid?.())
      throw new Error("consolidation-fence-owner-unverified");
    return this.acquireInternal(path,"consolidation-"+requestKey,accounts,{version:1,requestKey,owner},probe,existingOnly);
  }
  private static acquireInternal(path:string,installationId:string,accounts:InstallAccount[],consolidation?:ConsolidationOwner,probe?:MaintenanceOwnerProbe,existingOnly=false):InstallMaintenance|null {
    if (!existsSync(path)) return null;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(installationId) || accounts.some(a => !["codex","claude"].includes(a.provider)
      || typeof a.account !== "string" || !a.account.trim())) throw new Error("Invalid installation maintenance identity.");
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Installation database must be a regular file.");
    const identity=`${realpathSync(path)}:${info.dev}:${info.ino}`;
    const db = new Database(path, {create:false, strict:true});
    try {
      db.run("PRAGMA busy_timeout = 3000");
      const tables = new Set(db.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
      if (!["work_fences","work_policies","work_executions","jobs"].every(name=>tables.has(name))) {
        db.close(); return null; // Older services retain the original disabled-work guard.
      }
      const previous=db.query<{id:string;value:string},[]>("SELECT id,value FROM work_fences WHERE id LIKE 'install:%' ORDER BY id").all();
      if(existingOnly&&!previous.length){db.close();return null;}
      // Releasing an interrupted migration does not grant consent. Recover its
      // original account set even if that source was since disabled/removed.
      const covered=existingOnly?previous.map(row=>{const old=JSON.parse(row.value);
        if(!["codex","claude"].includes(old?.provider)||typeof old.account!=="string"||!old.account.trim())throw new Error("consolidation-fence-conflict");
        return {provider:old.provider,account:old.account} as InstallAccount;}):accounts;
      const unique = [...new Map(covered.map(a=>[JSON.stringify(a),a])).values()];
      const value = new InstallMaintenance(path,db,installationId,unique,identity,consolidation,probe);
      if(previous.length && consolidation){
        const expected=new Map(value.fences.map(fence=>[fence.id,JSON.parse(fence.value)]));
        let oldOwner:MaintenanceOwner|undefined,oldHelper:MaintenanceOwner|undefined;
        if(previous.length!==expected.size)throw new Error("consolidation-fence-conflict");
        for(const row of previous){
          const old=JSON.parse(row.value),next=expected.get(row.id),metadata=old?.consolidation;
          if(!next||!metadata||metadata.version!==1||metadata.requestKey!==consolidation.requestKey||!ownerValid(metadata.owner)||
              metadata.owner.uid!==consolidation.owner.uid||oldOwner&&!ownerEqual(oldOwner,metadata.owner)||
              metadata.helper!==undefined&&(!ownerValid(metadata.helper)||metadata.helper.uid!==consolidation.owner.uid)||
              oldOwner&&JSON.stringify(oldHelper)!==JSON.stringify(metadata.helper)||
              JSON.stringify({...old,consolidation})!==JSON.stringify(next))throw new Error("consolidation-fence-conflict");
          oldOwner=metadata.owner;oldHelper=metadata.helper;
        }
        const current=probe!(oldOwner!.pid);
        if(current==="unknown"||current&&(!ownerValid(current)||ownerEqual(current,oldOwner!)))throw new Error("consolidation-fence-owner-active-or-unverified");
        if(oldHelper){const helper=probe!(oldHelper.pid);
          if(helper==="unknown"||helper&&(!ownerValid(helper)||ownerEqual(helper,oldHelper)))throw new Error("consolidation-fence-helper-active-or-unverified");}
        const own=probe!(consolidation.owner.pid);
        if(!own||own==="unknown"||!ownerEqual(own,consolidation.owner))throw new Error("consolidation-fence-owner-unverified");
      }
      value.transaction(() => {
        value.assertIdle();
        const current=db.query<{id:string;value:string},[]>("SELECT id,value FROM work_fences WHERE id LIKE 'install:%' ORDER BY id").all();
        if(JSON.stringify(current)!==JSON.stringify(previous))throw new Error("consolidation-fence-changed");
        if(current.length&&!consolidation)throw new Error("An earlier installation maintenance fence needs recovery.");
        for(const row of current)db.query("DELETE FROM work_fences WHERE id=? AND value=?").run(row.id,row.value);
        for (const fence of value.fences)
          db.query("INSERT INTO work_fences(id,value) VALUES (?,?)").run(fence.id,fence.value);
      });
      return value;
    } catch(error) { db.close(); throw error; }
  }
  covers(provider: string, account: string): boolean {
    return this.accounts.some(a=>a.provider===provider && a.account===account);
  }
  private fileIdentity(): string {
    const info=lstatSync(this.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Installation database changed.");
    return `${realpathSync(this.path)}:${info.dev}:${info.ino}`;
  }
  private transaction<T>(body:()=>T): T {
    if (this.closed || this.fileIdentity()!==this.identity) throw new Error("Installation database changed.");
    this.db.run("BEGIN IMMEDIATE");
    try { const result=body(); this.db.run("COMMIT"); return result; }
    catch(error) { if(this.db.inTransaction)this.db.run("ROLLBACK"); throw error; }
  }
  private assertIdle(): void {
    // Full durable tables, not the HTTP endpoint's last 200 executions/100 jobs.
    for (const row of this.db.query<{value:string},[]>("SELECT value FROM work_executions").all()) {
      if (JSON.parse(row.value)?.status!=="finished") throw new Error("Managed work is enabled, pending, running or uncertain.");
    }
    for (const row of this.db.query<{value:string},[]>("SELECT value FROM work_policies").all()) {
      const policy=JSON.parse(row.value);
      if (typeof policy?.enabled!=="boolean" || policy.state?.activeExecutionId!==null)
        throw new Error("Managed work is enabled, pending, running or uncertain.");
      if (policy.enabled && !this.covers(policy.provider,policy.account))
        throw new Error("An enabled work account is outside installation maintenance.");
    }
    if (this.db.query<{state:string},[]>("SELECT state FROM jobs").all().some(j=>!["succeeded","failed","cancelled"].includes(j.state)))
      throw new Error("Managed work is enabled, pending, running or uncertain.");
  }
  assertHeldAndIdle(): void {
    this.transaction(() => {
      for (const fence of this.fences) {
        const row=this.db.query<{value:string},[string]>("SELECT value FROM work_fences WHERE id=?").get(fence.id);
        if(row?.value!==fence.value) throw new Error("Installation maintenance fence changed.");
      }
      this.assertIdle();
    });
  }
  /** Register the owned writer while it is still blocked on stdin. A collector
   * crash cannot release its admission fence while the helper continues. */
  protectProcess(pid:number):void {
    if(!this.consolidation||!this.probe)throw new Error("consolidation-fence-owner-unverified");
    const helper=this.probe(pid);
    if(!helper||helper==="unknown"||!ownerValid(helper)||helper.pid!==pid||helper.uid!==this.consolidation.owner.uid)
      throw new Error("consolidation-fence-helper-unverified");
    if(this.consolidation.helper){
      if(!ownerEqual(this.consolidation.helper,helper))throw new Error("consolidation-fence-helper-changed");return;
    }
    const next={...this.consolidation,helper};
    this.transaction(()=>{
      for(const fence of this.fences){
        const current=this.db.query<{value:string},[string]>("SELECT value FROM work_fences WHERE id=?").get(fence.id);
        if(current?.value!==fence.value)throw new Error("Installation maintenance fence changed.");
      }
      for(const fence of this.fences){const value=JSON.stringify({...JSON.parse(fence.value),consolidation:next});
        this.db.query("UPDATE work_fences SET value=? WHERE id=? AND value=?").run(value,fence.id,fence.value);}
    });
    this.consolidation=next;
    for(const fence of this.fences)fence.value=JSON.stringify({...JSON.parse(fence.value),consolidation:next});
  }
  release(): void {
    if(this.consolidation?.helper){
      const helper=this.probe!(this.consolidation.helper.pid);
      if(helper==="unknown"||helper&&(!ownerValid(helper)||ownerEqual(helper,this.consolidation.helper)))
        throw new Error("consolidation-fence-helper-active-or-unverified");
    }
    this.transaction(() => {
      for (const fence of this.fences) {
        const row=this.db.query<{value:string},[string]>("SELECT value FROM work_fences WHERE id=?").get(fence.id);
        if(row?.value!==fence.value) throw new Error("Installation maintenance fence changed.");
      }
      for (const fence of this.fences) this.db.query("DELETE FROM work_fences WHERE id=? AND value=?").run(fence.id,fence.value);
    });
    this.close();
  }
  /** Failed recovery leaves durable fences intact for explicit repair. */
  close(): void { if(!this.closed){this.closed=true;this.db.close();} }
}
