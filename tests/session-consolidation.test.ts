import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { SessionConsolidation,consolidationRequestKey } from "../src/session-consolidation";
import {InstallMaintenance,type MaintenanceOwner,type MaintenanceOwnerProbe} from "../script/install-maintenance";
import {QuotaStorage} from "../src/storage/database";
import {WorkStore} from "../src/work/store";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "session-consolidation-"))); homes.push(home);
  const primary = { codexHome: join(home, ".codex"), appData: join(home, "Library/Application Support/Codex") };
  const source = { codexHome: join(home, "secondary/home"), appData: join(home, "secondary/app-data") };
  const support = join(home, "Library/Application Support/QuotaPie");
  for (const path of [...Object.values(primary), ...Object.values(source), support]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "a", label: "A", codexHome: primary.codexHome, enabled: true },
    { id: "b", label: "B", codexHome: source.codexHome, enabled: true }];
  return { home, primary, source, support, config };
}

test("running source stays enrolled without applying, fencing or publishing a complete marker", async () => {
  const f = fixture(); const calls: string[] = [];
  const manager = new SessionConsolidation(f.config, { home: f.home, registeredSources: () => [f.source],
    run: async op => { calls.push(op); return { version: 1, state: "waiting", reason: "source-running", threadCount: 207 }; },
    acquireFence: () => { throw new Error("must not fence while source is running"); },
  });
  manager.request({ source: f.source }); await manager.tick();
  expect(calls).toEqual(["plan"]);
  expect(manager.status()).toMatchObject({ state: "waiting-for-source-exit", reason: "source-running", threadCount: 207 });
  expect(existsSync(join(f.support, "session-consolidation-request.json"))).toBe(true);
  expect(existsSync(join(f.support, "session-consolidation.json"))).toBe(false);
  await manager.close();
});

test("ready migration publishes only a verified ID manifest, releases fence, and remains idempotent", async () => {
  const f = fixture(); let held = false, released = 0; const calls: string[] = [];
  const manager = new SessionConsolidation(f.config, { home: f.home, registeredSources: () => [f.source],
    acquireFence: () => { held = true; return { assertHeldAndIdle() { expect(held).toBe(true); }, release() { held = false; released++; } }; },
    run: async (op, request) => {
      calls.push(op);
      if (op === "plan") return { version: 1, state: "ready", threadCount: 1 };
      expect(held).toBe(true);
      mkdirSync(request.journalDirectory, { recursive: true, mode: 0o700 });
      const manifestPath = join(request.journalDirectory, "ownership.json");
      const bytes = JSON.stringify({ version: 1, sourceHome: f.source.codexHome, primaryHome: f.primary.codexHome,
        threadIds: ["00000000-0000-4000-8000-000000000011"] });
      writeFileSync(manifestPath, bytes, { mode: 0o600 });
      return { version: 1, state: "complete", threadCount: 1, manifestPath, manifestSHA256: createHash("sha256").update(bytes).digest("hex") };
    },
  });
  manager.request({ source: f.source }); await manager.tick(); await manager.tick();
  expect(calls).toEqual(["plan", "apply"]); expect(released).toBe(1);
  expect(manager.status().state).toBe("complete");
  const marker = JSON.parse(readFileSync(join(f.support, "session-consolidation.json"), "utf8"));
  expect(marker.sources[0]).toMatchObject(f.source);
  expect(marker.primary).toEqual(f.primary);
  expect(JSON.parse(readFileSync(join(f.support, "session-consolidation-retirements.json"), "utf8")))
    .toEqual({ version: 1, sources: [f.source] });
  expect(existsSync(join(f.support, "session-consolidation-request.json"))).toBe(false);
});

test("tampered completion proof is blocked and never changes session ownership", async () => {
  const f = fixture(); let released = false;
  const manager = new SessionConsolidation(f.config, { home: f.home, registeredSources: () => [f.source],
    acquireFence: () => ({ assertHeldAndIdle() {}, release() { released = true; } }),
    run: async op => op === "plan" ? { version: 1, state: "ready" } :
      { version: 1, state: "complete", threadCount: 1, manifestPath: "/tmp/unowned.json", manifestSHA256: "a".repeat(64) },
  });
  manager.request({ source: f.source }); await manager.tick();
  expect(released).toBe(true); expect(manager.status().state).toBe("blocked");
  expect(existsSync(join(f.support, "session-consolidation.json"))).toBe(false);
});

test("new manager resumes pending enrollment and refuses changed account bindings", async () => {
  const f = fixture();
  const first = new SessionConsolidation(f.config, { home: f.home, registeredSources: () => [f.source], run: async () => ({ version: 1, state: "waiting" }) });
  first.request({ source: f.source }); await first.tick(); await first.close();
  f.config.accounts.codex[1]!.enabled = false;
  const second = new SessionConsolidation(f.config, { home: f.home, registeredSources: () => [f.source], run: async () => { throw new Error("must not execute"); } });
  await second.tick();
  expect(second.status()).toMatchObject({ state: "blocked", reason: "consolidation-binding-changed" });
});

test("source must be a registered, separate account home", () => {
  const f = fixture(); const manager = new SessionConsolidation(f.config, { home: f.home, registeredSources: () => [f.source] });
  expect(() => manager.request({ source: f.primary })).toThrow("consolidation-source-unverified");
  expect(() => manager.request({ source: { ...f.source, unknown: true } })).toThrow("consolidation-invalid-source");
});

test("a different app data path is refused even for a registered credential root", () => {
  const f = fixture();
  const manager = new SessionConsolidation(f.config, { home: f.home, registeredSources: () => [f.source] });
  expect(() => manager.request({ source: { ...f.source, appData: f.support } })).toThrow("consolidation-source-unverified");
  expect(existsSync(join(f.support, "session-consolidation-request.json"))).toBe(false);
});

test("owned reader quiescence rechecks the native writer and restores readers when another writer remains", async () => {
  const f = fixture(); let calls = 0, quiesced = false, restored = false, released = false;
  const manager = new SessionConsolidation(f.config, { home: f.home, registeredSources: () => [f.source],
    acquireFence: () => ({ assertHeldAndIdle() {}, release() { released = true; } }),
    quiesceSource: async source => { expect(source).toEqual(f.source); quiesced = true; return () => { restored = true; }; },
    run: async op => {
      expect(op).toBe("plan"); calls++;
      if (calls > 1) expect(quiesced).toBe(true);
      return { version: 1, state: "waiting", reason: calls === 1 ? "source-client-running" : "source-host-running" };
    },
  });
  manager.request({ source: f.source }); await manager.tick();
  expect(calls).toBe(2); expect(restored).toBe(true); expect(released).toBe(true);
  expect(manager.status()).toMatchObject({ state: "waiting-for-source-exit", reason: "source-host-running" });
  expect(existsSync(join(f.support, "session-consolidation.json"))).toBe(false);
});

test("post-marker interruption retains the same request key until its fence releases on restart",async()=>{
 const f=fixture(),keys:string[]=[];let failRelease=true,applies=0;
 const dependencies={home:f.home,registeredSources:()=>[f.source],acquireFence:(key:string)=>{
  keys.push(key);return{assertHeldAndIdle(){},release(){if(failRelease)throw new Error("simulated interrupted owner");}};},
  run:async(op:"plan"|"apply",request:any)=>{
   if(op==="plan")return{version:1 as const,state:"ready" as const,threadCount:1};
   applies++;mkdirSync(request.journalDirectory,{recursive:true,mode:0o700});const manifestPath=join(request.journalDirectory,"ownership.json");
   const bytes=JSON.stringify({version:1,sourceHome:f.source.codexHome,primaryHome:f.primary.codexHome,threadIds:["00000000-0000-4000-8000-000000000011"]});
   writeFileSync(manifestPath,bytes,{mode:0o600});return{version:1 as const,state:"complete" as const,threadCount:1,manifestPath,manifestSHA256:createHash("sha256").update(bytes).digest("hex")};
  }};
 const first=new SessionConsolidation(f.config,dependencies);first.request({source:f.source});
 await expect(first.tick()).rejects.toThrow("simulated interrupted owner");await first.close();
 expect(existsSync(join(f.support,"session-consolidation.json"))).toBe(true);
 expect(existsSync(join(f.support,"session-consolidation-request.json"))).toBe(true);
 failRelease=false;const second=new SessionConsolidation(f.config,dependencies);await second.tick();
 expect(second.status().state).toBe("complete");expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
 expect(applies).toBe(2);expect(existsSync(join(f.support,"session-consolidation-request.json"))).toBe(false);await second.close();
});

for(const remainingHelper of ["dead","alive","unknown","source-disabled","source-removed","active-work"] as const)
test(`source GUI waiting recovers only an interrupted collector with ${remainingHelper} helper`,async()=>{
 const f=fixture(),path=join(f.home,"quota.sqlite3"),storage=new QuotaStorage(path),store=new WorkStore(storage);
 let self:MaintenanceOwner={pid:process.pid,uid:process.getuid!(),start:"2000000000.000001"};
 const helper:MaintenanceOwner={pid:999998,uid:self.uid,start:"2000000000.000002"};
 let helperState:MaintenanceOwner|null|"unknown"=helper;
 const probe:MaintenanceOwnerProbe=pid=>pid===process.pid?self:pid===helper.pid?helperState:null;
 const accounts=[{provider:"codex" as const,account:"b"}];
 const first=new SessionConsolidation(f.config,{home:f.home,registeredSources:()=>[f.source],run:async()=>({version:1,state:"waiting",reason:"source-host-running"})});
 let manager:SessionConsolidation|undefined;
 try{
  first.request({source:f.source});await first.tick();await first.close();
  const request=JSON.parse(readFileSync(join(f.support,"session-consolidation-request.json"),"utf8"));
  const fence=InstallMaintenance.acquireConsolidation(path,consolidationRequestKey(request),accounts,probe)!;
  fence.protectProcess(helper.pid);fence.close();
  const before=store.fences();self={...self,start:"2000000001.000001"};helperState=remainingHelper==="alive"?helper:remainingHelper==="unknown"?"unknown":null;
  if(remainingHelper==="source-disabled")f.config.accounts.codex[1]!.enabled=false;
  if(remainingHelper==="source-removed")f.config.accounts.codex.splice(1,1);
  if(remainingHelper==="active-work")storage.db.query("INSERT INTO work_executions(id,policy_id,value) VALUES(?,?,?)").run("active","work",JSON.stringify({status:"claimed"}));
  const calls:string[]=[];
  manager=new SessionConsolidation(f.config,{home:f.home,registeredSources:()=>[f.source],
   recoverFence:key=>InstallMaintenance.recoverConsolidation(path,key,remainingHelper==="source-removed"?[]:accounts,probe),
   acquireFence:()=>{throw new Error("no new fence while source GUI is running");},
   run:async op=>{calls.push(op);return{version:1,state:"waiting",reason:"source-host-running"};}});
  await manager.tick();await manager.tick();
  if(remainingHelper==="dead"){
   expect(calls).toEqual(["plan","plan"]);expect(store.fences()).toEqual([]);
   expect(manager.status()).toMatchObject({state:"waiting-for-source-exit",reason:"source-host-running"});
  }else if(remainingHelper==="source-disabled"||remainingHelper==="source-removed"){
   expect(calls).toEqual([]);expect(store.fences()).toEqual([]);
   expect(manager.status()).toMatchObject({state:"blocked",reason:"consolidation-binding-changed"});
  }else{
   expect(calls).toEqual([]);expect(store.fences()).toEqual(before);
   expect(manager.status()).toMatchObject({state:"blocked",reason:remainingHelper==="active-work"?"consolidation-inspection-unavailable":"consolidation-fence-helper-active-or-unverified"});
  }
  expect(existsSync(join(f.support,"session-consolidation.json"))).toBe(false);
  expect(existsSync(join(f.support,"session-consolidation-request.json"))).toBe(true);
 }finally{await manager?.close();storage.close();}
});
