import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { codexProfileRoot, codexUsesFileCredentials, dataDirectory, type AppConfig } from "../config";
import { metadataPath } from "../dots/thread-reader";
import type { CodexThreadGoal, CodexThreadTurnSummary } from "../providers/codex-appserver";
import type { WorkExecution, WorkPolicy } from "../work/types";
import { executionPoolPolicyHash } from "../work/execution-target";
import { inspectNativeTargetOwner, nativeTargetRelayEndpoint } from "../work/native-target-lease";
import { ExecutionTargetLeaseStore, readExecutionTargetLease, type LocalRecoveryErrorCode, type LocalRecoveryRelayReason } from "../work/execution-target-lease";
import { poolAccounts, readPoolPolicy } from "../account-pool";

export interface LocalBeforeSendEvidence {
  kind: "local-before-send"; threadId:string; turnId:string; failedAtMs:number; stamp:string; cwd:string; model:string;
  errorType:"quotapie_subscription_guard"; errorCode:LocalRecoveryErrorCode;
}
export interface LocalRepair {
  parentIncidentId:string; parentExecutionId:string; parentPolicyRevision:number;
  permitId:string; sourceQuotaTurnId:string; failedTurnId:string; failedAtMs:number; stamp:string; goalFingerprint:string;
}
export const localRepairChildId = (parentId:string) => "quota-repair-"+createHash("sha256").update(parentId).digest("hex").slice(0,48);
export const localRepairGoalFingerprint = (goal:CodexThreadGoal|null) => createHash("sha256").update(JSON.stringify(goal
  ? [goal.threadId,goal.objective,goal.tokenBudget??null,["active","usageLimited"].includes(goal.status)?"runnable":goal.status]
  : null)).digest("hex");
const fileStamp = (s:Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const failureCodes = new Set<LocalRecoveryErrorCode>(["subscription_pool_execution_target_conflict","subscription_pool_execution_target_unavailable"]);

interface LocalDenialReceipt {requestId:string;at:string}
const requestIdPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const localDenialReceipt=(r:any,failedAtMs:number,afterMs:number,beforeMs:number,reason:LocalRecoveryRelayReason):r is LocalDenialReceipt=>{
  const at=Date.parse(r?.at);
  return r?.kind==="native_request"&&r.method==="POST"&&r.routeFamily==="responses"&&r.status===400&&r.origin==="relay"&&
    r.reason===reason&&requestIdPattern.test(r.requestId)&&Number.isFinite(at)&&at>=afterMs&&at<=beforeMs&&
    at<=failedAtMs&&failedAtMs-at<1000;
};
/** A log is corroboration only. The caller must still prove the exact official
 * host receipt, stable typed failure, live generation, and an unsent ACK lease.
 * Only this listener's bounded product-owned log and two rotations are read. */
export async function readLocalDenialLogReceipt(endpoint:string,failedAtMs:number,afterMs:number,beforeMs:number,reason:LocalRecoveryRelayReason="pool_execution_target_conflict"):Promise<LocalDenialReceipt|null>{
  try{
    const url=new URL(endpoint),port=Number(url.port);
    if(url.protocol!=="http:"||!["127.0.0.1","[::1]"].includes(url.hostname)||url.username||url.password||
      !Number.isInteger(port)||port<1||port>65535||![failedAtMs,afterMs,beforeMs].every(Number.isFinite)||afterMs>beforeMs)return null;
    const root=realpathSync(dataDirectory()),directory=join(root,"relay-logs"),uid=process.getuid?.();
    const directoryState=lstatSync(directory);
    if(!directoryState.isDirectory()||realpathSync(directory)!==directory||uid===undefined||directoryState.uid!==uid||(directoryState.mode&0o022)!==0)return null;
    const paths=["",".1",".2"].map(suffix=>join(directory,`${port}.jsonl${suffix}`));
    const states=paths.map(path=>{try{return lstatSync(path)}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error}});
    const found:LocalDenialReceipt[]=[];
    for(let index=0;index<paths.length;index++){
      const path=paths[index]!,state=states[index];if(!state)continue;
      if(!state.isFile()||state.uid!==uid||(state.mode&0o022)!==0||state.size>2*1024*1024||realpathSync(path)!==path)return null;
      const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{
        const opened=await file.stat();if(fileStamp(opened)!==fileStamp(state))return null;
        const bytes=Buffer.alloc(state.size);
        if((await file.read(bytes,0,bytes.length,0)).bytesRead!==bytes.length||bytes.length&&bytes.at(-1)!==10)return null;
        let offset=0,count=0;
        for(let end;(end=bytes.indexOf(10,offset))>=0;){
          if(end-offset>16*1024||end===offset)return null;
          const row=JSON.parse(bytes.subarray(offset,end).toString("utf8"));offset=end+1;
          if(!row||typeof row!=="object"||Array.isArray(row))return null;
          if(localDenialReceipt(row,failedAtMs,afterMs,beforeMs,reason))found.push({requestId:row.requestId,at:row.at});
          if(found.length>1)return null;
          if(++count%128===0)await setImmediate();
        }
        if(fileStamp(await file.stat())!==fileStamp(state))return null;
      }finally{await file.close();}
    }
    // Recheck the whole rotation manifest, including formerly missing files.
    // Rotation, appends, replacements and symlinks are retried on another poll.
    if(fileStamp(lstatSync(directory))!==fileStamp(directoryState)||realpathSync(directory)!==directory)return null;
    for(let index=0;index<paths.length;index++){
      let current:Stats|null=null;
      try{current=lstatSync(paths[index]!)}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error}
      if(states[index]?(current===null||!current.isFile()||fileStamp(current)!==fileStamp(states[index]!)):current!==null)return null;
    }
    return found.length===1?found[0]!:null;
  }catch{return null;}
}

/** This parser recognizes allowlisted exact local rejections, never a quota failure.
 * A live host/client-message receipt must independently identify its turn. */
export async function readLocalBeforeSendEvidence(config:AppConfig, execution:WorkExecution, client:{
  readLatestTurn(threadId:string):Promise<CodexThreadTurnSummary|null>;
  readTurnForClientMessage(threadId:string,clientId:string,afterTurnId?:string):Promise<CodexThreadTurnSummary|null>;
}):Promise<LocalBeforeSendEvidence|null> {
  const p=execution.policySnapshot,receipt=execution.hostQueue;
  if(!receipt?.turnId || !receipt.queuedSubmissionId || receipt.threadId!==p.nativeSessionId) return null;
  const profile=config.accounts.codex.find(a=>a.enabled&&a.id===p.account);
  if(!profile || !codexUsesFileCredentials(profile))return null;
  const root=realpathSync(codexProfileRoot(profile)),auth=join(root,"auth.json"),credentials=fileStamp(lstatSync(auth));
  const read=async():Promise<LocalBeforeSendEvidence|null>=>{
    const path=metadataPath(root,p.nativeSessionId),file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const before=await file.stat();if(!before.isFile()||before.size<1)return null;
      const size=Math.min(before.size,16*1024*1024),start=before.size-size,bytes=Buffer.alloc(size);
      if((await file.read(bytes,0,size,start)).bytesRead!==size||bytes.at(-1)!==10)return null;
      let offset=start?bytes.indexOf(10)+1:0,count=0,current:string|null=null,model:string|null=null,marked=false,changedUser=false;
      let terminal:LocalBeforeSendEvidence|null=null;
      for(let end;(end=bytes.indexOf(10,offset))>=0;){
        const line=bytes.subarray(offset,end).toString("utf8");offset=end+1;if(!line)continue;
        if(++count%128===0)await setImmediate();
        const row=JSON.parse(line),v=row.payload;if(!v||typeof v!=="object")return null;
        // Any later record or user input invalidates this exact final failure.
        terminal=null;
        // Native turns may inherit the preceding context without writing a
        // duplicate turn_context. Retain only a context actually present in
        // this stable rollout tail; a later model change replaces it.
        if(row.type==="turn_context")model=typeof v.model==="string"?v.model:null;
        if(row.type==="event_msg"&&v.type==="task_started"){current=v.turn_id;marked=false;changedUser=false;}
        if(current!==receipt.turnId)continue;
        if(row.type==="response_item"&&v.role==="user"||row.type==="event_msg"&&v.type==="user_message"){
          const text=typeof v.message==="string"?v.message:typeof v.content==="string"?v.content:Array.isArray(v.content)?v.content.map((x:any)=>typeof x?.text==="string"?x.text:"").join(""):"";
          if(text===p.prompt&&text.startsWith(`[QuotaPie quota recovery:${p.id}]\n`))marked=true;
          else if(!/^<environment_context>[\s\S]*<\/environment_context>\s*$/.test(text.trim()))changedUser=true;
        }
        if(row.type!=="event_msg"||v.type!=="task_complete"||v.turn_id!==receipt.turnId||!marked||changedUser||!model)continue;
        // The native host wraps a failed /responses/compact terminal with this
        // exact prefix. Parse the remaining structured error, never prose that
        // merely mentions a local error code.
        let error:any;try{
          const raw=v.error?.message,prefix="Error running remote compact task: ";
          error=JSON.parse(typeof raw==="string"&&raw.startsWith(prefix)?raw.slice(prefix.length):raw)?.error;
        }catch{continue;}
        const at=Date.parse(row.timestamp);
        if(error?.type!=="quotapie_subscription_guard"||!failureCodes.has(error.code)||!Number.isFinite(at)||at<receipt.sentAtMs||at>Date.now())continue;
        terminal={kind:"local-before-send",threadId:p.nativeSessionId,turnId:receipt.turnId,failedAtMs:at,
          stamp:`${path}:${fileStamp(before)}`,cwd:realpathSync(p.cwd),model,errorType:error.type,errorCode:error.code};
      }
      const after=await file.stat();
      return terminal&&fileStamp(before)===fileStamp(after)&&fileStamp(statSync(path))===fileStamp(after)&&metadataPath(root,p.nativeSessionId)===path&&
        terminal.model===p.model?terminal:null;
    }finally{await file.close();}
  };
  try {
    const before=await read();if(!before)return null;
    const correlated=await client.readTurnForClientMessage(receipt.threadId,receipt.clientUserMessageId,p.quotaResume?.turnId);
    const latest=await client.readLatestTurn(receipt.threadId);
    for(const turn of [correlated,latest])if(!turn||turn.threadId!==before.threadId||turn.turnId!==before.turnId||turn.status!=="failed"||
      turn.completedAtMs!==Math.floor(before.failedAtMs/1000)*1000||turn.errorCode==="usageLimitExceeded")return null;
    const after=await read(),fresh=config.accounts.codex.find(a=>a.enabled&&a.id===p.account);
    return after&&fresh&&codexUsesFileCredentials(fresh)&&realpathSync(codexProfileRoot(fresh))===root&&credentials===fileStamp(lstatSync(auth))&&
      JSON.stringify(before)===JSON.stringify(after)?after:null;
  }catch{return null;}
}

export function localRepairParentMatches(policy:WorkPolicy,execution:WorkExecution):boolean {
  const p=execution.policySnapshot;
  return !policy.enabled&&policy.purpose==="quota-resume"&&policy.state.turns===1&&
    !policy.state.activeExecutionId&&policy.state.status==="failed"&&policy.revision===execution.policyRevision+1&&JSON.stringify(policy.state.lastResult)===JSON.stringify(execution.result)&&
    execution.status==="finished"&&execution.dispatchedAtMs!==undefined&&execution.result?.status==="failed"&&!!execution.hostQueue?.turnId&&!!execution.executionTarget&&
    ["account","profileKey","accountKey","nativeSessionId","model","prompt","objective","quotaResume"].every(key=>
      JSON.stringify(policy[key as keyof WorkPolicy])===JSON.stringify(p[key as keyof WorkPolicy]));
}

export async function createLocalRepair(config:AppConfig,parentIncidentId:string,policy:WorkPolicy,execution:WorkExecution,childPolicyId:string,
  client:Parameters<typeof readLocalBeforeSendEvidence>[2]&{readThreadGoal(threadId:string):Promise<CodexThreadGoal|null>}):Promise<LocalRepair|null>{
  if(!localRepairParentMatches(policy,execution))return null;
  const evidence=await readLocalBeforeSendEvidence(config,execution,client);if(!evidence)return null;
  const sourceQuotaTurnId=policy.quotaResume?.localBeforeSendRecovery?.sourceQuotaTurnId??policy.quotaResume!.turnId;
  const goal=await client.readThreadGoal(policy.nativeSessionId);if(goal&&!['active','usageLimited'].includes(goal.status))return null;
  const lease=readExecutionTargetLease(execution.id),target=execution.executionTarget!,accounts=poolAccounts(config);
  if(!lease?.acknowledgedAtMs||lease.targetRequest||lease.upstreamResponse||lease.source.threadId!==policy.nativeSessionId||
    lease.source.failedTurnId!==policy.quotaResume?.turnId||lease.source.evidenceStamp!==policy.quotaResume?.stamp||
    lease.target.identity!==target.identity||lease.target.poolPolicyHash!==executionPoolPolicyHash(readPoolPolicy())||
    !accounts.some(a=>a.id===policy.account&&a.identity===lease.source.identity)||!accounts.some(a=>a.id===target.account&&a.identity===target.identity))return null;
  const endpoint=nativeTargetRelayEndpoint(config,policy),owner=await inspectNativeTargetOwner(config,policy);
  if(owner.pid!==lease.source.nativeOwner?.pid||owner.startedAtMs!==lease.source.nativeOwner?.startedAtMs)return null;
  const response=await fetch(endpoint+"/quotapie-health",{signal:AbortSignal.timeout(5000),redirect:"error"});if(!response.ok)return null;
  const health:any=await response.json();
  if(health.executionTargetRelayInstanceId!==lease.relayInstanceId||health.subscriptionGuard?.account!==policy.account||health.subscriptionGuard?.profileKey!==policy.profileKey)return null;
  if(lease.localRecoveryPermit){
    const store=new ExecutionTargetLeaseStore();
    try{
      const permit=store.validateLocalRecoveryPermit(lease.localRecoveryPermit.id,execution.id,childPolicyId,sourceQuotaTurnId,evidence.turnId);
      if(permit.host.clientUserMessageId!==execution.hostQueue!.clientUserMessageId||permit.host.completedAtMs!==evidence.failedAtMs||permit.relay.instanceId!==health.executionTargetRelayInstanceId||permit.goalFingerprint!==localRepairGoalFingerprint(goal))return null;
      return {parentIncidentId,parentExecutionId:execution.id,parentPolicyRevision:policy.revision,permitId:permit.id,sourceQuotaTurnId,
        failedTurnId:evidence.turnId,failedAtMs:evidence.failedAtMs,stamp:evidence.stamp,goalFingerprint:localRepairGoalFingerprint(goal)};
    }finally{store.close();}
  }
  const reason=evidence.errorCode.slice("subscription_".length) as LocalRecoveryRelayReason;
  const matches=(health.recentNativeRequests??[]).filter((r:any)=>localDenialReceipt(r,evidence.failedAtMs,lease.acknowledgedAtMs!,lease.expiresAtMs,reason));
  if(matches.length>1)return null;
  const denial:LocalDenialReceipt|null=matches[0]??await readLocalDenialLogReceipt(endpoint,evidence.failedAtMs,lease.acknowledgedAtMs,lease.expiresAtMs,reason);
  if(!denial)return null;
  // The exact structured host error identifies the pre-fetch code path. The
  // listener receipt corroborates generation; timestamp proximity alone cannot
  // authorize a repair or establish request ownership.
  const fresh=await readLocalBeforeSendEvidence(config,execution,client);if(!fresh||fresh.stamp!==evidence.stamp)return null;
  const store=new ExecutionTargetLeaseStore();
  try {
    const permit=store.createLocalRecoveryPermit({parentExecutionId:execution.id,childPolicyId,sourceQuotaTurnId,goalFingerprint:localRepairGoalFingerprint(goal),
      host:{threadId:evidence.threadId,turnId:evidence.turnId,clientUserMessageId:execution.hostQueue!.clientUserMessageId,status:"failed",
        errorType:evidence.errorType,errorCode:evidence.errorCode,completedAtMs:evidence.failedAtMs},
      relay:{instanceId:health.executionTargetRelayInstanceId,requestId:denial.requestId,status:400,origin:"relay",reason,observedAtMs:Date.parse(denial.at)}});
    return {parentIncidentId,parentExecutionId:execution.id,parentPolicyRevision:policy.revision,permitId:permit.id,
      sourceQuotaTurnId,failedTurnId:evidence.turnId,failedAtMs:evidence.failedAtMs,stamp:evidence.stamp,goalFingerprint:localRepairGoalFingerprint(goal)};
  }finally{store.close();}
}
