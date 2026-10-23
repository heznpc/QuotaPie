import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PoolError, poolAccounts, readPoolPolicy, type PoolAccount } from "./account-pool";
import { codexProfileRoot, type AppConfig } from "./config";
import { profileReference } from "./work-boundary";
import { createSubscriptionGuard, type SubscriptionGuard } from "./subscription-guard";
import { ExecutionTargetLeaseStore, executionTargetLeasePath, isClosedUnacknowledgedTargetLease, type ExecutionTargetLease } from "./work/execution-target-lease";
import { CodexAppServerClient, type CodexThreadTurnSummary } from "./providers/codex-appserver";
import type { CompactionRequestEvent } from "./codex-compaction";
import { executionPoolPolicyHash } from "./work/execution-target";

export interface ExecutionTargetRouteProof { identity: string; atMs: number }
export interface ExecutionTargetRelayMemory {
  instanceId: string;
  routes: Map<string, ExecutionTargetRouteProof>;
  guards: Map<string, SubscriptionGuard>;
  store?: ExecutionTargetLeaseStore;
  sourceRecoveryTurns?: Set<string>;
}
export const executionTargetRelayMemory = (): ExecutionTargetRelayMemory => ({ instanceId: randomUUID(), routes: new Map(), guards: new Map() });
export interface FrozenTargetSelection { lease: ExecutionTargetLease; account: PoolAccount; guard: SubscriptionGuard }
const failure = (reason: string): never => { throw new PoolError("pool_execution_target_" + reason, 409); };
const lastUserText = (body: any): string | null => {
  const content = Array.isArray(body?.input) ? body.input.filter((item: any) => item?.role === "user").at(-1)?.content : undefined;
  return typeof content === "string" ? content : Array.isArray(content) && content.every((p: any) => p?.type === "input_text" && typeof p.text === "string")
    ? content.map((p: any) => p.text).join("") : null;
};

/** A live listener acknowledges and enforces a collector-owned, expiring target.
 * It never creates consent, changes the selected login, or queues a user turn. */
export function createExecutionTargetRelay(options: {
  sourceAccount?: string; codexHome: string; config: () => AppConfig; sourceGuard: SubscriptionGuard;
  memory: ExecutionTargetRelayMemory; leasePath?: string; now?: () => number;
  correlate?: (lease: ExecutionTargetLease) => Promise<CodexThreadTurnSummary | null>;
  /** Existing listener memory only; never populate from a file or request. */
  inheritedSource?: { identity: string | null; atMs: number | null };
  readLiveSnapshot?: () => Promise<any>;
}) {
  const { memory } = options, now = options.now ?? Date.now;
  memory.sourceRecoveryTurns ??= new Set();
  const profileKey = profileReference(options.codexHome), path = options.leasePath ?? executionTargetLeasePath();
  const store = () => memory.store ??= new ExecutionTargetLeaseStore(path);
  function sourceReady(lease: ExecutionTargetLease) {
    const source = options.sourceGuard.checkIdentity();
    if (!source.ready || source.account !== lease.source.account || source.sourceIdentity !== lease.source.identity ||
        options.sourceAccount !== lease.source.account || profileKey !== lease.source.profileKey || lease.target.sourceIdentity !== source.sourceIdentity)
      failure("source_changed");
    return source;
  }
  function validate(lease: ExecutionTargetLease, model: string | undefined, bound: boolean): PoolAccount {
    const at = now(); sourceReady(lease);
    const source=lease.source;
    if(source.localRecoveryPermitId || source.localRecoveryParentExecutionId || source.sourceQuotaTurnId) {
      if(!source.localRecoveryPermitId || !source.localRecoveryParentExecutionId || !source.sourceQuotaTurnId)failure("local_recovery_unverified");
      let permit;
      try { permit=store().validateLocalRecoveryPermit(source.localRecoveryPermitId!,source.localRecoveryParentExecutionId!,
        lease.policyId,source.sourceQuotaTurnId!,source.failedTurnId); } catch { failure("local_recovery_unverified"); }
      if(permit!.relay.instanceId!==memory.instanceId || permit!.consumedExecutionId!==undefined && permit!.consumedExecutionId!==lease.executionId)
        failure("local_recovery_changed");
    }
    if (model !== lease.model) failure("model_changed");
    if (lease.state === "closed" || lease.expiresAtMs <= at || lease.authorizationValidUntilMs <= at ||
        bound && (lease.state !== "bound" || lease.relayInstanceId !== memory.instanceId)) failure("expired");
    const policy = readPoolPolicy();
    if (!policy.enabled || !policy.accounts.includes(lease.source.account) || !policy.accounts.includes(lease.target.account) ||
        executionPoolPolicyHash(policy) !== lease.target.poolPolicyHash) failure("policy_changed");
    const config = options.config(), profile = config.accounts.codex.find(p => p.enabled && p.id === lease.target.account);
    if (!profile || profileReference(codexProfileRoot(profile)) !== lease.target.profileKey) failure("target_changed");
    const account = poolAccounts(config).find(a => a.id === lease.target.account && a.identity === lease.target.identity);
    if (!account || !model || !account.models.includes(model) || account.tokenExpiresAt <= at + 30000) failure("target_unavailable");
    return account!;
  }
  function guardFor(lease: ExecutionTargetLease, model: string): SubscriptionGuard {
    const key = lease.digest + ":" + model;
    let guard = memory.guards.get(key);
    if (!guard) {
      const profile = options.config().accounts.codex.find(p => p.enabled && p.id === lease.target.account);
      if (!profile) failure("target_changed");
      const minimumReserveByBucket = Object.fromEntries(Object.entries(lease.target.budgetByBucket).map(([bucket, budget]) =>
        [bucket, Math.max(budget.reservePercent, lease.target.baselineByBucket[bucket]!.remainingPercent - budget.maxUsagePercent)]));
      const baselineResetsAtByBucket = Object.fromEntries(Object.entries(lease.target.baselineByBucket).map(([bucket, baseline]) => [bucket, Number(baseline.epoch)]));
      const inner = createSubscriptionGuard({ codexHome: codexProfileRoot(profile!), sourceAccount: lease.target.account, config: options.config,
        executionMode: "managed", quotaObservationMode: "required", requireKnownModelQuotaScope: true,
        minimumReserveByBucket, baselineResetsAtByBucket });
      const check: SubscriptionGuard["check"] = input => {
        try {
          const current = store().get(lease.executionId);
          if (!current || current.digest !== lease.digest) failure("expired");
          validate(current!, input?.model ?? model, current!.state === "bound");
          const state = inner.check(input);
          if (state.sourceIdentity !== lease.target.identity) return { ...state, ready: false, reason: "execution-target-identity-changed" };
          return state;
        } catch { return { ...inner.checkIdentity(), ready: false, reason: "execution-target-unavailable" }; }
      };
      guard = { intervalMs: inner.intervalMs, check, checkIdentity: inner.checkIdentity, observeResponse: inner.observeResponse };
      memory.guards.set(key, guard);
      while (memory.guards.size > 128) memory.guards.delete(memory.guards.keys().next().value!);
    }
    return guard;
  }
  function selection(lease: ExecutionTargetLease, model: string | undefined, bound: boolean): FrozenTargetSelection {
    const actualModel = model ?? lease.model, account = validate(lease, actualModel, bound);
    const guard = guardFor(lease, actualModel!);
    const headers = new Headers({ authorization: `Bearer ${account.accessToken}`, "chatgpt-account-id": account.upstreamAccount });
    const state = guard.check({ headers, model: actualModel });
    if (!state.ready) failure("quota_unavailable");
    return { lease, account, guard };
  }
  return {
    version: 1 as const, instanceId: memory.instanceId,
    recordRoute(event: CompactionRequestEvent) {
      const { threadId, turnId } = event;
      if (!threadId || !turnId || event.phase !== "failed" || event.kind !== "response" ||
          event.accountRouting && event.accountRouting.account !== event.accountRouting.sourceAccount ||
          !(event.status === 429 && event.failureOrigin === "provider_http" ||
            [event.errorCode, event.serverError?.code, event.serverError?.type].some(code =>
              ["usage_limit_exceeded", "usage_limit_reached", "quota_exceeded", "insufficient_quota"].includes(code ?? "")))) return;
      const source = options.sourceGuard.checkIdentity();
      if (!source.ready || !source.sourceIdentity) return;
      const atMs = Date.parse(event.at);
      if (!Number.isFinite(atMs) || atMs > now()) return;
      memory.routes.set(threadId + ":" + turnId, { identity: source.sourceIdentity, atMs });
      while (memory.routes.size > 512) memory.routes.delete(memory.routes.keys().next().value!);
    },
    sourceRecoveryOnly(input: {threadId: string | null; turnId: string | null; body: any}) {
      if (!input.threadId || !input.turnId) return false;
      const key = input.threadId + ":" + input.turnId;
      if (memory.sourceRecoveryTurns!.has(key)) return true;
      const items = Array.isArray(input.body?.input) ? input.body.input : [];
      const lastAssistant = items.findLastIndex((item: any) => item?.role === "assistant");
      const users=items.slice(lastAssistant+1).filter((item:any)=>item?.role==="user");
      // The host can append this envelope after a queued prompt. An actual new
      // user input after an unanswered recovery marker must retain normal routing.
      while(users.length && /^<environment_context>[\s\S]*<\/environment_context>\s*$/.test(lastUserText({input:[users.at(-1)]})??"")) users.pop();
      if (!lastUserText({input:[users.at(-1)]})?.startsWith("[QuotaPie quota recovery:")) return false;
      // Same-account automatic work has no cross-account lease. Preserve the
      // source for this exact turn; a marker cannot grant an ordinary B choice.
      memory.sourceRecoveryTurns!.add(key);
      while (memory.sourceRecoveryTurns!.size > 512) memory.sourceRecoveryTurns!.delete(memory.sourceRecoveryTurns!.values().next().value!);
      return true;
    },
    beginRequest(selection:FrozenTargetSelection,requestId:string,fingerprint:string) {
      try { store().beginTargetRequest(selection.lease.executionId,selection.lease.digest,memory.instanceId,
        {requestId,turnId:selection.lease.turnId!,identity:selection.account.identity,fingerprint},now()); }
      catch { failure("repeat_or_unverified_send"); }
    },
    finishRequest(selection:FrozenTargetSelection,requestId:string,phase:"completed"|"failed"|"cancelled"|"unverified",status:number,errorCode?:string) {
      try { store().finishTargetRequest(selection.lease.executionId,selection.lease.digest,memory.instanceId,requestId,phase,status,now(),errorCode); }
      catch { /* The durable started intent remains closed to any later send. */ }
    },
    assertToolReady(selection:FrozenTargetSelection) {
      const current=store().get(selection.lease.executionId);
      if(current?.targetRequest?.state!=="completed")failure("response_unconfirmed");
    },
    recordResponse(selection: FrozenTargetSelection, requestId: string, status: number) {
      try { store().recordTargetResponse(selection.lease.executionId, selection.lease.digest, memory.instanceId,
        { requestId, turnId: selection.lease.turnId!, identity: selection.account.identity, status, observedAtMs: now() }); }
      catch { /* A recording failure cannot resend an already-dispatched request. */ }
    },
    async acknowledge(input: unknown) {
      const request = input as any;
      if (!request || typeof request.executionId !== "string" || typeof request.digest !== "string" || !existsSync(path)) failure("unavailable");
      const lease = store().get(request.executionId);
      if (!lease || lease.digest !== request.digest) failure("unavailable");
      const sourceQuotaTurnId=lease!.source.sourceQuotaTurnId??lease!.source.failedTurnId;
      // The typed local repair retains the original provider quota failure as
      // route proof. Its latest failed turn remains the separate local terminal.
      const proofKey = lease!.source.threadId + ":" + sourceQuotaTurnId;
      let proof = memory.routes.get(proofKey);
      if (!proof && options.readLiveSnapshot && options.inheritedSource?.identity === lease!.source.identity &&
          Number.isFinite(options.inheritedSource.atMs)) {
        // A handler update shares its listener and source guard. Ask that same
        // process for its in-memory archived events; disk logs grant no route.
        let snapshot: any; try { snapshot = await options.readLiveSnapshot(); } catch { /* No proof, no ACK. */ }
        const old = snapshot?.pid === process.pid && snapshot?.subscriptionGuard?.account === lease!.source.account &&
          snapshot.subscriptionGuard.profileKey === profileKey && snapshot.subscriptionGuard.ready === true &&
          Array.isArray(snapshot.recent) && snapshot.recent.find((event: CompactionRequestEvent) =>
            event.threadId === lease!.source.threadId && event.turnId === sourceQuotaTurnId &&
            Date.parse(event.at) >= options.inheritedSource!.atMs! && event.phase === "failed" &&
            event.kind === "response" && event.status === 429 && event.failureOrigin === "provider_http" &&
            !event.accountRouting && [event.serverError?.code,event.serverError?.type].some(code =>
              ["usage_limit_exceeded","usage_limit_reached","quota_exceeded","insufficient_quota"].includes(code ?? "")));
        if (old) this.recordRoute(old);
        proof = memory.routes.get(proofKey);
      }
      const owner = lease!.source.nativeOwner;
      if (!proof || !owner || !Number.isInteger(owner.pid) || owner.pid <= 0 ||
          !Number.isFinite(owner.startedAtMs) || owner.startedAtMs > proof.atMs ||
          proof.identity !== lease!.source.identity || proof.atMs > now()) failure("native_route_unverified");
      selection(lease!, lease!.model, false);
      const accepted = store().acknowledge(lease!.executionId, lease!.digest, memory.instanceId, profileKey!);
      return { executionId: accepted.executionId, digest: accepted.digest, relayInstanceId: memory.instanceId,
        acknowledgedAtMs: accepted.acknowledgedAtMs, sourceProfileKey: profileKey, targetIdentity: accepted.target.identity };
    },
    async resolve(input: { threadId: string | null; turnId: string | null; body: unknown; model?: string; identityConflict?: boolean }): Promise<FrozenTargetSelection | null> {
      const marker = lastUserText(input.body)?.startsWith("[QuotaPie quota recovery:") === true;
      if (!existsSync(path)) return null;
      const all = store().list().filter(lease => lease.source.profileKey === profileKey && !isClosedUnacknowledgedTargetLease(lease));
      if (input.identityConflict && all.some(lease => lease.state !== "closed" && lease.expiresAtMs > now())) failure("identity_conflict");
      const candidates = all.filter(lease => lease.source.threadId === input.threadId);
      const active = candidates.filter(lease => lease.state !== "closed" && lease.expiresAtMs > now());
      if (!input.threadId || !input.turnId) {
        if (marker || active.length || candidates.some(lease => lease.turnId !== undefined) || !input.threadId && all.some(lease => lease.state === "bound" && lease.expiresAtMs > now())) failure("identity_required");
        return null;
      }
      const userText = (input.body as any)?.input?.filter?.((item: any) => item?.role === "user")?.flatMap((item: any) =>
        typeof item.content === "string" ? [item.content] : Array.isArray(item.content) ? item.content.flatMap((part: any) => typeof part?.text === "string" ? [part.text] : []) : []) ?? [];
      const pending = candidates.filter(lease => !lease.turnId && (lease.state === "acknowledged" && lease.expiresAtMs > now() ||
        userText.some((text: string) => text.startsWith(lease.marker + "\n"))));
      if (pending.length > 1) failure("conflict");
      if (pending.length && !marker) {
        const candidate = pending[0]!;
        sourceReady(candidate);
        let client: CodexAppServerClient | undefined, proof: CodexThreadTurnSummary | null = null;
        try {
          if (options.correlate) proof = await options.correlate(candidate);
          else {
            client = new CodexAppServerClient(options.config().collection.codexCommand, options.sourceAccount, 2000, options.codexHome);
            proof = await client.readTurnForClientMessage(candidate.source.threadId, candidate.clientUserMessageId, candidate.source.failedTurnId);
          }
        } catch { failure("message_unverified"); }
        finally { if (client) await client.close(); }
        if (!proof || proof.threadId !== input.threadId || proof.turnId === candidate.source.failedTurnId ||
            proof.turnId === input.turnId && proof.status !== "inProgress") failure("message_unverified");
        store().bindCorrelatedTurn(candidate.executionId, candidate.digest, memory.instanceId,
          { threadId: input.threadId, turnId: proof!.turnId, clientUserMessageId: candidate.clientUserMessageId }, now());
      }
      let lease: ExecutionTargetLease | null;
      try { lease = store().bindRequest({ sourceProfileKey: profileKey!, threadId: input.threadId, turnId: input.turnId, body: input.body, relayInstanceId: memory.instanceId }); }
      catch { failure("unavailable"); }
      return lease! ? selection(lease!, input.model, true) : null;
    },
  };
}
export type ExecutionTargetRelay = ReturnType<typeof createExecutionTargetRelay>;
