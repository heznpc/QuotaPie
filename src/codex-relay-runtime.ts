import { realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readCodexForkParent } from "./account-pool-lineage";
import type { AccountPool } from "./account-pool";
import { createSourceHistoryGuard } from "./source-history-guard";
import { interactiveRelayPolicy } from "./interactive-relay-policy";
import { codexProfileRoot, loadConfig } from "./config";
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
  memory.guard ??= subscriptionGuardMemory();
  memory.savings ??= new Map();
  // Historical pool connections belong to retiring handlers. New interactive
  // requests never initialize a routing DB or repeat source authentication there.
  const handler = createCompactionHandler({ ...settings, savingsState: memory.savings,
      executionMode: "interactive",
      sourceHistoryGuard: createSourceHistoryGuard({ forkParent: thread => readCodexForkParent(home, thread) }),
      sourceHistoryPolicy: "authenticated-source",
      subscriptionGuard: createSubscriptionGuard({ codexHome: home, sourceAccount, config, memory: memory.guard, quotaObservationMode: "advisory", executionMode: "interactive" }),
      savingsModelSupported: createSavingsModelSupport(join(home, "models_cache.json")),
      onNativeRequest: event => console.log(JSON.stringify(event)),
      onProvenance: event => console.log(JSON.stringify({ kind: "response_provenance", ...event })),
      onRequest: event => { if (event.kind === "compaction" || event.kind === "response") console.log(JSON.stringify(event)); },
  });
  return { fetch: handler.fetch, snapshot: handler.snapshot, get activeRequests() { return handler.activeRequests; }, close: () => {} };
};
