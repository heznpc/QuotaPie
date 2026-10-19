import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config";
import { legacyProviderRepairCommand, wakeHostQueuedThread } from "../src/quota-resume/host-wake";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quotapie-host-wake-")); roots.push(root);
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts.codex = [{ id: "plus", enabled: true, label: "Plus", codexHome: root }];
  return { config, account: "plus", threadId: "11111111-1111-4111-8111-111111111111" };
}
function helper(reply: "sent" | "unavailable" | "silent" | "invalid" = "sent", beforeReady = () => {}) {
  const writes: string[] = [];
  let output: ReadableStreamDefaultController<Uint8Array>, stopped = false, finish!: (exit: number) => void;
  const exited = new Promise<number>(resolve => { finish = resolve; });
  const emit = (value: unknown) => output.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
  const child = {
    stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller; } }), exited,
    stdin: { write(value: string) {
      writes.push(value);
      if (writes.length === 1) {
        beforeReady();
        if (reply === "silent") return;
        if (reply === "invalid") emit({ status: "sent" });
        else if (reply === "unavailable") emit({ status: "unavailable", reason: "host-wake-owner-unavailable" });
        else emit({ status: "ready" });
      } else if (value === "send\n") emit({ status: "sent" });
    }, flush() {}, end() {} },
    kill() { if (!stopped) { stopped = true; try { output.close(); } catch {} finish(0); } },
  };
  return { child, writes };
}

test("host wake sends only a fixed profile request, then one authorized handshake", async () => {
  const request = fixture(), process = helper();
  expect(await wakeHostQueuedThread(request, { platform: "darwin", launch: () => process.child,
    repairProvider: async () => true })).toEqual({ status: "sent" });
  expect(process.writes).toEqual([JSON.stringify({ account: request.account,
    codexHome: realpathSync(request.config.accounts.codex[0]!.codexHome!), threadId: request.threadId }) + "\n", "send\n"]);
});

test("missing, disabled, invalid and unsupported profiles never launch a helper", async () => {
  for (const kind of ["disabled", "invalid", "platform", "revoked"] as const) {
    const request = fixture(); let launches = 0;
    if (kind === "disabled") request.config.accounts.codex[0]!.enabled = false;
    if (kind === "invalid") request.threadId = "codex://threads/new?prompt=do-work";
    const result = await wakeHostQueuedThread({ ...request, stillAuthorized: () => kind !== "revoked" }, {
      platform: kind === "platform" ? "linux" : "darwin", launch: () => { launches++; return helper().child; },
    });
    expect(result.status).toBe("unavailable"); expect(launches).toBe(0);
  }
});

test("permission or account binding revoked during process lookup prevents send", async () => {
  for (const change of ["permission", "binding"] as const) {
    const request = fixture(); let authorized = true;
    const process = helper("sent", () => {
      if (change === "permission") authorized = false;
      else request.config.accounts.codex[0]!.enabled = false;
    });
    expect(await wakeHostQueuedThread({ ...request, stillAuthorized: () => authorized }, {
      platform: "darwin", launch: () => process.child,
    })).toEqual({ status: "unavailable", reason: "host-wake-authorization-changed" });
    expect(process.writes).toHaveLength(1);
  }
});

test("the final queue recheck runs after owner lookup and can veto the wake", async () => {
  for (const throws of [true, false]) {
    const process = helper(); let authorized = true, checks = 0;
    const result = await wakeHostQueuedThread({ ...fixture(), stillAuthorized: () => authorized,
      beforeSend: async () => {
        checks++; expect(process.writes).toHaveLength(1);
        await Promise.resolve();
        if (throws) throw new Error("foreign input appeared");
        authorized = false;
      },
    }, { platform: "darwin", launch: () => process.child });
    expect(result).toEqual({ status: "unavailable", reason: throws ? "host-wake-queue-changed" : "host-wake-authorization-changed" });
    expect(checks).toBe(1); expect(process.writes).toHaveLength(1);
  }
});

test("unavailable, malformed and timed out helpers do not retry or use a URL opener", async () => {
  for (const outcome of ["unavailable", "invalid", "silent"] as const) {
    const process = helper(outcome); let launches = 0;
    const result = await wakeHostQueuedThread(fixture(), { platform: "darwin", timeoutMs: 10,
      launch: () => { launches++; return process.child; } });
    expect(result.status).toBe("unavailable"); expect(launches).toBe(1); expect(process.writes).toHaveLength(1);
  }
});

test("native helper identity and PID AppleEvent paths use isolated IO doubles", async () => {
  const file = fileURLToPath(new URL("./host_wake.py", import.meta.url));
  const process = Bun.spawn(["/usr/bin/python3", "-B", file], { stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect({ output, error: code === 0 ? "" : error, code }).toEqual({ output: "", error: "", code: 0 });
});

test("ordinary OpenAI threads need no relay installation or provider repair", async () => {
  const request = fixture(), process = helper();
  const home = realpathSync(request.config.accounts.codex[0]!.codexHome!);
  mkdirSync(join(home, "sessions"));
  const rollout = join(home, "sessions", "fixture.jsonl");
  writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: request.threadId } }) + "\n");
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT,model_provider TEXT,rollout_path TEXT)");
  db.query("INSERT INTO threads VALUES (?,?,?)").run(request.threadId, "openai", rollout); db.close();
  expect(await wakeHostQueuedThread(request, { platform: "darwin", launch: () => process.child })).toEqual({ status: "sent" });
  expect(process.writes).toHaveLength(2);
});

test("legacy repair uses the installed Python with the current runtime script, never an old manager", () => {
  const input = { codexHome: "/fixture/plus", threadId: "11111111-1111-4111-8111-111111111111" };
  const oldManager = join(homedir(), ".local/lib/quotapie-compaction/manage.py");
  const wrapper = `#!/bin/sh\nexec '/usr/bin/python3' '${oldManager}' "$@"\n`;
  const command = legacyProviderRepairCommand(wrapper, input);
  expect(command).toEqual([realpathSync("/usr/bin/python3"), "-B",
    fileURLToPath(new URL("../scripts/codex-compaction-local.py", import.meta.url)), "repair-legacy-provider",
    "--codex-home", input.codexHome, "--thread-id", input.threadId]);
  expect(command).not.toContain(oldManager);
  for (const modified of [wrapper + "echo unsafe\n", wrapper.replace("/usr/bin/python3", "/usr/bin/sh"),
    wrapper.replace(oldManager, "/unrelated/manager.py"), wrapper.replace("'/usr/bin/python3'", "'$(command)'"),
    wrapper.replace("exec ", "exec env ")]) expect(() => legacyProviderRepairCommand(modified, input)).toThrow();
});

test("provider repair follows queue consent and rechecks queue and permission before one wake", async () => {
  for (const mode of ["ready", "failed", "throw", "permission", "queue"] as const) {
    const request = fixture(), process = helper(), order: string[] = [];
    let authorized = true, checks = 0;
    const result = await wakeHostQueuedThread({ ...request, stillAuthorized: () => authorized,
      beforeSend: async () => { order.push("queue"); checks++; if (mode === "queue" && checks === 2) throw new Error(); },
    }, { platform: "darwin", launch: () => process.child, repairProvider: async input => {
      order.push("repair"); expect(input.threadId).toBe(request.threadId); expect(process.writes).toHaveLength(1);
      if (mode === "permission") authorized = false;
      if (mode === "throw") throw new Error();
      return mode !== "failed";
    } });
    expect(order).toEqual(mode === "failed" || mode === "throw" ? ["queue", "repair"] : ["queue", "repair", "queue"]);
    expect(result).toEqual(mode === "ready" ? { status: "sent" } : { status: "unavailable", reason:
      mode === "permission" ? "host-wake-authorization-changed" : mode === "queue" ? "host-wake-queue-changed" : "host-wake-provider-unavailable" });
    expect(process.writes).toHaveLength(mode === "ready" ? 2 : 1);
  }
});

test("timeout aborts a pending provider repair and never sends after late completion", async () => {
  const process = helper(); let aborted = false;
  const result = await wakeHostQueuedThread(fixture(), { platform: "darwin", timeoutMs: 10, launch: () => process.child,
    repairProvider: async (_input, signal) => new Promise(resolve => {
      signal.addEventListener("abort", () => { aborted = true; resolve(true); }, { once: true });
    }),
  });
  expect(result).toEqual({ status: "unavailable", reason: "host-wake-timeout" });
  await Promise.resolve(); expect(aborted).toBe(true); expect(process.writes).toHaveLength(1);
});
