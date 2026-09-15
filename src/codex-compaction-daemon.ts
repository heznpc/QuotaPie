import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_TASK_SAVINGS, validateTaskSavings, type TaskSavingsPolicy } from "./task-savings";
import { startCompactionProxy, validateCompactionRoute, type CompactionRoute } from "./codex-compaction";

if (process.argv[2] === "--check-policy") {
  const candidate = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
  console.log(JSON.stringify(validateCompactionRoute(candidate.route)));
  process.exit(0);
}

const settingsPath = process.argv[2];
if (!settingsPath) throw new Error("Relay settings path required");
const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
  port: number;
  token: string;
  route: CompactionRoute;
  codex_home?: string;
  taskSavings?: TaskSavingsPolicy;
};
if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) {
  throw new Error("Invalid relay port");
}
settings.taskSavings = validateTaskSavings(settings.taskSavings ?? DEFAULT_TASK_SAVINGS);
const supportsSavings = () => {
  try {
    const catalog = JSON.parse(readFileSync(join(settings.codex_home ?? homedir() + "/.codex", "models_cache.json"), "utf8"));
    return catalog.models?.some((m: any) => m.slug === "gpt-5.6-luna" && m.supported_reasoning_levels?.some((r: any) => r.effort === "low")) === true;
  } catch { return false; }
};
const proxy = startCompactionProxy({
  ...settings,
  savingsModelSupported: supportsSavings,
  onRequest: (event) => {
    if (event.kind === "compaction" || event.kind === "response") {
      console.log(JSON.stringify(event));
    }
  },
});
// Disable can turn the live relay into a pass-through without cutting off an
// already-loaded desktop task. Endpoint changes still require a restart.
watchFile(settingsPath, { interval: 500 }, () => {
  try {
    const next = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof settings;
    if (next.port !== settings.port || next.token !== settings.token) return;
    const policy = validateCompactionRoute(next.route);
    const savings = validateTaskSavings(next.taskSavings ?? DEFAULT_TASK_SAVINGS);
    Object.assign(settings.route, policy);
    Object.assign(settings.taskSavings!, savings);
  } catch { console.error("Relay settings reload failed; retaining current route"); }
});
const stop = () => { unwatchFile(settingsPath); proxy.stop(); process.exit(0); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
