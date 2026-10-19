import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { resumeProfileKey } from "../src/resume-gate";
import { readConfiguredThread, readExecutionConfiguration } from "../src/dots/thread-reader";
import { inspectManagedSession } from "../src/dots/managed-continuation";
import { wakeHostQueuedThread } from "../src/quota-resume/host-wake";
import { executeHostQueuedQuotaResume } from "../src/quota-resume/host-queue";
import { readLocalBeforeSendEvidence } from "../src/quota-resume/local-repair";
import { readOfficialThreadCandidates } from "../src/official-thread-usage";
import type { DotPolicy } from "../src/dots/store";
import type { WorkPolicy, WorkExecutionTarget, WorkExecution } from "../src/work/types";

const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const threadId="11111111-1111-4111-8111-111111111111",turnId="22222222-2222-4222-8222-222222222222";
function credentials(root:string,identity:string){
  const jwt=(payload:unknown)=>"header."+Buffer.from(JSON.stringify(payload)).toString("base64url")+".signature";
  const claim={sub:identity,"https://api.openai.com/auth":{chatgpt_account_id:identity}};
  writeFileSync(join(root,"auth.json"),JSON.stringify({auth_mode:"chatgpt",tokens:{account_id:identity,
    id_token:jwt({...claim,email:identity+"@example.test"}),access_token:jwt({...claim,"https://api.openai.com/profile":{email:identity+"@example.test"}})}}));
}
function fixture(){
  const base=realpathSync(mkdtempSync(join(tmpdir(),"quotapie-consolidated-access-")));roots.push(base);
  const primaryHome=join(base,"primary"),sourceHome=join(base,"source"),primaryAppData=join(base,"primary-app"),sourceData=join(base,"source-app"),directory=join(base,"QuotaPie");
  for(const path of [primaryHome,sourceHome,primaryAppData,sourceData,directory,join(primaryHome,"sessions"),join(primaryHome,"thread-writer-locks")])mkdirSync(path,{mode:0o700});
  credentials(primaryHome,"a");credentials(sourceHome,"b");
  const path=join(primaryHome,"sessions","moved.jsonl"),at=Date.now()-1000;
  writeFileSync(path,[{type:"session_meta",payload:{id:threadId}},{type:"turn_context",payload:{model:"gpt-6.1-sol",effort:"medium"}},
    {type:"event_msg",timestamp:new Date(at).toISOString(),payload:{type:"task_complete",turn_id:turnId}}].map(v=>JSON.stringify(v)).join("\n")+"\n");
  const db=new Database(join(primaryHome,"state_5.sqlite"));db.run("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT)");db.run("INSERT INTO threads VALUES(?,?,?)",[threadId,path,base]);db.close();
  const manifestPath=join(directory,"manifest.json"),markerPath=join(directory,"session-consolidation.json");
  const manifest=JSON.stringify({version:1,sourceHome,primaryHome,threadIds:[threadId]});writeFileSync(manifestPath,manifest,{mode:0o600});
  writeFileSync(markerPath,JSON.stringify({version:1,state:"complete",completedAtMs:at,primary:{codexHome:primaryHome,appData:primaryAppData},
    sources:[{codexHome:sourceHome,appData:sourceData,manifestPath,manifestSHA256:createHash("sha256").update(manifest).digest("hex")}]}),{mode:0o600});
  const config=structuredClone(DEFAULT_CONFIG);config.accounts.codex=[{id:"a",label:"A",enabled:true,codexHome:primaryHome},{id:"b",label:"B",enabled:true,codexHome:sourceHome}];
  const policy={id:"b-consent",account:"b",threadId,profileKey:resumeProfileKey(config,"codex","b")!,accountKey:"b".repeat(64)} as DotPolicy;
  const gate={schemaVersion:1,provider:"codex",account:"b",profileKey:policy.profileKey,accountKey:policy.accountKey,ready:false,reason:"reserve-reached",checkedAtMs:Date.now(),retryAtMs:null,windows:[]} as const;
  return{base,primaryHome,sourceHome,path,markerPath,config,policy,gate,sessionLocation:{markerPath,primaryHome,primaryAppData}};
}

test("B consent reads canonical A thread/config while separately verifying both account identities",async()=>{
  const f=fixture(),homes:string[]=[],accounts:string[]=[];
  const options={sessionLocation:f.sessionLocation,readGate:async(p:DotPolicy)=>{accounts.push(p.account);return {...f.gate,windows:[]};},binary:()=>"/fixture/codex",
    transport:async(_binary:string,home:string)=>{homes.push(home);return{close:async()=>{},request:async(method:string)=>
      method==="account/read"?{account:{type:"chatgpt",email:"a@example.test",planType:"pro"}}:
      method==="thread/read"?{thread:{id:threadId,path:f.path,cwd:f.base,status:{type:"notLoaded"}}}:
      method==="config/read"?{config:{mcp_servers:{canonical:{}}},layers:[]}:{} };}};
  const result=await readConfiguredThread(f.config,f.policy,options);
  expect(result.account).toBe("b");expect(result.threadId).toBe(threadId);
  const execution=await readExecutionConfiguration(f.config,f.policy,f.base,options);
  expect(execution.mcpServers).toEqual(["canonical"]);expect(execution.unchanged()).toBe(true);
  expect(homes).toEqual([f.primaryHome,f.primaryHome]);expect(accounts.every(a=>a==="b")).toBe(true);
  credentials(f.sourceHome,"new-b");expect(execution.unchanged()).toBe(false);
  expect(()=>inspectManagedSession(f.config,f.policy,"managed-cli",f.sessionLocation)).toThrow("consolidated-host-queue-required");
  expect(inspectManagedSession(f.config,f.policy,"host-queue",f.sessionLocation)).toMatchObject({root:f.primaryHome,cwd:f.base});
});

test("moved thread reader rejects changed consent or physical owner before accepting metadata",async()=>{
  for(const changed of ["a","b","manifest"]){
    const f=fixture();let opened=0;
    await expect(readConfiguredThread(f.config,f.policy,{sessionLocation:f.sessionLocation,readGate:async()=>({...f.gate,windows:[]}),binary:()=>"/fixture/codex",
      transport:async()=>{opened++;return{close:async()=>{},request:async(method)=>{
        if(method==="account/read")return{account:{type:"chatgpt",email:"a@example.test"}};
        if(method==="thread/read"){
          if(changed==="manifest")rmSync(f.markerPath);else credentials(changed==="a"?f.primaryHome:f.sourceHome,"changed");
          return{thread:{id:threadId,path:f.path,cwd:f.base,status:{type:"notLoaded"}}};
        }return{};
      }};}})).rejects.toThrow();expect(opened).toBe(1);
  }
});

test("moved B host wake addresses A owner but B revocation still prevents the send",async()=>{
  for(const revoke of [false,true]){
    const f=fixture(),writes:string[]=[];let output:ReadableStreamDefaultController<Uint8Array>,finish!:(value:number)=>void,stopped=false;
    const child={stdout:new ReadableStream<Uint8Array>({start(c){output=c;}}),exited:new Promise<number>(r=>{finish=r;}),
      stdin:{write(value:string){writes.push(value);if(writes.length===1&&revoke)f.config.accounts.codex[1]!.enabled=false;
        output.enqueue(new TextEncoder().encode(JSON.stringify({status:writes.length===1?"ready":"sent"})+"\n"));},flush(){},end(){}},
      kill(){if(!stopped){stopped=true;try{output.close();}catch{}finish(0);}}};
    const result=await wakeHostQueuedThread({config:f.config,account:"b",threadId},{platform:"darwin",sessionLocation:f.sessionLocation,launch:()=>child,repairProvider:async()=>true});
    expect(JSON.parse(writes[0]!)).toEqual({account:"a",codexHome:f.primaryHome,threadId});
    expect(result.status).toBe(revoke?"unavailable":"sent");expect(writes.length).toBe(revoke?1:2);
  }
});

test("canonical host queue requires explicit target lease and never reads stale B storage",async()=>{
  for(const targeted of [false,true]){
    const f=fixture(),st=statSync(f.path),stamp=`${f.path}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    writeFileSync(join(f.primaryHome,"thread-writer-locks",threadId+".lock"),"owner");
    const policy={id:"incident",provider:"codex",account:"b",profileKey:f.policy.profileKey,accountKey:f.policy.accountKey,purpose:"quota-resume",
      quotaResume:{turnId,stamp},nativeSessionId:threadId,cwd:f.base,model:"gpt-6.1-sol",prompt:"Continue once",objective:"Continue",completionCriteria:[],
      dispatchOwner:"local",enabled:true,trigger:"quota-ready",maxTurns:1,maxDurationSeconds:1,maxTotalDurationSeconds:1,expiresAtMs:100_000,
      state:{turns:0,totalDurationSeconds:0,spentByBucket:{},baselines:{},status:"running"}} as unknown as WorkPolicy;
    let now=10_000,adds=0,done=false;
    const target={account:"b"} as WorkExecutionTarget;
    const result=await executeHostQueuedQuotaResume({config:f.config,policy,claimId:"one",...(targeted?{executionTarget:target}:{})},{
      sessionLocation:f.sessionLocation,stillAuthorized:()=>true,beforeEnqueue:async()=>{},onReceipt:()=>{},now:()=>now,
      targetLease:{acknowledge:async()=>{},current:()=>true,renew:async()=>{},close(){}},
      client:{listThreadQueue:async()=>({data:[],nextCursor:null}),addThreadQueue:async(_id,clientUserMessageId,_text,before)=>{before?.();adds++;return{id:"44444444-4444-4444-8444-444444444444",clientUserMessageId};},
        deleteThreadQueue:async()=>true,readTurnForClientMessage:async()=>done?{threadId,turnId:"33333333-3333-4333-8333-333333333333",status:"completed",errorCode:null,completedAtMs:now}:null},
      readEvidence:async(_config,account)=>{expect(account).toBe("b");return{threadId,turnId,stamp,cwd:f.base,model:"gpt-6.1-sol",failedAtMs:1};},
      wakeHost:async()=>({status:"sent"}),sleep:async(ms)=>{now+=ms;done=true;},pollMs:10});
    expect(result.status).toBe(targeted?"turn-finished":"failed");expect(adds).toBe(targeted?1:0);
    expect(f.config.accounts.codex[1]!.codexHome).toBe(f.sourceHome);
  }
});

test("local repair reads only migrated history and pins both consent B and physical A credentials",async()=>{
  for(const changed of ["none","a","b","manifest"]){
    const f=fixture(),at=Date.now()-2000,prompt="[QuotaPie quota recovery:incident]\nContinue once";
    const row=(type:string,payload:unknown)=>({timestamp:new Date(at).toISOString(),type,payload});
    writeFileSync(f.path,[row("session_meta",{id:threadId}),row("turn_context",{model:"gpt-6.1-sol"}),row("event_msg",{type:"task_started",turn_id:turnId}),
      row("response_item",{role:"user",content:[{type:"input_text",text:prompt}]}),row("event_msg",{type:"task_complete",turn_id:turnId,error:{message:JSON.stringify({error:{type:"quotapie_subscription_guard",code:"subscription_pool_execution_target_unavailable"}})}})].map(v=>JSON.stringify(v)).join("\n")+"\n");
    const policy={id:"incident",account:"b",nativeSessionId:threadId,cwd:f.base,model:"gpt-6.1-sol",prompt,quotaResume:{turnId:"original",stamp:"unchanged-original"}} as WorkPolicy;
    const execution={policySnapshot:policy,hostQueue:{threadId,turnId,queuedSubmissionId:"queued",clientUserMessageId:"client",sentAtMs:at-1000}} as WorkExecution;
    const turn={threadId,turnId,status:"failed" as const,errorCode:"other",completedAtMs:Math.floor(at/1000)*1000};
    const result=await readLocalBeforeSendEvidence(f.config,execution,{readTurnForClientMessage:async()=>turn,readLatestTurn:async()=>{
      if(changed==="manifest")rmSync(f.markerPath);else if(changed!=="none")credentials(changed==="a"?f.primaryHome:f.sourceHome,"new-identity");return turn;
    }},{sessionLocation:f.sessionLocation});
    if(changed==="none")expect(result?.stamp).toContain(f.path);else expect(result).toBeNull();
    expect(policy.quotaResume?.stamp).toBe("unchanged-original");
  }
});

test("official B query metadata follows canonical IDs while credentials and unrelated A scope stay separate",()=>{
  const f=fixture(),db=new Database(join(f.primaryHome,"state_5.sqlite"));
  db.exec("ALTER TABLE threads ADD COLUMN title TEXT;ALTER TABLE threads ADD COLUMN created_at INTEGER;ALTER TABLE threads ADD COLUMN updated_at INTEGER;ALTER TABLE threads ADD COLUMN creator_account_id TEXT;CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT);");
  db.run("UPDATE threads SET title='Updated canonical B',created_at=1,updated_at=2,creator_account_id='b'");
  db.run("INSERT INTO threads(id,title,created_at,updated_at,creator_account_id) VALUES(?,?,1,3,NULL)",[turnId,"Unrelated A"]);db.close();
  const options={config:f.config,sessionLocation:f.sessionLocation};
  expect(readOfficialThreadCandidates(f.config.accounts.codex[1]!,"b",options)).toMatchObject([{threadId,title:"Updated canonical B",ownershipBasis:"creator_account"}]);
  expect(readOfficialThreadCandidates(f.config.accounts.codex[0]!,"a",options).map(r=>r.threadId)).toEqual([turnId]);
  expect(()=>readOfficialThreadCandidates(f.config.accounts.codex[1]!,"a",options)).toThrow("thread_account_unknown");
  f.config.accounts.codex[1]!.enabled=false;
  expect(readOfficialThreadCandidates(f.config.accounts.codex[1]!,"b",options)).toEqual([]);
  expect(readOfficialThreadCandidates(f.config.accounts.codex[0]!,"a",options).map(r=>r.threadId)).toEqual([turnId]);
});
