import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { DEFAULT_TASK_SAVINGS, validateTaskSavings } from "./task-savings";
import { validateCompactionRoute } from "./codex-compaction";
import { createRelayRuntime, type RuntimeSettings } from "./codex-relay-runtime";
import { startRelayRuntimeHost } from "./relay-runtime-host";
import { interactiveRelayPolicy } from "./interactive-relay-policy";

if (process.argv[2] === "--check-policy") {
  const candidate = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
  console.log(JSON.stringify(validateCompactionRoute(candidate.route)));
  validateTaskSavings(candidate.taskSavings ?? DEFAULT_TASK_SAVINGS);
  process.exit(0);
}
const settingsPath = process.argv[2];
if (!settingsPath) throw new Error("Relay settings path required");
const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as RuntimeSettings;
if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw new Error("Invalid relay port");
Object.assign(settings, interactiveRelayPolicy(settings.route, settings.taskSavings));
const host = await startRelayRuntimeHost({ settingsPath, settings, initialFactory: createRelayRuntime });
watchFile(settingsPath, { interval: 500 }, () => {
  try {
    const next = JSON.parse(readFileSync(settingsPath, "utf8")) as RuntimeSettings;
    if (next.port !== settings.port || next.token !== settings.token || next.codex_home !== settings.codex_home) return;
    const resolved = interactiveRelayPolicy(next.route, next.taskSavings);
    Object.assign(settings.route, resolved.route);
    Object.assign(settings.taskSavings!, resolved.taskSavings);
  } catch { console.error("Relay settings reload failed; retaining current policy"); }
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true; unwatchFile(settingsPath);
  await host.stop(); process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
