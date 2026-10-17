import type {AppConfig} from "../config";
import type {ResumeGate} from "../resume-gate";
import {runManagedContinuation} from "../dots/managed-continuation";
import type {DotPolicy} from "../dots/store";
import type {WorkPolicy,WorkResult} from "./types";
import {parseWorkProgress,progressSchema} from "./runtime";

export async function executeCodexWork(config:AppConfig, policy:WorkPolicy, claimId:string,
  stillAuthorized:()=>boolean, readGate:()=>ResumeGate):Promise<WorkResult> {
  const start=Date.now();
  const timeout=Math.floor(Math.min(policy.maxDurationSeconds,policy.maxTotalDurationSeconds-policy.state.totalDurationSeconds,
    (policy.expiresAtMs-start)/1000,((policy.workDeadline??Infinity)-start)/1000));
  const prompt=`${policy.prompt}\nObjective: ${policy.objective}\nCompletion criteria: ${JSON.stringify(policy.completionCriteria)}\nPrevious result: ${JSON.stringify(policy.state.lastResult??null)}\nAt the end return only a JSON object conforming to ${JSON.stringify(progressSchema(claimId,policy.revision))}. Completion requires evidence. Report remaining work or the question that blocks progress. Do not create busywork to use quota.`;
  const adapter:DotPolicy={id:policy.id,threadId:policy.nativeSessionId,account:policy.account,
    profileKey:policy.profileKey,accountKey:policy.accountKey,continuation:prompt,executionMode:"profile-managed",
    executionPurpose:"continue-work",maxDurationSeconds:timeout,enabled:policy.enabled,trigger:"quota.ready",
    resetWithinMinutes:policy.resetWithinMinutes,reservePercent:0,maxTurns:Math.min(100,policy.maxTurns),maxUsagePercent:100,
    expiresAtMs:policy.expiresAtMs,priority:policy.priority};
  const budgetByBucket=Object.fromEntries(Object.entries(policy.budgetByBucket).map(([bucket,budget])=>[bucket,{
    reservePercent:budget.reservePercent,remainingUsagePercent:Math.max(0,budget.maxUsagePercent-(policy.state.spentByBucket[bucket]??0)),
  }]));
  const outcome=await runManagedContinuation({config,policy:adapter,claimId},{stillAuthorized,readGate:async()=>readGate(),structuredWork:true,budgetByBucket});
  let result:WorkResult;
  if(outcome.outcome==="quota-blocked") result={status:"quota-blocked",reason:outcome.reason};
  else if(outcome.outcome!=="completed") result={status:outcome.processStopped ? "activity-paused" : outcome.attempts ? "uncertain":"failed",reason:outcome.reason};
  else {
    let parsed:WorkResult|null=null;
    try{parsed=parseWorkProgress(JSON.parse(outcome.report??""),claimId,policy.revision);}catch{}
    result=parsed??{status:"uncertain",reason:"structured-result-missing",report:outcome.report};
  }
  return {...result,durationSeconds:(Date.now()-start)/1000};
}
