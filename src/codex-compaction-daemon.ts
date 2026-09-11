import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { startCompactionProxy, type CompactionRoute } from "./codex-compaction";

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
      console.log(JSON.stringify({ at: new Date().toISOString(), phase: "response_headers", ...event }));
    }
  },
});
// Disable can turn the live relay into a pass-through without cutting off an
// already-loaded desktop task. Endpoint changes still require a restart.
watchFile(settingsPath, { interval: 500 }, () => {
  try {
    const next = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof settings;
    if (next.port !== settings.port || next.token !== settings.token) return;
    if (![next.route.from, next.route.to].every(model => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model))) return;
    Object.assign(settings.route, next.route);
  } catch { console.error("Relay settings reload failed; retaining current route"); }
});
const stop = () => { unwatchFile(settingsPath); proxy.stop(); process.exit(0); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
