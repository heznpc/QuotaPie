import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { inspectRelaySettings } from "../src/relay-settings";
import { relayHealth } from "../src/compaction-policy-settings";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

// A current collector does not prove that already-running Codex clients use
// current relay code. Inspect every reachable registered generation separately.
const relayRoot = join(homedir(), ".local/lib/quotapie-compaction");
if (existsSync(join(relayRoot, "current.json"))) {
  const stage = mkdtempSync(join(tmpdir(), "quotapie-runtime-check-"));
  try {
    const root = resolve(import.meta.dir, "..");
    const bundle = join(stage, "relay-runtime.js");
    const build = Bun.spawnSync([process.execPath, "build", join(root, "src/codex-relay-runtime.ts"), "--target=bun", "--outfile", bundle],
      { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error("Relay verification build failed");
    const expected = createHash("sha256").update(readFileSync(bundle)).digest("hex");
    const generations = await inspectRelaySettings(relayRoot, async ({ settings, required }) => {
      try {
        const health = await relayHealth(settings, fetch);
        return { required, reachable: true, runningMatches: health.runtimeSourceHash === expected,
          imageRoutes: health.nativeImageRoutesVersion === 1, taskPhases: health.taskSavingsPhasesVersion === 1,
          retiringRuntimes: Number(health.retiringRuntimes) || 0 };
      } catch { return { required, reachable: false, runningMatches: false, imageRoutes: false, taskPhases: false, retiringRuntimes: 0 }; }
    });
    const passed = generations.length > 0 && generations.every(g => (!g.required && !g.reachable) ||
      g.reachable && g.runningMatches && g.imageRoutes && g.taskPhases);
    console.log(JSON.stringify({ component: "relays", result: passed ? "pass" : "fail", expectedRuntimeHash: expected,
      generations: generations.map((g, index) => ({ generation: index + 1, ...g })) }));
    if (!passed) process.exitCode = 1;
  } catch {
    console.error("Relay runtime verification failed; no running clients were restarted.");
    process.exitCode = 1;
  } finally { rmSync(stage, { recursive: true, force: true }); }
} else console.log(JSON.stringify({component: "relays", result: "not-installed"}));
