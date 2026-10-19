import type { PoolAccount, PoolPolicy } from "../account-pool";
import type { WindowAnalysis } from "../types";
import { evaluateWorkAdmission, workObservation, workWindows } from "./admission";
import { executionPoolPolicyHash, executionQuotaPolicy, validExecutionTarget } from "./execution-target";
import type { WorkExecutionTarget, WorkPolicy } from "./types";

export interface ExecutionTargetAccounts {
  pool: PoolPolicy; accounts: PoolAccount[]; windows: WindowAnalysis[];
  binding(account: string): { profileKey: string; accountKey: string } | null;
  sessionOwner?(policy: WorkPolicy): {account:string;profileKey:string;accountKey:string;identity:string;manifestSHA256?:string}|null;
  nowMs: number; maxAgeMs: number;
}

/** Only an explicitly enrolled pool may supply an alternate allowance. Source
 * session, consent, goal and failed-turn evidence are never moved to B. */
export function selectQuotaExecutionTarget(source: WorkPolicy, input: ExecutionTargetAccounts): WorkExecutionTarget | null {
  return selectTarget(source,input);
}
/** A proven unsent attempt may select a fresh enrolled allowance. The source
 * session and pool consent stay bound; the new target freezes at dispatch. */
export function selectLocalRepairExecutionTarget(source:WorkPolicy, prior:WorkExecutionTarget,input:ExecutionTargetAccounts):WorkExecutionTarget|null{
  if(!source.quotaResume?.localBeforeSendRecovery)return null;
  const target=selectTarget(source,input,true);
  return target&&target.sourceIdentity===prior.sourceIdentity&&target.poolPolicyHash===prior.poolPolicyHash?target:null;
}
function selectTarget(source:WorkPolicy,input:ExecutionTargetAccounts,localRepair=false):WorkExecutionTarget|null{
  if (source.provider !== "codex" || source.purpose !== "quota-resume" || !source.quotaResume || !source.model ||
      !source.enabled || source.state.activeExecutionId || source.state.turns || source.state.status !== "waiting" ||
      !input.pool.enabled || !input.pool.accounts.includes(source.account)) return null;
  const owner=input.sessionOwner?.(source);
  if(input.sessionOwner && !owner)return null;
  const consolidated=!!owner&&owner.account!==source.account;
  if(consolidated && !/^[a-f0-9]{64}$/.test(owner.manifestSHA256??""))return null;
  const sourceWindows = workWindows(source, input.windows);
  // Missing/stale source evidence alone never authorizes a different identity.
  if (!localRepair && !consolidated && !sourceWindows.some(w => w.quality === "authoritative" && w.freshness === "fresh" &&
      w.observedAtMs <= input.nowMs && input.nowMs - w.observedAtMs <= input.maxAgeMs &&
      (w.remainingPercent === 0 || w.metadata?.ordinaryUsageAllowed === false || w.metadata?.spendControlReached === true))) return null;
  const origin = input.accounts.find(a => a.id === (owner?.account??source.account)), consent=input.accounts.find(a=>a.id===source.account), sourceBinding = input.binding(source.account);
  if (!origin || !consent || !sourceBinding || sourceBinding.profileKey !== source.profileKey || sourceBinding.accountKey !== source.accountKey ||
      owner&&(origin.identity!==owner.identity || !input.pool.accounts.includes(owner.account))) return null;
  for (const account of input.accounts.filter(a => (localRepair || consolidated || a.id !== source.account) && input.pool.accounts.includes(a.id))
    .sort((a,b) => (b.remaining ?? -1) - (a.remaining ?? -1))) {
    const binding = input.binding(account.id);
    if (!binding || account.id !== (owner?.account??source.account) && account.identity === origin.identity || account.tokenExpiresAt <= input.nowMs + 30_000 ||
        !account.models.includes(source.model) || account.validUntil <= input.nowMs || account.remaining === null || account.remaining <= 0) continue;
    const quotaScope = { ...source, account: account.id, budgetByBucket: {} };
    const windows = workWindows(quotaScope, input.windows);
    const budgetByBucket = Object.fromEntries(windows.map(window => [window.bucket, {
      reservePercent: Math.max(window.reservePercent, input.pool.reservePercent?.[account.id] ?? 0, source.budgetByBucket[window.bucket]?.reservePercent ?? 0),
      maxUsagePercent: source.budgetByBucket[window.bucket]?.maxUsagePercent ?? 100,
    }]));
    const observation = workObservation({ ...quotaScope, budgetByBucket }, input.windows, input.nowMs);
    if (!observation || Object.keys(observation.buckets).length !== windows.length) continue;
    const target: WorkExecutionTarget = { account: account.id, ...binding, identity: account.identity, sourceIdentity: origin.identity,
      ...(consolidated?{sessionOwner:{...owner!,manifestSHA256:owner!.manifestSHA256!},consentIdentity:consent.identity}:{}),
      poolPolicyHash: executionPoolPolicyHash(input.pool), selectedAtMs: input.nowMs,
      expiresAtMs: input.nowMs + Math.min(source.maxDurationSeconds, source.maxTotalDurationSeconds - source.state.totalDurationSeconds, 3600) * 1000,
      budgetByBucket, baselineByBucket: Object.fromEntries(Object.entries(observation.buckets).map(([bucket,value]) => [bucket, {
        observationId: value.id!, atMs: value.atMs!, remainingPercent: value.remainingPercent, epoch: value.epoch,
      }])) };
    if (!validExecutionTarget(source, target, input.nowMs)) continue;
    if (evaluateWorkAdmission(executionQuotaPolicy(source, target), input.windows, input.nowMs, {maxAgeMs:input.maxAgeMs}).ready) return target;
  }
  return null;
}

export function validateQuotaExecutionTarget(source: WorkPolicy, target: WorkExecutionTarget, input: ExecutionTargetAccounts): string | null {
  if (!validExecutionTarget(source, target, input.nowMs)) return "execution-target-expired";
  if (!input.pool.enabled || !input.pool.accounts.includes(source.account) || !input.pool.accounts.includes(target.account) ||
      executionPoolPolicyHash(input.pool) !== target.poolPolicyHash) return "execution-target-policy-changed";
  const owner=input.sessionOwner?.(source), frozenOwner=target.sessionOwner;
  if(input.sessionOwner && !owner || frozenOwner && (!owner || ["account","profileKey","accountKey","identity","manifestSHA256"].some(key=>(frozenOwner as any)[key] !== (owner as any)[key])) ||
      !frozenOwner && owner && owner.account!==source.account)return "execution-target-session-owner-changed";
  const origin = input.accounts.find(a => a.id === (owner?.account??source.account)), account = input.accounts.find(a => a.id === target.account);
  const binding = input.binding(target.account), sourceBinding = input.binding(source.account);
  if (!origin || origin.identity !== target.sourceIdentity || frozenOwner && input.accounts.find(a=>a.id===source.account)?.identity!==target.consentIdentity ||
      !sourceBinding || sourceBinding.profileKey !== source.profileKey || sourceBinding.accountKey !== source.accountKey ||
      !account || account.identity !== target.identity || !binding || binding.profileKey !== target.profileKey || binding.accountKey !== target.accountKey)
    return "execution-target-identity-changed";
  if (!source.model || !account.models.includes(source.model) || account.tokenExpiresAt <= input.nowMs + 30_000)
    return "execution-target-unavailable";
  const windows = workWindows(executionQuotaPolicy(source, target), input.windows);
  if (windows.some(w => String(w.resetsAtMs) !== target.baselineByBucket[w.bucket]?.epoch)) return "execution-target-quota-period-changed";
  return null;
}
