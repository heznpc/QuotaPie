import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { savingsFailures, type SavingsEvidence } from "../script/verify-task-savings";

const event = { requestId: "request", threadId: "thread", turnId: null, kind: "response" as const,
  from: "gpt-6-astra", to: "gpt-5.6-luna", routed: true, phase: "started" as const, status: 200,
  requestedEffort: "xhigh", reasoningEffort: "low", at: new Date().toISOString(), durationMs: 1,
  savingsReason: "simple_text_edit" as const };
const good: SavingsEvidence = { exitCode: 0, timedOut: false, correct: true, supported: true, threadId: "thread",
  model: "gpt-5.6-luna", effort: "low", events: [event, { ...event, phase: "completed", responseModel: "gpt-5.6-luna" }] };

test("savings verification requires correct output and completed, correlated model evidence", () => {
  expect(savingsFailures(good)).toEqual([]);
  for (const patch of [{ exitCode: 7 }, { correct: false }, { timedOut: true }, { supported: false },
    { threadId: null }, { threadId: "other" }, { events: [] }, { events: [event] },
    { events: [event, { ...event, phase: "completed" as const, responseModel: "gpt-6-astra" }] },
    { events: [event, { ...event, phase: "unverified" as const }] }]) {
    expect(savingsFailures({ ...good, ...patch }).length).toBeGreaterThan(0);
  }
});

test("CLI rejects child failure, missing observations and timeouts without using a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "quotapie-verify-test-"));
  try {
    const cache = join(root, "models.json");
    await writeFile(cache, JSON.stringify({ models: [{ slug: "gpt-5.6-luna", supported_reasoning_levels: [{ effort: "low" }] }] }));
    for (const mode of ["failed", "no-evidence", "timeout"]) {
      const fake = join(root, "codex");
      await writeFile(fake, `#!${process.execPath}\n${mode === "failed" ? "process.exit(7)" : mode === "timeout" ? "setInterval(() => {}, 1000)" : `const i=process.argv.indexOf('-C'); await Bun.write(process.argv[i+1]+'/index.html','<button id="save">Done</button>\\n');`}`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, "script/verify-task-savings.ts", "--codex", fake, "--models-cache", cache,
        "--timeout-ms", mode === "timeout" ? "100" : "5000"], { stdout: "pipe", stderr: "pipe" });
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(code).toBe(1);
      const report = JSON.parse(output.trim());
      expect(report.result).toBe("fail");
      expect(report.failures).toContain(mode === "failed" ? "child_failed" : mode === "timeout" ? "timeout" : "missing_routed_request");
      if (mode === "no-evidence") expect(report.correct).toBe(true);
      const evidence = JSON.parse(await readFile(report.report, "utf8"));
      expect(evidence.events).toEqual([]);
      // Only the private directory created by this invocation is removed.
      await rm(join(report.report, ".."), { recursive: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);

import { smokeFailures } from "../script/verify-macos";
test("native checker rejects wrong account, stale rendering, hidden connection failure and extra menu bar", () => {
  const observed = { connected: true, selectedAccount: "codex/default", remainingPercent: 18, menuVisible: false,
    menuHasImage: true, menuAccessibleLabel: "Main · Codex 18%", viewRendered: true, statusFailure: null };
  const expected = { account: "codex/default", remaining: 18, label: "Main" };
  expect(smokeFailures(observed, expected)).toEqual([]);
  for (const patch of [{ selectedAccount: "codex/second" }, { remainingPercent: 100 }, { menuVisible: true },
    { menuHasImage: false }, { menuAccessibleLabel: "Second · Codex 18%" }, { viewRendered: false }, { connected: false }]) {
    expect(smokeFailures({ ...observed, ...patch }, expected).length).toBeGreaterThan(0);
  }
  expect(smokeFailures(observed, null)).toContain("connection_failure_hidden");
});
