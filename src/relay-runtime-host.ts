import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RelayRuntime, RuntimeFactory, RuntimeMemory, RuntimeSettings } from "./codex-relay-runtime";

interface Descriptor { schemaVersion: 1; sourceHash: string; candidatePath: string }
interface Instance { runtime: RelayRuntime; pending: number }

/** The listener never changes. Each admitted request keeps its runtime until its stream finishes. */
export async function startRelayRuntimeHost(options: {
  settingsPath: string; settings: RuntimeSettings; initialFactory: RuntimeFactory;
}) {
  const directory = await realpath(dirname(options.settingsPath));
  const { settings } = options;
  if (!/^[a-f0-9]{48}$/.test(settings.token)) throw new Error("invalid_runtime_token");
  const prefix = `/${settings.token}/backend-api/codex`;
  const memory: RuntimeMemory = {};
  let sourceHash = "embedded", draining = false;
  let current: Instance;
  const retired = new Set<Instance>();
  let updating: Promise<void> | undefined;
  const descriptorPath = join(directory, "runtime-current.json");
  async function load(path: string): Promise<{ descriptor: Descriptor; factory: RuntimeFactory }> {
    if ((await stat(path)).size > 4096) throw new Error("invalid_runtime_descriptor");
    const descriptor = JSON.parse(await readFile(path, "utf8")) as Descriptor;
    if (descriptor.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(descriptor.sourceHash))
      throw new Error("invalid_runtime_descriptor");
    const expected = join(directory, `relay-runtime-${descriptor.sourceHash}.js`);
    if (typeof descriptor.candidatePath !== "string" || resolve(descriptor.candidatePath) !== expected ||
        await realpath(expected) !== expected) throw new Error("invalid_runtime_path");
    const details = await stat(expected);
    if (!details.isFile() || details.size > 32 * 1024 * 1024 || (details.mode & 0o022) !== 0 ||
        details.uid !== process.getuid!()) throw new Error("invalid_runtime_file");
    const bytes = await readFile(expected);
    if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sourceHash)
      throw new Error("runtime_hash_mismatch");
    const module = await import(pathToFileURL(expected).href);
    if (module.relayRuntimeApiVersion !== 1 || typeof module.createRelayRuntime !== "function")
      throw new Error("runtime_api_mismatch");
    return { descriptor, factory: module.createRelayRuntime };
  }
  async function publish(descriptor: Descriptor) {
    const temporary = descriptorPath + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(descriptor) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, descriptorPath);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  function instance(factory: RuntimeFactory): Instance {
    const runtime = factory(settings, memory);
    if (typeof runtime.fetch !== "function" || typeof runtime.close !== "function" ||
        !Number.isInteger(runtime.activeRequests) || runtime.activeRequests !== 0) {
      runtime.close?.(); throw new Error("invalid_runtime_factory");
    }
    return { runtime, pending: 0 };
  }
  const counters = ["requests", "rejectedRequests", "compactions", "attemptedCompactions", "failedCompactions", "cancelledCompactions", "unverifiedCompactions"];
  const archived: Record<string, any> = { recent: [], subscriptionGuard: {} };
  const recentEvents = (snapshots: Array<Record<string, any>>) => {
    const unique = new Map<string, any>();
    for (const snapshot of snapshots) for (const event of snapshot.recent ?? []) unique.set(event.requestId, event);
    return [...unique.values()].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-32);
  };
  function combine(snapshots: Array<Record<string, any>>) {
    const result: Record<string, any> = { recent: recentEvents(snapshots), active: snapshots.flatMap(s => s.active ?? []), subscriptionGuard: {} };
    for (const key of counters) result[key] = snapshots.reduce((n, s) => n + (Number(s[key]) || 0), 0);
    for (const key of ["blockedRequests", "abortedRequests"]) result.subscriptionGuard[key] = snapshots.reduce((n, s) => n + (Number(s.subscriptionGuard?.[key]) || 0), 0);
    for (const key of ["blockedByReason", "abortedByReason"]) {
      const counts: Record<string, number> = {};
      for (const s of snapshots) for (const [reason, count] of Object.entries(s.subscriptionGuard?.[key] ?? {}))
        counts[reason] = (counts[reason] ?? 0) + (Number(count) || 0);
      result.subscriptionGuard[key] = counts;
    }
    return result;
  }
  const collect = () => {
    for (const item of retired) if (item.pending === 0 && item.runtime.activeRequests === 0) {
      Object.assign(archived, combine([archived, item.runtime.snapshot?.() ?? {}]));
      retired.delete(item); item.runtime.close();
    }
  };
  try {
    const loaded = await load(descriptorPath);
    current = instance(loaded.factory); sourceHash = loaded.descriptor.sourceHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A descriptor that exists but points at a missing module must not silently downgrade.
    if (await stat(descriptorPath).then(() => true, () => false)) throw error;
    current = instance(options.initialFactory);
  }
  const activeCount = () => current.runtime.activeRequests + [...retired].reduce((n, item) => n + item.runtime.activeRequests, 0);
  async function reload() {
    if (draining) throw new Error("runtime_draining");
    collect();
    if (retired.size >= 8) throw new Error("runtime_updates_pending");
    const loaded = await load(join(directory, "runtime-candidate.json"));
    if (loaded.descriptor.sourceHash === sourceHash) return;
    const candidate = instance(loaded.factory);
    try {
      const probe = new Request(`http://127.0.0.1${prefix}/quotapie-health`);
      const response = await candidate.runtime.fetch(probe);
      const health = await response.json() as Record<string, unknown>;
      if (!response.ok || health.service !== "quotapie-compaction" ||
          JSON.stringify(health.route) !== JSON.stringify(settings.route)) throw new Error("runtime_health_mismatch");
      await publish(loaded.descriptor);
    }
    catch (error) { candidate.runtime.close(); throw error; }
    // No await between publishing the selected instance and admission to it.
    const previous = current; current = candidate; sourceHash = loaded.descriptor.sourceHash;
    retired.add(previous); collect();
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: settings.port, idleTimeout: 0,
    maxRequestBodySize: Infinity,
    async fetch(request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      if (!pathname.startsWith(`${prefix}/`) || request.headers.has("origin")) return new Response("Not found", { status: 404 });
      if (pathname === `${prefix}/quotapie-reload` && request.method === "POST") {
        try {
          if (!updating) updating = reload().finally(() => { updating = undefined; });
          await updating;
          return Response.json({ reloaded: true, relayRuntimeRevision: 1, listenerPolicyVersion: 2, reloadSupported: true, runtimeSourceHash: sourceHash, runtimeReloadScope: "request-handler",
            activeRequests: activeCount(), retiringRuntimes: retired.size });
        } catch { return Response.json({ reloaded: false, error: "runtime_reload_failed" }, { status: 409 }); }
      }
      if (pathname === `${prefix}/quotapie-health` && request.method === "GET") {
        const health = current.runtime.snapshot?.() ?? await (await current.runtime.fetch(request)).json() as Record<string, unknown>;
        const totals = combine([archived, ...[...retired].map(item => item.runtime.snapshot?.() ?? {}), health]);
        return Response.json({ ...health, ...totals,
          subscriptionGuard: health.subscriptionGuard ? { ...health.subscriptionGuard as object, ...totals.subscriptionGuard } : null,
          relayRuntimeRevision: 1, listenerPolicyVersion: 2, reloadSupported: true, runtimeSourceHash: sourceHash, runtimeReloadScope: "request-handler",
          activeRequests: activeCount(), draining, retiringRuntimes: retired.size });
      }
      if (pathname === `${prefix}/quotapie-drain` && request.method === "POST") {
        draining = true; return Response.json({ draining, activeRequests: activeCount() });
      }
      if (pathname === `${prefix}/quotapie-undrain` && request.method === "POST") {
        draining = false; return Response.json({ draining, activeRequests: activeCount() });
      }
      if (draining) return new Response("Relay is draining", { status: 503, headers: { "retry-after": "1" } });
      const admitted = current; admitted.pending++;
      try { return await admitted.runtime.fetch(request); }
      finally { admitted.pending--; collect(); }
    },
  });
  const timer = setInterval(collect, 100); timer.unref();
  return { baseUrl: `http://127.0.0.1:${server.port}${prefix}`, get sourceHash() { return sourceHash; },
    async stop() {
      draining = true;
      await server.stop(false);
      clearInterval(timer); collect();
      for (const item of retired) item.runtime.close();
      retired.clear(); current.runtime.close(); memory.dispose?.();
    },
  };
}
