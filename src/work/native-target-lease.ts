import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexProfileRoot, type AppConfig } from "../config";
import { codexSessionLocation } from "../session-location";
import { hostQueueClientMessageId, type HostQueueReceipt, type HostQueueTargetLease } from "../quota-resume/host-queue";
import { ExecutionTargetLeaseStore, type ExecutionTargetLease } from "./execution-target-lease";
import { executionTargetDigest } from "./execution-target";
import { profileReference } from "../work-boundary";
import type { WorkExecutionTarget, WorkPolicy, WorkResult } from "./types";

/** A host terminal is not proof that the selected account finished its request.
 * Reconcile only the exact queued turn and durable relay send/response pair. */
export function reconcileNativeTargetResult(result: WorkResult, input: {
  executionId: string; policy: WorkPolicy; target: WorkExecutionTarget;
  receipt?: HostQueueReceipt; lease: ExecutionTargetLease | null;
}): WorkResult {
  const { executionId, policy, target, receipt, lease } = input;
  const classified = (status: WorkResult["status"], reason: string): WorkResult => ({ status, reason,
    ...(result.durationSeconds === undefined ? {} : { durationSeconds: result.durationSeconds }) });
  const unknownResponse = () => result.status === "turn-finished"
    ? classified("uncertain", "execution-target-response-unverified") : result;
  const consent=lease?.source.consent??lease?.source;
  const owner=target.sessionOwner;
  if (!lease || !receipt || lease.executionId !== executionId || lease.policyId !== policy.id ||
      lease.policyRevision !== policy.revision || consent?.account !== policy.account ||
      consent.profileKey !== policy.profileKey || consent.accountKey !== policy.accountKey ||
      !!lease.source.consent!==!!owner || owner && (lease.source.account!==owner.account || lease.source.profileKey!==owner.profileKey ||
        lease.source.accountKey!==owner.accountKey || lease.source.consent?.identity!==target.consentIdentity ||
        lease.source.consent?.manifestSHA256!==owner.manifestSHA256) ||
      lease.source.identity !== target.sourceIdentity || lease.source.threadId !== policy.nativeSessionId ||
      lease.source.failedTurnId !== policy.quotaResume?.turnId || lease.source.evidenceStamp !== policy.quotaResume?.stamp ||
      executionTargetDigest(lease.target) !== executionTargetDigest(target) ||
      receipt.threadId !== lease.source.threadId || receipt.clientUserMessageId !== lease.clientUserMessageId ||
      receipt.clientUserMessageId !== hostQueueClientMessageId(executionId) ||
      !lease.turnId || lease.turnId !== receipt.turnId || lease.turnId === lease.source.failedTurnId)
    return unknownResponse();
  const request = lease.targetRequest, response = lease.upstreamResponse;
  // No send intent means a pre-send failure retains its original explanation.
  if (!request) return unknownResponse();
  const matchingResponse = response?.requestId === request.requestId && response.turnId === lease.turnId &&
    response.identity === target.identity && response.status === request.status;
  if (request.state === "completed") {
    return matchingResponse && request.status! >= 200 && request.status! < 300
      ? result : unknownResponse();
  }
  if (request.state === "failed" && matchingResponse && request.status! >= 400) {
    return request.status === 429
      ? classified("quota-blocked", "execution-target-provider-quota-blocked")
      : classified("failed", "execution-target-provider-rejected");
  }
  return classified("uncertain", "execution-target-completion-unconfirmed");
}

function boundedJSON(path: string): any {
  if (statSync(path).size > 262144) throw new Error("execution-target-relay-unavailable");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function configuredNativeTargetEndpoint(source: string): string | null {
  // Root settings may precede the managed block. Parse TOML so a nested table
  // or quoted copy of that block cannot masquerade as the active endpoint.
  try {
    const config = Bun.TOML.parse(source) as Record<string, unknown>;
    return typeof config.openai_base_url === "string" ? config.openai_base_url : null;
  } catch { return null; }
}

export function nativeTargetRelayEndpoint(config: AppConfig, policy: WorkPolicy): string {
  const location=codexSessionLocation(config,policy.account,policy.nativeSessionId);
  const profile = config.accounts.codex.find(p => p.id === location?.ownerAccount);
  if (!profile) throw new Error("execution-target-relay-unavailable");
  const root = realpathSync(codexProfileRoot(profile));
  const manifest = boundedJSON(join(homedir(), ".local/lib/quotapie-compaction/current.json"));
  const settings = boundedJSON(manifest.profile_settings?.[root] ?? manifest.settings_path);
  if (realpathSync(settings.codex_home) !== root || !Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535 ||
      !/^[a-f0-9]{48}$/.test(settings.token)) throw new Error("execution-target-relay-unavailable");
  const endpoint = `http://127.0.0.1:${settings.port}/${settings.token}/backend-api/codex`;
  const source = readFileSync(join(root, "config.toml"), "utf8");
  if (configuredNativeTargetEndpoint(source) !== endpoint) throw new Error("execution-target-native-route-unverified");
  return endpoint;
}

export async function inspectNativeTargetOwner(config: AppConfig, policy: WorkPolicy): Promise<{pid:number;startedAtMs:number}> {
  const location=codexSessionLocation(config,policy.account,policy.nativeSessionId);
  const profile = config.accounts.codex.find(p => p.id === location?.ownerAccount);
  if (!profile || process.platform !== "darwin") throw new Error("execution-target-native-route-unverified");
  const helper = fileURLToPath(new URL("../../script/codex-host-wake.py", import.meta.url));
  const child = Bun.spawn(["/usr/bin/python3", "-B", helper, "--inspect-owner"], { stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: {PATH:"/usr/bin:/bin:/usr/sbin:/sbin",LANG:"en_US.UTF-8"}, timeout: 5000 });
  child.stdin.write(JSON.stringify({account:profile.id,codexHome:realpathSync(codexProfileRoot(profile)),threadId:policy.nativeSessionId}) + "\n");
  child.stdin.end();
  let output = "";
  for await (const bytes of child.stdout) {
    output += new TextDecoder().decode(bytes);
    if (output.length > 4096) { child.kill(); throw new Error("execution-target-native-route-unverified"); }
  }
  let value: any; try { value = JSON.parse(output); } catch {}
  if (await child.exited !== 0 || value?.status !== "ready" || !Number.isInteger(value.pid) || value.pid <= 0 ||
      !Number.isFinite(value.startedAtMs) || value.startedAtMs > Date.now()) throw new Error("execution-target-native-route-unverified");
  return {pid:value.pid,startedAtMs:value.startedAtMs};
}

/** The stored ACK is not sufficient: this adapter asks the live listener and
 * verifies the exact digest, identity and generation before the only enqueue. */
export function nativeTargetLease(config: AppConfig, policy: WorkPolicy, executionId: string, target: WorkExecutionTarget,
  authorized: () => boolean, options: {store?:ExecutionTargetLeaseStore;endpoint?:()=>string;owner?:()=>Promise<{pid:number;startedAtMs:number}>;
    sessionLocation?:typeof codexSessionLocation;
    fetch?:typeof fetch;now?:()=>number;renewalIntervalMs?:number} = {}): HostQueueTargetLease {
  const store = options.store ?? new ExecutionTargetLeaseStore(), now = options.now ?? Date.now;
  const endpoint = options.endpoint ?? (() => nativeTargetRelayEndpoint(config,policy));
  let lease: ExecutionTargetLease | undefined, acknowledgedEndpoint: string | undefined;
  let verifiedOwner: {pid:number;startedAtMs:number} | undefined, ownerCheckedAtMs = 0;
  let closed=false,revoked=false,timer:ReturnType<typeof setInterval>|undefined,renewal:Promise<void>|null=null;
  const readOwner = options.owner ?? (() => inspectNativeTargetOwner(config,policy));
  const ownerBindingCurrent=()=>{
    if(!target.sessionOwner)return true;
    try {
      const location=(options.sessionLocation??codexSessionLocation)(config,policy.account,policy.nativeSessionId),owner=target.sessionOwner;
      return !!location?.consolidated && location.ownerAccount===owner.account && location.manifestSHA256===owner.manifestSHA256 &&
        profileReference(location.sessionRoot)===owner.profileKey;
    }catch{return false;}
  };
  const current = () => {
    if (closed || revoked || !lease || !acknowledgedEndpoint || !authorized() || !ownerBindingCurrent()) return false;
    try {
      const fresh = store.get(executionId);
      return endpoint() === acknowledgedEndpoint && !!fresh && fresh.digest === lease.digest &&
        fresh.relayInstanceId === lease.relayInstanceId && ["acknowledged","bound"].includes(fresh.state) &&
        fresh.authorizationValidUntilMs > now() && fresh.expiresAtMs > now();
    } catch { return false; }
  };
  const renew=():Promise<void> => {
    if(renewal)return renewal;
    renewal=(async()=>{
      if (!current() || !lease) throw new Error("execution-target-authorization-changed");
      if (now() - ownerCheckedAtMs >= 5000) {
        const owner = await readOwner();
        if (!verifiedOwner || owner.pid !== verifiedOwner.pid || owner.startedAtMs !== verifiedOwner.startedAtMs)
          throw new Error("execution-target-native-owner-changed");
        ownerCheckedAtMs = now();
      }
      if (!current()) throw new Error("execution-target-authorization-changed");
      store.renew(executionId,lease.digest,now());
    })().finally(()=>{renewal=null});
    return renewal;
  };
  return {
    async acknowledge() {
      if(current()){await renew();return;}
      if(closed || revoked)throw new Error("execution-target-authorization-changed");
      if (!authorized() || !ownerBindingCurrent()) throw new Error("execution-target-authorization-changed");
      const owner = await readOwner();
      if (!authorized()) throw new Error("execution-target-authorization-changed");
      lease = store.request(policy,executionId,hostQueueClientMessageId(executionId),target,now(),owner);
      lease = store.renew(executionId,lease.digest,now());
      const url = endpoint(), startedAt = now();
      const response = await (options.fetch ?? fetch)(url + "/quotapie-execution-target/ack", {method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({executionId,digest:lease.digest}),redirect:"error",signal:AbortSignal.timeout(5000)});
      const value: any = await response.json().catch(()=>null);
      if (!response.ok) {
        const reason = value?.error?.code ?? value?.reason;
        throw new Error(typeof reason === "string" && /^execution-target-[a-z-]{1,80}$/.test(reason) ? reason : "execution-target-relay-unavailable");
      }
      const recorded = store.get(executionId);
      if (!authorized() || endpoint() !== url || value?.executionId !== executionId || value.digest !== lease.digest ||
          typeof value.relayInstanceId !== "string" || !value.relayInstanceId || value.sourceProfileKey !== lease.source.profileKey || value.targetIdentity !== target.identity ||
          !Number.isFinite(value.acknowledgedAtMs) || value.acknowledgedAtMs < startedAt || value.acknowledgedAtMs > now() || now()-value.acknowledgedAtMs > 5000 ||
          !recorded || recorded.digest !== lease.digest || recorded.relayInstanceId !== value.relayInstanceId || recorded.acknowledgedAtMs !== value.acknowledgedAtMs)
        throw new Error("execution-target-relay-ack-unverified");
      const stillOwner = await readOwner();
      if (stillOwner.pid !== owner.pid || stillOwner.startedAtMs !== owner.startedAtMs) throw new Error("execution-target-native-owner-changed");
      verifiedOwner = owner; ownerCheckedAtMs = now();
      lease = recorded; acknowledgedEndpoint = url;
      if (!current()) throw new Error("execution-target-relay-ack-unverified");
      timer ??= setInterval(()=>{void renew().catch(()=>{
        revoked=true;
        try{if(lease&&!closed)store.closeLease(executionId,lease.digest,"execution-target-authorization-changed")}catch{}
      })},options.renewalIntervalMs??5000);
      timer.unref?.();
    },
    current,
    renew,
    close(reason) {
      if(closed)return;closed=true;
      if(timer)clearInterval(timer);
      try { if (lease) store.closeLease(executionId,lease.digest,reason); }
      finally { if (!options.store) store.close(); }
    },
  };
}
