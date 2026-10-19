import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDirectory } from "../config";
import { executionTargetDigest, validExecutionTarget } from "./execution-target";
import type { WorkExecutionTarget, WorkPolicy } from "./types";

export const executionTargetLeasePath = () => join(dataDirectory(), "execution-target-leases.sqlite3");
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const MAX_LOCAL_RECOVERY_REPAIRS = 2;
export type LocalRecoveryErrorCode = "subscription_pool_execution_target_conflict" | "subscription_pool_execution_target_unavailable";
export type LocalRecoveryRelayReason = "pool_execution_target_conflict" | "pool_execution_target_unavailable";
export interface LocalRecoveryPermitInput {
  parentExecutionId: string; childPolicyId: string; sourceQuotaTurnId: string; goalFingerprint: string;
  host: {threadId:string;turnId:string;clientUserMessageId:string;status:"failed";
    errorType:"quotapie_subscription_guard";errorCode:LocalRecoveryErrorCode;completedAtMs:number};
  relay: {instanceId:string;requestId:string;status:400;origin:"relay";reason:LocalRecoveryRelayReason;observedAtMs:number};
}
export interface LocalRecoveryPermit extends LocalRecoveryPermitInput {
  id: string; rootPolicyId: string; failedTurnId: string; createdAtMs: number; consumedExecutionId?: string;
}
export interface ExecutionTargetLease {
  version: 1; executionId: string; policyId: string; policyRevision: number;
  source: { account: string; profileKey: string; accountKey: string; identity: string;
    threadId: string; failedTurnId: string; evidenceStamp: string; nativeOwner?: {pid:number;startedAtMs:number};
    sourceQuotaTurnId?: string; localRecoveryPermitId?: string; localRecoveryParentExecutionId?: string };
  target: WorkExecutionTarget; model?: string; marker: string; promptHash: string; clientUserMessageId: string;
  digest: string; createdAtMs: number; expiresAtMs: number; authorizationValidUntilMs: number;
  state: "requested" | "acknowledged" | "bound" | "closed";
  relayInstanceId?: string; acknowledgedAtMs?: number; turnId?: string; closedReason?: string;
  upstreamResponse?: {requestId:string;turnId:string;identity:string;status:number;observedAtMs:number};
  targetRequest?: {requestId:string;fingerprint:string;state:"started"|"completed"|"failed"|"unverified";startedAtMs:number;finishedAtMs?:number;status?:number;errorCode?:string};
  targetRequestFingerprints?: string[];
  localRecoveryPermit?: LocalRecoveryPermit;
}

/** No live relay ever acknowledged this closed attempt, so the collector could
 * not enqueue it. Keep its audit row without treating its marker as a turn. */
export function isClosedUnacknowledgedTargetLease(lease: ExecutionTargetLease): boolean {
  return lease.state === "closed" && lease.acknowledgedAtMs === undefined && lease.relayInstanceId === undefined &&
    lease.turnId === undefined && lease.targetRequest === undefined && lease.upstreamResponse === undefined &&
    !(lease.targetRequestFingerprints?.length);
}

export function readExecutionTargetLease(id: string, path = executionTargetLeasePath()): ExecutionTargetLease | null {
  let db: Database | undefined;
  try {
    db = new Database(path, {readonly:true});
    const row=db.query<{value:string},[string]>("SELECT value FROM execution_target_leases WHERE id=?").get(id);
    return row ? JSON.parse(row.value) : null;
  } catch { return null; } finally {db?.close();}
}

/** A lease does not enqueue work. The collector must obtain a live relay ACK
 * for this exact digest, then enqueue once through its existing durable receipt.
 * The 15s renewable authorization fence stops execution after collector loss. */
export class ExecutionTargetLeaseStore {
  static readonly RUNTIME_API_VERSION = 5;
  readonly runtimeApiVersion = ExecutionTargetLeaseStore.RUNTIME_API_VERSION;
  private db: Database;
  constructor(path = executionTargetLeasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS execution_target_leases (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  close() { this.db.close(); }
  get(id: string): ExecutionTargetLease | null {
    const row = this.db.query<{value: string}, [string]>("SELECT value FROM execution_target_leases WHERE id=?").get(id);
    return row ? JSON.parse(row.value) : null;
  }
  list(): ExecutionTargetLease[] {
    return this.db.query<{value: string}, []>("SELECT value FROM execution_target_leases").all().map(row => JSON.parse(row.value));
  }
  private write(lease: ExecutionTargetLease) {
    this.db.query("INSERT INTO execution_target_leases(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
      .run(lease.executionId, JSON.stringify(lease));
  }
  /** Count only a continuous chain of consumed, unsent attempts. Every prior
   * permit remains immutable and must point to the exact next execution. */
  private localRecoveryLineage(parent:ExecutionTargetLease):{root:ExecutionTargetLease;depth:number;goalFingerprint?:string} {
    let current=parent,depth=0;
    const seen=new Set([current.executionId]),roots:string[]=[];let goalFingerprint:string|undefined;
    while(current.source.localRecoveryPermitId || current.source.localRecoveryParentExecutionId || current.source.sourceQuotaTurnId){
      const source=current.source,previous=source.localRecoveryParentExecutionId?this.get(source.localRecoveryParentExecutionId):null;
      const permit=previous?.localRecoveryPermit;
      if(++depth>MAX_LOCAL_RECOVERY_REPAIRS || !previous || !permit || seen.has(previous.executionId) ||
          previous.state!=="closed" || previous.turnId!==source.failedTurnId || previous.targetRequest || previous.upstreamResponse || previous.targetRequestFingerprints?.length ||
          permit.id!==source.localRecoveryPermitId || permit.parentExecutionId!==previous.executionId || permit.childPolicyId!==current.policyId ||
          permit.failedTurnId!==source.failedTurnId || permit.sourceQuotaTurnId!==source.sourceQuotaTurnId || permit.consumedExecutionId!==current.executionId ||
          !/^[a-f0-9]{64}$/.test(permit.goalFingerprint) || goalFingerprint!==undefined&&goalFingerprint!==permit.goalFingerprint ||
          ["account","profileKey","accountKey","identity","threadId"].some(key=>(source as any)[key] !== (previous.source as any)[key]) ||
          ["sourceIdentity","poolPolicyHash"].some(key=>(current.target as any)[key] !== (previous.target as any)[key]) ||
          current.model!==previous.model || source.nativeOwner?.pid!==previous.source.nativeOwner?.pid ||
          source.nativeOwner?.startedAtMs!==previous.source.nativeOwner?.startedAtMs)
        throw new Error("execution-target-local-recovery-unverified");
      goalFingerprint=permit.goalFingerprint;roots.push(permit.rootPolicyId);seen.add(previous.executionId);current=previous;
    }
    if(roots.some(id=>id!==current.policyId) || depth>0&&parent.source.sourceQuotaTurnId!==current.source.failedTurnId)
      throw new Error("execution-target-local-recovery-unverified");
    return {root:current,depth,goalFingerprint};
  }
  /** The caller must first verify the official queued-message terminal, its
   * structured rollout error and this exact live listener's local rejection.
   * This allowlist is a before-fetch resolver error, never a provider failure. */
  createLocalRecoveryPermit(input: LocalRecoveryPermitInput, nowMs = Date.now()): LocalRecoveryPermit {
    return this.db.transaction(() => {
      const parent=this.get(input.parentExecutionId),host=input.host,relay=input.relay;
      if(!parent || parent.state!=="closed" ||
          (parent.source.sourceQuotaTurnId??parent.source.failedTurnId)!==input.sourceQuotaTurnId || !UUID.test(input.sourceQuotaTurnId) ||
          !input.childPolicyId || input.childPolicyId===parent.policyId || !/^[a-f0-9]{64}$/.test(input.goalFingerprint) ||
          host.status!=="failed" || host.errorType!=="quotapie_subscription_guard" ||
          !["subscription_pool_execution_target_conflict","subscription_pool_execution_target_unavailable"].includes(host.errorCode) ||
          host.threadId!==parent.source.threadId || host.clientUserMessageId!==parent.clientUserMessageId ||
          !UUID.test(host.turnId) || host.turnId===parent.source.failedTurnId || parent.turnId!==undefined && parent.turnId!==host.turnId ||
          relay.status!==400 || relay.origin!=="relay" || host.errorCode!==`subscription_${relay.reason}` ||
          !UUID.test(relay.requestId) || relay.instanceId!==parent.relayInstanceId || parent.acknowledgedAtMs===undefined ||
          !Number.isFinite(host.completedAtMs) || !Number.isFinite(relay.observedAtMs) ||
          relay.observedAtMs<parent.acknowledgedAtMs || relay.observedAtMs>parent.expiresAtMs || relay.observedAtMs>nowMs ||
          host.completedAtMs<relay.observedAtMs || host.completedAtMs>nowMs || host.completedAtMs-relay.observedAtMs>5000 ||
          parent.targetRequest!==undefined || parent.upstreamResponse!==undefined || (parent.targetRequestFingerprints?.length??0)>0)
        throw new Error("execution-target-local-recovery-unverified");
      const lineage=this.localRecoveryLineage(parent);
      if(lineage.depth>=MAX_LOCAL_RECOVERY_REPAIRS)throw new Error("execution-target-local-recovery-consumed");
      if(lineage.goalFingerprint!==undefined&&lineage.goalFingerprint!==input.goalFingerprint)
        throw new Error("execution-target-local-recovery-unverified");
      const id=digest(JSON.stringify([parent.executionId,input.childPolicyId,input.sourceQuotaTurnId,input.goalFingerprint,host,relay]));
      if(parent.localRecoveryPermit) {
        if(parent.localRecoveryPermit.id!==id)throw new Error("execution-target-local-recovery-conflict");
        return structuredClone(parent.localRecoveryPermit);
      }
      const permits=this.list().filter(lease=>lease.localRecoveryPermit);
      if(permits.some(lease=>lease.policyId===parent.policyId) ||
          permits.filter(lease=>lease.localRecoveryPermit!.rootPolicyId===lineage.root.policyId).length>=MAX_LOCAL_RECOVERY_REPAIRS)
        throw new Error("execution-target-local-recovery-consumed");
      const permit:LocalRecoveryPermit={...structuredClone(input),id,rootPolicyId:lineage.root.policyId,failedTurnId:host.turnId,createdAtMs:nowMs};
      parent.turnId=host.turnId;parent.localRecoveryPermit=permit;this.write(parent);
      return structuredClone(permit);
    }).immediate();
  }
  validateLocalRecoveryPermit(permitId:string,parentExecutionId:string,childPolicyId:string,sourceQuotaTurnId:string,failedTurnId:string):LocalRecoveryPermit {
    const parent=this.get(parentExecutionId),permit=parent?.localRecoveryPermit;
    if(!parent || !permit || parent.state!=="closed" ||
        permit.id!==permitId || permit.parentExecutionId!==parentExecutionId || permit.childPolicyId!==childPolicyId || !/^[a-f0-9]{64}$/.test(permit.goalFingerprint) ||
        permit.sourceQuotaTurnId!==sourceQuotaTurnId || permit.failedTurnId!==failedTurnId || parent.turnId!==failedTurnId ||
        (parent.source.sourceQuotaTurnId??parent.source.failedTurnId)!==sourceQuotaTurnId || parent.targetRequest!==undefined || parent.upstreamResponse!==undefined ||
        (parent.targetRequestFingerprints?.length??0)>0)
      throw new Error("execution-target-local-recovery-unverified");
    const lineage=this.localRecoveryLineage(parent);
    if(lineage.depth>=MAX_LOCAL_RECOVERY_REPAIRS || permit.rootPolicyId!==lineage.root.policyId ||
        lineage.goalFingerprint!==undefined&&lineage.goalFingerprint!==permit.goalFingerprint ||
        this.list().filter(lease=>lease.localRecoveryPermit?.rootPolicyId===permit.rootPolicyId).length>MAX_LOCAL_RECOVERY_REPAIRS)
      throw new Error("execution-target-local-recovery-unverified");
    return structuredClone(permit);
  }
  private localRecoveryParent(lease:ExecutionTargetLease):ExecutionTargetLease|null {
    const source=lease.source;
    if(!source.localRecoveryPermitId && !source.localRecoveryParentExecutionId && !source.sourceQuotaTurnId)return null;
    if(!source.localRecoveryPermitId || !source.localRecoveryParentExecutionId || !source.sourceQuotaTurnId)
      throw new Error("execution-target-local-recovery-unverified");
    const permit=this.validateLocalRecoveryPermit(source.localRecoveryPermitId,source.localRecoveryParentExecutionId,
      lease.policyId,source.sourceQuotaTurnId,source.failedTurnId);
    const parent=this.get(source.localRecoveryParentExecutionId)!;
    if(permit.consumedExecutionId!==undefined && permit.consumedExecutionId!==lease.executionId ||
        ["account","profileKey","accountKey","identity","threadId"].some(key=>(source as any)[key] !== (parent.source as any)[key]) ||
        ["sourceIdentity","poolPolicyHash"].some(key=>(lease.target as any)[key] !== (parent.target as any)[key]) ||
        lease.model!==parent.model || source.nativeOwner?.pid!==parent.source.nativeOwner?.pid ||
        source.nativeOwner?.startedAtMs!==parent.source.nativeOwner?.startedAtMs)
      throw new Error("execution-target-local-recovery-changed");
    return parent;
  }
  request(policy: WorkPolicy, executionId: string, clientUserMessageId: string, target: WorkExecutionTarget, nowMs = Date.now(), nativeOwner?: {pid:number;startedAtMs:number}): ExecutionTargetLease {
    if (!UUID.test(executionId) || !UUID.test(clientUserMessageId) || !UUID.test(policy.nativeSessionId) ||
        !policy.quotaResume || !UUID.test(policy.quotaResume.turnId) || !validExecutionTarget(policy, target, nowMs) ||
        !policy.prompt.startsWith(`[QuotaPie quota recovery:${policy.id}]\n`)) throw new Error("execution-target-lease-invalid");
    const recovery=policy.quotaResume.localBeforeSendRecovery;
    const source:ExecutionTargetLease["source"] = { account: policy.account, profileKey: policy.profileKey, accountKey: policy.accountKey,
      identity: target.sourceIdentity, threadId: policy.nativeSessionId, failedTurnId: policy.quotaResume.turnId, evidenceStamp: policy.quotaResume.stamp,
      ...(nativeOwner ? {nativeOwner} : {}),...(recovery?{sourceQuotaTurnId:recovery.sourceQuotaTurnId,
        localRecoveryPermitId:recovery.permitId,localRecoveryParentExecutionId:recovery.parentExecutionId}:{}) };
    const marker = `[QuotaPie quota recovery:${policy.id}]`, promptHash = digest(policy.prompt);
    const leaseDigest = digest(JSON.stringify([executionId, policy.id, policy.revision, source, executionTargetDigest(target), policy.model, marker, promptHash, clientUserMessageId]));
    return this.db.transaction(() => {
      const existing = this.get(executionId);
      if (existing) {
        if (existing.digest !== leaseDigest || existing.state === "closed") throw new Error("execution-target-lease-conflict");
        return existing;
      }
      if (this.list().some(lease => lease.state !== "closed" && lease.expiresAtMs > nowMs &&
          (lease.source.threadId === source.threadId || lease.target.accountKey === target.accountKey ||
           lease.source.accountKey === target.accountKey || lease.target.accountKey === source.accountKey)))
        throw new Error("execution-target-lease-busy");
      const lease: ExecutionTargetLease = { version: 1, executionId, policyId: policy.id, policyRevision: policy.revision,
        source, target: structuredClone(target), model: policy.model, marker, promptHash, clientUserMessageId, digest: leaseDigest,
        createdAtMs: nowMs, expiresAtMs: target.expiresAtMs, authorizationValidUntilMs: Math.min(target.expiresAtMs, nowMs + 15_000), state: "requested" };
      this.localRecoveryParent(lease);
      this.write(lease); return lease;
    }).immediate();
  }
  /** Caller must freshly check source consent, identity, target quota and work budget. */
  renew(executionId: string, expectedDigest: string, nowMs = Date.now()): ExecutionTargetLease {
    return this.db.transaction(() => {
      const lease = this.get(executionId);
      if (!lease || lease.digest !== expectedDigest || lease.state === "closed" || lease.expiresAtMs <= nowMs)
        throw new Error("execution-target-lease-unavailable");
      lease.authorizationValidUntilMs = Math.min(lease.expiresAtMs, nowMs + 15_000);
      this.write(lease); return lease;
    }).immediate();
  }
  /** Called only by the live source listener after checking identity and fixed target routing. */
  acknowledge(executionId: string, expectedDigest: string, relayInstanceId: string, sourceProfileKey: string, nowMs = Date.now()): ExecutionTargetLease {
    return this.db.transaction(() => {
      const lease = this.get(executionId);
      if (!lease || lease.digest !== expectedDigest || lease.source.profileKey !== sourceProfileKey || !relayInstanceId ||
          lease.state === "closed" || lease.authorizationValidUntilMs <= nowMs || lease.expiresAtMs <= nowMs ||
          lease.state === "bound" && lease.relayInstanceId !== relayInstanceId)
        throw new Error("execution-target-lease-unavailable");
      const parent=this.localRecoveryParent(lease);
      if(parent) {
        if(parent.localRecoveryPermit!.relay.instanceId!==relayInstanceId)throw new Error("execution-target-local-recovery-generation-changed");
        parent.localRecoveryPermit!.consumedExecutionId=executionId;this.write(parent);
      }
      lease.relayInstanceId = relayInstanceId; lease.acknowledgedAtMs = nowMs;
      if (lease.state === "requested") lease.state = "acknowledged";
      this.write(lease); return lease;
    }).immediate();
  }
  /** Only an official source-host client message receipt may authorize a native
   * envelope whose last user record is host context instead of the prompt. */
  bindCorrelatedTurn(executionId: string, expectedDigest: string, relayInstanceId: string,
    proof: {threadId:string;turnId:string;clientUserMessageId:string}, nowMs = Date.now()): ExecutionTargetLease {
    return this.db.transaction(() => {
      const lease = this.get(executionId);
      if (!lease || lease.digest !== expectedDigest || isClosedUnacknowledgedTargetLease(lease) ||
          lease.state !== "closed" && lease.expiresAtMs > nowMs && lease.authorizationValidUntilMs > nowMs && lease.relayInstanceId !== relayInstanceId ||
          !["acknowledged","bound","closed"].includes(lease.state) ||
          proof.threadId !== lease.source.threadId || proof.clientUserMessageId !== lease.clientUserMessageId || !UUID.test(proof.turnId) ||
          proof.turnId === lease.source.failedTurnId || lease.turnId !== undefined && lease.turnId !== proof.turnId)
        throw new Error("execution-target-turn-unverified");
      lease.turnId = proof.turnId;
      if (lease.state !== "closed") {
        lease.state = lease.expiresAtMs <= nowMs || lease.authorizationValidUntilMs <= nowMs ? "closed" : "bound";
        if (lease.state === "closed") lease.closedReason = "execution-target-authorization-expired";
      }
      this.write(lease); return lease;
    }).immediate();
  }
  /** Bind only the exact authorized new user message. Later requests in that
   * same native turn retain B, even if A recovers or B becomes unavailable. */
  bindRequest(input: {sourceProfileKey: string; threadId: string; turnId: string; body: unknown; relayInstanceId: string}, nowMs = Date.now()): ExecutionTargetLease | null {
    return this.db.transaction(() => {
      const candidates = this.list().filter(lease => lease.source.profileKey === input.sourceProfileKey && lease.source.threadId === input.threadId &&
        !isClosedUnacknowledgedTargetLease(lease));
      if (!UUID.test(input.turnId) && candidates.some(lease => lease.turnId !== undefined))
        throw new Error("execution-target-turn-unverified");
      const users = (input.body && typeof input.body === "object" && Array.isArray((input.body as any).input)
        ? (input.body as any).input : []).filter((item: any) => item?.role === "user");
      const last = users.at(-1)?.content;
      const text = typeof last === "string" ? last : Array.isArray(last) && last.every((part: any) => part?.type === "input_text" && typeof part.text === "string")
        ? last.map((part: any) => part.text).join("") : null;
      const marker = typeof text === "string" && text.startsWith("[QuotaPie quota recovery:") ? text.split("\n")[0] : null;
      const allUserText = users.flatMap((item: any) => typeof item.content === "string" ? [item.content]
        : Array.isArray(item.content) ? item.content.filter((part: any) => part?.type === "input_text" && typeof part.text === "string").map((part: any) => part.text) : []);
      // A host-added context message after the recovery input is not a license
      // to send via ordinary routing. Until message/turn correlation verifies
      // this envelope, retain the execution fence and fail closed.
      if (candidates.some(lease => lease.state !== "closed" && lease.turnId === undefined && marker !== lease.marker &&
          allUserText.some((text: string) => text.startsWith(lease.marker + "\n"))))
        throw new Error("execution-target-message-order-unverified");
      // An exact turn was bound by this prompt or an official client-message
      // receipt. Historical markers inside pre-turn compact input cannot select
      // a different (often closed) lease over that verified current turn.
      const bound = candidates.filter(lease => lease.turnId === input.turnId);
      const matches = bound.length ? bound : candidates.filter(lease => marker === lease.marker);
      if (!matches.length) {
        // An unknown recovery marker must never fall into ordinary pool routing.
        if (marker && candidates.some(lease=>lease.state!=="closed" && lease.expiresAtMs>nowMs)) throw new Error("execution-target-lease-unavailable");
        return null;
      }
      if (matches.length !== 1) throw new Error("execution-target-lease-conflict");
      const lease = matches[0]!;
      if (!UUID.test(input.turnId) || input.turnId === lease.source.failedTurnId || lease.state === "closed" ||
          lease.state === "requested" || lease.relayInstanceId !== input.relayInstanceId ||
          lease.expiresAtMs <= nowMs || lease.authorizationValidUntilMs <= nowMs ||
          lease.turnId !== undefined && lease.turnId !== input.turnId)
        throw new Error("execution-target-lease-unavailable");
      if (!lease.turnId) {
        if (text === null || digest(text) !== lease.promptHash) throw new Error("execution-target-message-mismatch");
        lease.turnId = input.turnId; lease.state = "bound"; this.write(lease);
      }
      return lease;
    }).immediate();
  }
  closeLease(executionId: string, expectedDigest: string, reason: string) {
    this.db.transaction(() => {
      const lease = this.get(executionId);
      if (!lease || lease.digest !== expectedDigest) return;
      lease.state = "closed"; lease.closedReason = reason; this.write(lease);
    }).immediate();
  }
  /** Durable send intent: a crash, failed stream or ambiguous connection can
   * never be retried by the native host under this same execution lease. */
  beginTargetRequest(executionId:string, expectedDigest:string, relayInstanceId:string,
    request:{requestId:string;turnId:string;identity:string;fingerprint:string}, nowMs=Date.now()):void {
    this.db.transaction(()=>{
      const lease=this.get(executionId);
      if(!lease || lease.digest!==expectedDigest || lease.relayInstanceId!==relayInstanceId || lease.state!=="bound" ||
          lease.turnId!==request.turnId || lease.target.identity!==request.identity || !request.requestId ||
          !/^[a-f0-9]{64}$/.test(request.fingerprint) || lease.expiresAtMs<=nowMs || lease.authorizationValidUntilMs<=nowMs)
        throw new Error("execution-target-send-unavailable");
      if(lease.targetRequest && lease.targetRequest.state!=="completed" || lease.targetRequestFingerprints?.includes(request.fingerprint))
        throw new Error("execution-target-repeat-blocked");
      lease.targetRequest={requestId:request.requestId,fingerprint:request.fingerprint,state:"started",startedAtMs:nowMs};
      lease.targetRequestFingerprints=[...(lease.targetRequestFingerprints??[]),request.fingerprint];
      this.write(lease);
    }).immediate();
  }
  finishTargetRequest(executionId:string, expectedDigest:string, relayInstanceId:string, requestId:string,
    phase:"completed"|"failed"|"cancelled"|"unverified",status:number,nowMs=Date.now(),errorCode?:string):void {
    this.db.transaction(()=>{
      const lease=this.get(executionId);
      if(!lease || lease.digest!==expectedDigest || lease.relayInstanceId!==relayInstanceId ||
          lease.targetRequest?.requestId!==requestId || lease.targetRequest.state!=="started")return;
      const completed=phase==="completed"&&status>=200&&status<300;
      lease.targetRequest.state=completed?"completed":phase==="failed"?"failed":"unverified";
      lease.targetRequest.finishedAtMs=nowMs;lease.targetRequest.status=status;
      if(errorCode)lease.targetRequest.errorCode=errorCode;
      if(!completed){lease.state="closed";lease.closedReason="execution-target-upstream-"+(phase==="cancelled"?"unverified":phase);}
      this.write(lease);
    }).immediate();
  }
  /** Provider response evidence, never a routing decision or a pre-fetch intent. */
  recordTargetResponse(executionId: string, expectedDigest: string, relayInstanceId: string,
    response: {requestId:string;turnId:string;identity:string;status:number;observedAtMs:number}): void {
    this.db.transaction(() => {
      const lease=this.get(executionId);
      if (!lease || lease.digest!==expectedDigest || lease.relayInstanceId!==relayInstanceId || lease.turnId!==response.turnId ||
          lease.target.identity!==response.identity || !response.requestId || !Number.isInteger(response.status) || response.status<200 || response.status>599 ||
          !Number.isFinite(response.observedAtMs) || response.observedAtMs<lease.createdAtMs || response.observedAtMs>lease.expiresAtMs)
        throw new Error("execution-target-response-unverified");
      lease.upstreamResponse=structuredClone(response);this.write(lease);
    }).immediate();
  }
}
