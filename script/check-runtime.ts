import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { runtimeSourceHash } from "../src/runtime-identity";

try {
  const config = loadConfig();
  const host = config.dashboard.host.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Nonlocal service");
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${config.dashboard.port}`;
  const expected = runtimeSourceHash();
  let installed: string | null = null;
  try { installed = runtimeSourceHash(join(homedir(), ".local/lib/quotapie")); } catch { /* missing/incomplete installation */ }
  const response = await fetch(origin + "/api/runtime", { signal: AbortSignal.timeout(5_000), redirect: "error" });
  if (!response.ok) throw new Error("Runtime identity unavailable");
  const runtime = await response.json() as { schemaVersion?: number; sourceHash?: string; pid?: number; startedAt?: string };
  const passed = runtime.schemaVersion === 1 && installed === expected && runtime.sourceHash === expected
    && Number.isInteger(runtime.pid) && Number(runtime.pid) > 0 && Number.isFinite(Date.parse(runtime.startedAt ?? ""));
  console.log(JSON.stringify({ component: "service", result: passed ? "pass" : "fail", installedMatches: installed === expected,
    runningMatches: runtime.sourceHash === expected, pid: runtime.pid, sourceHash: expected }));
  if (!passed) process.exitCode = 1;
} catch {
  console.error("Service runtime verification failed: installation or running identity is unavailable. Restarting or copying files was not attempted.");
  process.exitCode = 1;
}
