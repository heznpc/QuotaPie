import { DEFAULT_COMPACTION_ROUTE, validateCompactionRoute } from "./codex-compaction-policy";
import { DEFAULT_TASK_SAVINGS, validateTaskSavings } from "./task-savings";

/** Optional optimizers do not own admission. Missing settings opt out; invalid
 * or newly unsupported optimization settings fall back to the native request. */
export function interactiveRelayPolicy(route?: unknown, savings?: unknown) {
  const unchanged = { from: DEFAULT_COMPACTION_ROUTE.from, to: DEFAULT_COMPACTION_ROUTE.from, effort: "low" as const };
  const disabled = { ...DEFAULT_TASK_SAVINGS, enabled: false };
  let compaction = unchanged;
  let taskSavings = validateTaskSavings(disabled);
  const unavailable: string[] = [];
  if (route != null) try { compaction = validateCompactionRoute(route) as typeof unchanged; }
  catch { unavailable.push("compaction-policy-unavailable"); }
  if (savings != null) try { taskSavings = validateTaskSavings(savings); }
  catch { unavailable.push("savings-policy-unavailable"); }
  return { route: compaction, taskSavings, unavailable };
}
