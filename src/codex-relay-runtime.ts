import { realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readCodexForkParent } from "./account-pool-lineage";
import { AccountPool, poolAccounts, readPoolPolicy } from "./account-pool";
import { codexProfileRoot, loadConfig } from "./config";
import { DEFAULT_TASK_SAVINGS, validateTaskSavings, type TaskSavingsPolicy, type TaskState } from "./task-savings";
import { createSavingsModelSupport } from "./savings-model-support";
import { createCompactionHandler, validateCompactionRoute, type CompactionRoute } from "./codex-compaction";
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
  dispose?: () => void;
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
  validateCompactionRoute(settings.route);
  const savings = validateTaskSavings(settings.taskSavings ?? DEFAULT_TASK_SAVINGS);
  settings.taskSavings ??= savings;
  const home = settings.codex_home ?? join(homedir(), ".codex");
  const config = () => loadConfig();
  const sourceAccount = config().accounts.codex.find(profile => {
    try { return profile.enabled && realpathSync(codexProfileRoot(profile)) === realpathSync(home); } catch { return false; }
  })?.id;
  if (memory.sourceAccount !== undefined && memory.sourceAccount !== (sourceAccount ?? null))
    throw new Error("runtime_account_changed");
  memory.sourceAccount = sourceAccount ?? null;
  memory.guard ??= subscriptionGuardMemory();
  memory.savings ??= new Map();
  // Reopening the same SQLite pool during a stream can block the event loop on
  // another process's write lock. Its connection and bindings outlive handlers.
  if (sourceAccount && !memory.accountPool) {
    memory.accountPool = new AccountPool({ sourceAccount, accounts: () => poolAccounts(config()),
      policy: readPoolPolicy, forkParent: thread => readCodexForkParent(home, thread) });
    memory.dispose = () => memory.accountPool?.close();
  }
  const accountPool = memory.accountPool;
  const handler = createCompactionHandler({ ...settings, accountPool, savingsState: memory.savings,
      subscriptionGuard: createSubscriptionGuard({ codexHome: home, sourceAccount, config, memory: memory.guard, quotaObservationMode: "advisory" }),
      savingsModelSupported: createSavingsModelSupport(join(home, "models_cache.json")),
      onProvenance: event => console.log(JSON.stringify({ kind: "response_provenance", ...event })),
      onRequest: event => { if (event.kind === "compaction" || event.kind === "response") console.log(JSON.stringify(event)); },
  });
  return { fetch: handler.fetch, snapshot: handler.snapshot, get activeRequests() { return handler.activeRequests; }, close: () => {} };
};
