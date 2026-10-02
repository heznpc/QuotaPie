import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CompactionStatusReader } from "../src/compaction-status";
import { startCompactionProxy } from "../src/codex-compaction";
import { DEFAULT_TASK_SAVINGS } from "../src/task-savings";

test("observation reuses validated settings for both policies while still observing unlisted generations", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quotapie-shared-settings-")));
  const paths = [join(root, "releases", "1", "settings.json"), join(root, "releases", "2", "settings.json")];
  const route = { from: "gpt-6-astra", to: "gpt-5.6-sol", effort: "low" };
  let requests = 0;
  try {
    for (let i = 0; i < paths.length; i++) {
      await mkdir(join(root, "releases", String(i + 1)), { recursive: true });
      await writeFile(paths[i]!, JSON.stringify({ port: 45001 + i, token: "ab".repeat(24), route }));
    }
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: paths[0] }));
    const reader = new CompactionStatusReader(root, (async () => {
      requests++;
      // The observer already validated this version. A concurrent editor must
      // not force more settings scans or leak a mixed policy snapshot.
      await writeFile(paths[0]!, "{");
      return Response.json({ service: "quotapie-compaction", schemaVersion: 3, route,
        taskSavings: DEFAULT_TASK_SAVINGS, savingsModelSupported: true });
    }) as unknown as typeof fetch);
    const status = await reader.status();
    expect(requests).toBe(2);
    expect(status.generations).toBe(2);
    expect(status.reachable).toBe(2);
    expect(status.policy).toMatchObject({ model: "gpt-5.6-sol", configurable: true, generations: 1 });
    expect(status.savings.policy).toMatchObject({ configurable: true, generations: 1 });
    // Mutation does not reuse the observer's cached settings.
    await expect(reader.policy.configure("gpt-5.6-luna")).rejects.toThrow("policy_update_failed");
    await expect(reader.savingsPolicy.configure({ enabled: true })).rejects.toThrow("savings_update_failed");
    const refreshed = await reader.status(status.checkedAtMs + 3000);
    expect(refreshed.policy).toBeNull();
    expect(refreshed.savings.policy).toBeNull();
    expect(refreshed.generations).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared settings retain required profile validation and ignore invalid retired policies independently", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quotapie-retired-policy-")));
  const current = join(root, "settings.json"), retired = join(root, "releases", "1", "settings.json");
  const route = { from: "gpt-6-astra", to: "gpt-5.6-sol", effort: "low" };
  try {
    await mkdir(join(root, "releases", "1"), { recursive: true });
    await writeFile(current, JSON.stringify({ port: 45001, token: "ab".repeat(24), route }));
    await writeFile(retired, JSON.stringify({ port: 45002, token: "ab".repeat(24), route: {} }));
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: current, retired_settings: [retired] }));
    const reader = new CompactionStatusReader(root, (async () => Response.json({ service: "quotapie-compaction", schemaVersion: 3,
      route, taskSavings: DEFAULT_TASK_SAVINGS, savingsModelSupported: true })) as unknown as typeof fetch);
    const status = await reader.status();
    expect(status.policy).toMatchObject({ generations: 1, configurable: true });
    expect(status.savings.policy).toMatchObject({ generations: 2, configurable: true });
    await writeFile(join(root, "current.json"), JSON.stringify({ settings_path: current, profile_settings: { second: retired } }));
    const required = await reader.status(status.checkedAtMs + 3000);
    expect(required.policy).toBeNull();
    expect(required.savings.policy).not.toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reads retired generations, distinguishes HTTP headers, completion and lost live state without exposing credentials", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "quotapie-observation-")));
  const generation = join(root, "releases", "123");
  await mkdir(generation, {recursive:true});
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const events: any[] = [];
  const token = "ab".repeat(24);
  const proxy = startCompactionProxy({token, fetchUpstream: async () => new Response(new ReadableStream({start(c) {controller=c; c.enqueue(new TextEncoder().encode(": keepalive\n\n"));}}),
    {headers:{"content-type":"text/event-stream"}}), onRequest: e => events.push(e)});
  try {
    const settings = {port:Number(new URL(proxy.baseUrl).port), token,
      route:{from:"gpt-6-astra",to:"gpt-5.6-sol",effort:"low"}};
    await writeFile(join(generation, "settings.json"), JSON.stringify(settings));
    await writeFile(join(root, "current.json"), JSON.stringify({settings_path:join(generation, "settings.json")}));
    const response = await fetch(proxy.baseUrl + "/responses/compact", {method:"POST", body:JSON.stringify({model:"gpt-6-astra",reasoning:{effort:"xhigh"}})});
    const body = response.text();
    // Headers reached the client; the compaction is still in progress.
    let healthRequests = 0;
    const reader = new CompactionStatusReader(root, ((...args: Parameters<typeof fetch>) => {
      healthRequests++;
      return fetch(...args);
    }) as unknown as typeof fetch);
    const running = await reader.status();
    expect(healthRequests).toBe(1);
    expect(running.policy).not.toBeNull();
    expect(running.savings.policy).not.toBeNull();
    expect(running.active[0]?.phase).toBe("response_headers");
    expect(running.active[0]?.to).toBe("gpt-5.6-sol");
    expect(running.active[0]?.reasoningEffort).toBe("low");
    expect(running.recent).toHaveLength(0);
    const stale = reader.snapshot(running.checkedAtMs + 20_000);
    expect(stale.active).toHaveLength(0);
    expect(stale.recent[0]?.phase).toBe("unverified");
    expect(stale.reachable).toBe(0);
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"model":"gpt-5.6-sol","usage":{"input_tokens":20,"output_tokens":5}}}\n\n')); controller.close();
    await body;
    await writeFile(join(generation,"relay.log"), events.map(e=>JSON.stringify(e)).join("\n")+"\n");
    const completed = await reader.status(Date.now()+3000);
    expect(completed.active).toHaveLength(0);
    expect(completed.recent[0]?.phase).toBe("completed");
    expect(completed.recent[0]?.responseModel).toBe("gpt-5.6-sol");
    expect(completed.recent[0]?.usage).toEqual({ input: 20, cachedInput: 0, output: 5 });
    proxy.stop();
    // Retained log survives relay loss. An unfinished log never implies success.
    const unfinished = {...events[0],requestId:"11111111-1111-4111-8111-111111111111"};
    await writeFile(join(root,"settings.json"),JSON.stringify(settings));
    await writeFile(join(root,"relay.log"),JSON.stringify(unfinished)+"\n");
    const lost = await reader.status(Date.now()+6000);
    expect(lost.generations).toBe(2);
    expect(lost.recent.some(e=>e.phase==="unverified")).toBe(true);
    expect(lost.recent.some(e=>e.phase==="completed")).toBe(true);
    expect(JSON.stringify(lost)).not.toContain(token);
    expect(JSON.stringify(lost)).not.toContain("settings.json");
  } finally { proxy.stop(); await rm(root,{recursive:true,force:true}); }
});
