import { realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readCodexForkParent } from "./account-pool-lineage";
import { AccountPool, poolAccounts, readPoolPolicy } from "./account-pool";
import { createExecutionTargetRelay, executionTargetRelayMemory, type ExecutionTargetRelayMemory } from "./execution-target-relay";
import { createSourceHistoryGuard } from "./source-history-guard";
import { manualTargets, createManualAccountRouting, manualRoutingMemory, type ManualRoutingMemory } from "./manual-account-routing";
import { interactiveRelayPolicy } from "./interactive-relay-policy";
import { codexProfileRoot, dataDirectory, loadConfig } from "./config";
import { createRelayDiagnostics, rotatingRelayLog, type RelayDiagnostics } from "./relay-diagnostics";
import { type TaskSavingsPolicy, type TaskState } from "./task-savings";
import { createSavingsModelSupport } from "./savings-model-support";
import { createCompactionHandler, type CompactionRoute } from "./codex-compaction";
import { createSubscriptionGuard, subscriptionGuardMemory, type SubscriptionGuardMemory } from "./subscription-guard";

export const relayRuntimeApiVersion = 1;
export interface RuntimeSettings {
  port: number; token: string; route: CompactionRoute;
  codex_home?: string; taskSavings?: TaskSavingsPolicy;
}
export interface RuntimeMemory {
  guard?: SubscriptionGuardMemory;
  savings?: Map<string, TaskState>;
  sourceAccount?: string | null;
  accountPool?: AccountPool;
  interactivePool?: AccountPool;
  poolGuards?: Map<string, ReturnType<typeof createSubscriptionGuard>>;
  executionTarget?: ExecutionTargetRelayMemory;
  manualRouting?: ManualRoutingMemory;
  executionTargetDisposeAttached?: boolean;
  dispose?: () => void;
  diagnostics?: RelayDiagnostics;
}
export interface RelayRuntime {
  fetch(request: Request): Promise<Response>;
  readonly activeRequests: number;
  close(): void;
  snapshot?(): Record<string, unknown>;
}
export type RuntimeFactory = (settings: RuntimeSettings, memory: RuntimeMemory) => RelayRuntime;

/** A runtime owns its resources, while account identity and task decisions span updates. */
export const createRelayRuntime: RuntimeFactory = (settings, memory) => {
  const resolved = interactiveRelayPolicy(settings.route, settings.taskSavings);
  settings.route = resolved.route;
  settings.taskSavings = resolved.taskSavings;
  const home = settings.codex_home ?? join(homedir(), ".codex");
  const config = () => loadConfig();
  const sourceAccount = config().accounts.codex.find(profile => {
    try { return profile.enabled && realpathSync(codexProfileRoot(profile)) === realpathSync(home); } catch { return false; }
  })?.id;
  if (memory.sourceAccount !== undefined && memory.sourceAccount !== (sourceAccount ?? null))
    throw new Error("runtime_account_changed");
  memory.sourceAccount = sourceAccount ?? null;
  const inheritedSource = memory.guard ? { identity: memory.guard.boundIdentity, atMs: memory.guard.boundAuthAtMs } : undefined;
  memory.guard ??= subscriptionGuardMemory();
  memory.savings ??= new Map();
  // Old listener bootstraps can reload this handler without knowing the new
  // diagnostic contract. Their fallback log is also bounded and per-listener.
  memory.diagnostics ??= createRelayDiagnostics(rotatingRelayLog(join(dataDirectory(), "relay-logs", `${settings.port}.jsonl`)));
  // Pool enrollment is explicit and resolved per request. Historical handler
  // connections remain untouched while their in-flight requests finish.
  // Keep behavior local to this module generation. A version number can be
  // forgotten; constructor identity changes whenever the bundle is reloaded.
  // An older in-flight runtime must also retain its own pool after replacement.
  let interactivePool = memory.interactivePool instanceof AccountPool &&
    memory.interactivePool.runtimeApiVersion === AccountPool.RUNTIME_API_VERSION ? memory.interactivePool : undefined;
  const resolveAccountPool = () => {
    const policy = readPoolPolicy();
    if (!sourceAccount || !policy.accounts.includes(sourceAccount) ||
        !policy.enabled && !policy.newConversationTarget && !manualTargets().some(choice => choice.sourceAccount === sourceAccount)) return undefined;
    if (!interactivePool || interactivePool.runtimeApiVersion !== AccountPool.RUNTIME_API_VERSION) {
      // New requests use the current routing implementation after a hot reload.
      // Older handles stay in the disposal chain while their streams/telemetry
      // finish; closing them here would interrupt already admitted requests.
      interactivePool = memory.interactivePool = new AccountPool({ sourceAccount, accounts: () => poolAccounts(config()), policy: readPoolPolicy,
        forkParentAsync: thread => readCodexForkParent(home, thread) });
      const pool = memory.interactivePool, previousDispose = memory.dispose;
      memory.dispose = () => { pool.close(); previousDispose?.(); };
    }
    return interactivePool;
  };
  // Functions belong to this runtime; retained guard instances keep old code on reload.
  const poolGuards = memory.poolGuards = new Map<string, ReturnType<typeof createSubscriptionGuard>>();
  const poolSubscriptionGuard = (account: string, identity: string, manual = false) => {
    const profile = config().accounts.codex.find(p => p.enabled && p.id === account);
    if (!profile) throw new Error("pool-target-unavailable");
    const key = account + ":" + identity + (manual ? ":manual" : "");
    let guard = poolGuards.get(key);
    if (!guard) {
      guard = createSubscriptionGuard({ codexHome: codexProfileRoot(profile), sourceAccount: account, config,
        quotaObservationMode: "required", executionMode: "managed", requireKnownModelQuotaScope: true,
        interactiveCreditPolicy: true, ignorePoolReserve: manual });
      poolGuards.set(key, guard);
    }
    return guard;
  };
  const sourceGuard = createSubscriptionGuard({ codexHome: home, sourceAccount, config, memory: memory.guard,
    quotaObservationMode: "advisory", executionMode: "interactive", interactiveCreditPolicy: true });
  memory.executionTarget ??= executionTargetRelayMemory();
  const executionTargetRelay = createExecutionTargetRelay({ sourceAccount, codexHome: home, config, sourceGuard, memory: memory.executionTarget, inheritedSource,
    readLiveSnapshot: async () => {
      const response = await fetch(`http://127.0.0.1:${settings.port}/${settings.token}/backend-api/codex/quotapie-health`,
        { redirect: "error", signal: AbortSignal.timeout(1000) });
      if (!response.ok || Number(response.headers.get("content-length")) > 512 * 1024) throw new Error("live-history-unavailable");
      const bytes = await response.text();
      if (bytes.length > 512 * 1024) throw new Error("live-history-unavailable");
      return JSON.parse(bytes);
    } });
  if (!memory.executionTargetDisposeAttached) {
    const previousDispose = memory.dispose;
    memory.dispose = () => {
      memory.executionTarget?.store?.close();
      memory.executionTarget?.retiredStores?.forEach(store => store.close());
      previousDispose?.();
    };
    memory.executionTargetDisposeAttached = true;
  }
  const handler = createCompactionHandler({ ...settings, savingsState: memory.savings,
      executionMode: "interactive", resolveAccountPool, poolSubscriptionGuard, executionTargetRelay,
      manualAccountRouting: sourceAccount ? createManualAccountRouting({ sourceAccount, config,
        memory: memory.manualRouting ??= manualRoutingMemory() }) : undefined,
      sourceHistoryGuard: createSourceHistoryGuard({ denyUnavailableDatabase: true, forkParent: thread => readCodexForkParent(home, thread) }),
      sourceHistoryPolicy: "authenticated-source",
      subscriptionGuard: sourceGuard,
      savingsModelSupported: createSavingsModelSupport(join(home, "models_cache.json")),
      onNativeRequest: memory.diagnostics.onNativeRequest,
      onProvenance: memory.diagnostics.onProvenance,
      onRequest: event => { executionTargetRelay.recordRoute(event); memory.diagnostics!.onRequest(event); },
  });
  return { fetch: handler.fetch, snapshot: () => ({ ...handler.snapshot(), relayLogging: memory.diagnostics!.status(),
    accountPoolRuntimeVersion: memory.interactivePool?.runtimeApiVersion ?? null }),
    get activeRequests() { return handler.activeRequests; }, close: () => {} };
};
