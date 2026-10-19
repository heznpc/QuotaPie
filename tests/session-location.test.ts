import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { codexSessionLocation, codexSessionOrigins, SessionLocationUnavailableError } from "../src/session-location";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quotapie-session-location-"))); temporary.push(root);
  const primaryHome = join(root,"primary"), sourceHome = join(root,"source"), primaryAppData=join(root,"primary-app"), sourceData=join(root,"source-app");
  const directory=join(root,"QuotaPie"), journal=join(directory,"journal");
  for(const path of [primaryHome,sourceHome,primaryAppData,sourceData,directory,journal])mkdirSync(path,{mode:0o700});
  const manifestPath=join(journal,"manifest.json"),markerPath=join(directory,"session-consolidation.json");
  const manifest={version:1,sourceHome,primaryHome,threadIds:[B]};
  let manifestSHA256="";
  const saveManifest=()=>{const raw=JSON.stringify(manifest);writeFileSync(manifestPath,raw,{mode:0o600});manifestSHA256=createHash("sha256").update(raw).digest("hex");};saveManifest();
  const marker={version:1,state:"complete",primary:{codexHome:primaryHome,appData:primaryAppData},sources:[{codexHome:sourceHome,appData:sourceData,manifestPath,manifestSHA256}],completedAtMs:1000};
  const save=()=>{marker.sources[0]!.manifestSHA256=manifestSHA256;writeFileSync(markerPath,JSON.stringify(marker),{mode:0o600});};save();
  const config=structuredClone(DEFAULT_CONFIG);config.accounts.codex=[{id:"a",label:"A",enabled:false,codexHome:primaryHome},{id:"b",label:"B",enabled:true,codexHome:sourceHome}];
  return {root,primaryHome,sourceHome,primaryAppData,directory,manifestPath,markerPath,manifest,marker,save,saveManifest,config,
    options:{markerPath,primaryHome,primaryAppData,nowMs:2000}};
}
test("completed migration changes only session storage, retaining B consent/auth and bounded IDs",()=>{
  const f=fixture(),location=codexSessionLocation(f.config,"b",B,f.options)!;
  expect(location).toMatchObject({account:"b",ownerAccount:"a",credentialRoot:f.sourceHome,sessionRoot:f.primaryHome,consolidated:true});
  expect([...location.threadIds!]).toEqual([B]);
  expect(codexSessionLocation(f.config,"b",A,f.options)).toBeNull();
  expect(codexSessionLocation(f.config,"a",A,f.options)).toBeNull();
  expect(f.config.accounts.codex.map(p=>p.enabled)).toEqual([false,true]);
});
test("a consolidated storage owner must resolve to one configured physical profile",()=>{
  for(const kind of ["missing","duplicate"]){
    const f=fixture();
    if(kind==="missing")f.config.accounts.codex.shift();
    else f.config.accounts.codex.push({...f.config.accounts.codex[0]!,id:"ambiguous"});
    expect(()=>codexSessionLocation(f.config,"b",B,f.options)).toThrow(SessionLocationUnavailableError);
  }
});
test("preparation or absent marker keeps existing profile routing",()=>{
  const f=fixture();f.marker.state="waiting-for-source-exit";f.save();
  expect(codexSessionLocation(f.config,"b",A,f.options)).toMatchObject({sessionRoot:f.sourceHome,consolidated:false,threadIds:null});
  rmSync(f.markerPath);
  expect(codexSessionLocation(f.config,"b",A,f.options)?.sessionRoot).toBe(f.sourceHome);
});
test("invalid completed ownership evidence cannot fall back to stale retired source",()=>{
  for(const kind of ["digest","source","primary","duplicate","uuid","missing","symlink","permissions"]){
    const f=fixture();
    if(kind==="digest")writeFileSync(f.manifestPath,JSON.stringify({...f.manifest,threadIds:[A]}));
    if(kind==="source"){f.manifest.sourceHome=f.primaryHome;f.saveManifest();f.save();}
    if(kind==="primary"){f.manifest.primaryHome=f.sourceHome;f.saveManifest();f.save();}
    if(kind==="duplicate"){f.manifest.threadIds=[B,B];f.saveManifest();f.save();}
    if(kind==="uuid"){f.manifest.threadIds=["not-a-thread"];f.saveManifest();f.save();}
    if(kind==="missing")rmSync(f.manifestPath);
    if(kind==="symlink"){const target=join(f.directory,"other.json");writeFileSync(target,JSON.stringify(f.manifest),{mode:0o600});rmSync(f.manifestPath);symlinkSync(target,f.manifestPath);}
    if(kind==="permissions")chmodSync(f.manifestPath,0o666);
    expect(()=>codexSessionLocation(f.config,"b",B,f.options)).toThrow(SessionLocationUnavailableError);
  }
});
test("manifest paths cannot escape the canonical owned QuotaPie directory",()=>{
  const f=fixture(),outside=join(f.root,"outside.json");writeFileSync(outside,JSON.stringify(f.manifest),{mode:0o600});
  f.marker.sources[0]!.manifestPath=outside;f.save();
  expect(()=>codexSessionLocation(f.config,"b",B,f.options)).toThrow(SessionLocationUnavailableError);
});
test("disabled source still retains display provenance and never grants execution",()=>{
  const f=fixture();f.config.accounts.codex[1]!.enabled=false;
  expect(codexSessionLocation(f.config,"b",B,f.options)).toBeNull();
  expect(codexSessionOrigins(f.config,f.options)).toMatchObject([{account:"b",enabled:false,label:"B",sessionRoot:f.primaryHome}]);
});
test("loss or rollback of a previously verified complete marker never reopens the retired source",()=>{
  for(const kind of ["missing","pending","omitted"]){
    const f=fixture();expect(codexSessionLocation(f.config,"b",B,f.options)?.consolidated).toBe(true);
    if(kind==="missing")rmSync(f.markerPath);
    if(kind==="pending"){f.marker.state="waiting-for-source-exit";f.save();}
    if(kind==="omitted")writeFileSync(f.markerPath,JSON.stringify({...f.marker,sources:[]}));
    expect(()=>codexSessionLocation(f.config,"b",B,f.options)).toThrow(SessionLocationUnavailableError);
  }
});
test("marker identity, future completion and symlink are rejected",()=>{
  for(const kind of ["primary","future","source-duplicate","marker-link"]){
    const f=fixture();
    if(kind==="primary")f.marker.primary.codexHome=f.sourceHome;
    if(kind==="future")f.marker.completedAtMs=3000;
    if(kind==="source-duplicate")f.marker.sources.push({...f.marker.sources[0]!});
    f.save();
    if(kind==="marker-link"){const target=join(f.directory,"other-marker.json");writeFileSync(target,JSON.stringify(f.marker),{mode:0o600});rmSync(f.markerPath);symlinkSync(target,f.markerPath);}
    expect(()=>codexSessionLocation(f.config,"b",B,f.options)).toThrow(SessionLocationUnavailableError);
  }
});
test("persistent retirement never grants routing and survives a fresh resolver with no completion marker",()=>{
  for(const kind of ["missing","pending","omitted","corrupt-retirement","reused-app-data"]){
    const f=fixture(),retirementPath=join(f.directory,"session-consolidation-retirements.json");
    writeFileSync(retirementPath,JSON.stringify({version:1,sources:f.marker.sources.map(({codexHome,appData})=>({codexHome,appData}))}),{mode:0o600});
    if(kind==="missing")rmSync(f.markerPath);
    if(kind==="pending"){f.marker.state="waiting-for-source-exit";f.save();}
    if(kind==="omitted"){f.marker.sources=[];writeFileSync(f.markerPath,JSON.stringify(f.marker));}
    if(kind==="corrupt-retirement")writeFileSync(retirementPath,"{bad");
    if(kind==="reused-app-data")f.config.accounts.codex[1]!.codexHome=f.marker.sources[0]!.appData;
    // No prior call populated the in-memory completion cache for this path.
    expect(()=>codexSessionLocation(f.config,"b",B,f.options)).toThrow(SessionLocationUnavailableError);
  }
});
test("verified completion plus persistent retirement still routes only the original manifest",()=>{
  const f=fixture(),path=join(f.directory,"session-consolidation-retirements.json");
  writeFileSync(path,JSON.stringify({version:1,sources:f.marker.sources.map(({codexHome,appData})=>({codexHome,appData}))}),{mode:0o600});
  expect(codexSessionLocation(f.config,"b",B,f.options)).toMatchObject({ownerAccount:"a",sessionRoot:f.primaryHome});
  expect(codexSessionLocation(f.config,"b",A,f.options)).toBeNull();
  rmSync(path);expect(()=>codexSessionLocation(f.config,"b",B,f.options)).toThrow(SessionLocationUnavailableError);
});
