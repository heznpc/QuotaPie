// Explicit real-provider smoke test; never part of the offline check command.
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { startCompactionProxy, compactionCodexArgs, type CompactionRequestEvent } from "../src/codex-compaction";

export interface SavingsEvidence {
  exitCode: number;
  timedOut: boolean;
  correct: boolean;
  supported: boolean;
  threadId: string | null;
  model: string;
  effort: string;
  events: CompactionRequestEvent[];
}

export function savingsFailures(result: SavingsEvidence): string[] {
  const failures: string[] = [];
  if (result.timedOut) failures.push("timeout");
  if (result.exitCode !== 0) failures.push("child_failed");
  if (!result.correct) failures.push("incorrect_output");
  if (!result.supported) failures.push("model_unsupported");
  if (!result.threadId) failures.push("missing_thread_identity");
  const events = result.threadId ? result.events.filter(e => e.threadId === result.threadId && e.kind === "response") : [];
  const routed = events.filter(e => e.phase === "started" && e.routed && e.from === "gpt-6-astra"
    && e.to === result.model && e.reasoningEffort === result.effort && e.savingsReason === "simple_text_edit");
  if (!routed.length) failures.push("missing_routed_request");
  for (const request of events.filter(e => e.phase === "started")) {
    if (!events.some(e => e.requestId === request.requestId && e.phase === "completed" && e.status >= 200 && e.status < 300)) {
      failures.push("incomplete_request");
    }
  }
  if (events.some(e => ["failed", "cancelled", "unverified"].includes(e.phase))) failures.push("request_failed_or_unverified");
  if (!routed.some(request => events.some(e => e.requestId === request.requestId && e.phase === "completed"
    && e.responseModel === result.model && e.status >= 200 && e.status < 300))) failures.push("missing_response_model_evidence");
  return [...new Set(failures)];
}

async function main() {
  const arg = (name: string) => {
    const index = process.argv.indexOf(name);
    if (index < 0) return undefined;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    return value;
  };
  const timeoutMs = Number(arg("--timeout-ms") ?? 90_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000) throw new Error("Invalid timeout");
  const root = await mkdtemp(join(tmpdir(), "quotapie-savings-live-"));
  const model = "gpt-5.6-luna", effort = "low";
  const events: CompactionRequestEvent[] = [];
  let proxy: ReturnType<typeof startCompactionProxy> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await writeFile(join(root, "index.html"), '<button id="save">Save</button>\n');
    const installed = process.argv.includes("--installed");
    let endpoint: string;
    let supported: boolean;
    const health = async () => {
      const response = await fetch(endpoint + "/quotapie-health", { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error("Relay health unavailable");
      return await response.json() as { taskSavings?: { enabled: boolean; model: string; effort: string }; savingsModelSupported?: boolean; recent?: CompactionRequestEvent[] };
    };
    if (installed) {
      const manifest = JSON.parse(await readFile(join(homedir(), ".local/lib/quotapie-compaction/current.json"), "utf8"));
      const settings = JSON.parse(await readFile(manifest.settings_path, "utf8"));
      endpoint = `http://127.0.0.1:${settings.port}/${settings.token}/backend-api/codex`;
      const state = await health();
      if (!state.taskSavings?.enabled || state.taskSavings.model !== model || state.taskSavings.effort !== effort) {
        throw new Error("Installed task savings policy does not match the smoke test");
      }
      supported = state.savingsModelSupported === true;
    } else {
      const catalog = JSON.parse(await readFile(arg("--models-cache") ?? join(homedir(), ".codex/models_cache.json"), "utf8"));
      supported = catalog.models.some((m: { slug: string; supported_reasoning_levels: { effort: string }[] }) =>
        m.slug === model && m.supported_reasoning_levels.some(r => r.effort === effort));
      proxy = startCompactionProxy({ taskSavings: { enabled: true, model, effort }, savingsModelSupported: () => supported,
        onRequest: event => events.push(event) });
      endpoint = proxy.baseUrl;
    }
    if (!supported) throw new Error("Task savings model is unsupported");
    const binary = arg("--codex") ?? process.argv.slice(2).find(value => value.endsWith("/codex")) ?? "/Applications/ChatGPT.app/Contents/Resources/codex";
    const args = compactionCodexArgs(endpoint, ["-s", "workspace-write", "-a", "never", "-c", 'model_reasoning_effort="xhigh"',
      "exec", "--skip-git-repo-check", "--json", "-C", root, "-m", "gpt-6-astra", 'Change the button label in index.html from "Save" to "Done".']);
    const running = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
    child = running;
    timeout = setTimeout(() => { timedOut = true; child?.kill("SIGKILL"); }, timeoutMs);
    const [exitCode, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]);
    clearTimeout(timeout);
    const threadId: string | null = stdout.split("\n").flatMap(line => {
      try { const event = JSON.parse(line); return event.type === "thread.started" && typeof event.thread_id === "string" ? [event.thread_id] : []; }
      catch { return []; }
    })[0] ?? null;
    // Without identity, never associate unrelated requests from a shared relay.
    if (installed && threadId) events.push(...(await health()).recent?.filter(e => e.threadId === threadId) ?? []);
    const correct = await readFile(join(root, "index.html"), "utf8").then(text => text === '<button id="save">Done</button>\n', () => false);
    const result: SavingsEvidence = { exitCode, timedOut, correct, supported, threadId, model, effort, events };
    const failures = savingsFailures(result);
    const report = join(root, "report.json");
    await writeFile(report, JSON.stringify({ ...result, failures, stderrPresent: stderr.length > 0 }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ report, exitCode, correct, events: events.length, result: failures.length ? "fail" : "pass", failures }));
    if (failures.length) process.exitCode = 1;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child && child.exitCode == null) { child.kill("SIGKILL"); await child.exited; }
    proxy?.stop();
  }
}

if (import.meta.main) {
  await main().catch(() => {
    // Exception messages can contain private relay URLs or local credential paths.
    console.error("Task savings verification failed during setup or observation; no successful result was recorded.");
    process.exitCode = 1;
  });
}
