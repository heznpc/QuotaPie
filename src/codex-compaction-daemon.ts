import { readFileSync, unwatchFile, watchFile } from "node:fs";
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
};
if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) {
  throw new Error("Invalid relay port");
}
const proxy = startCompactionProxy({
  ...settings,
  onRequest: (event) => {
    if (event.routed || event.status >= 400) {
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
    Object.assign(settings.route, policy);
  } catch { console.error("Relay settings reload failed; retaining current route"); }
});
const stop = () => { unwatchFile(settingsPath); proxy.stop(); process.exit(0); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
