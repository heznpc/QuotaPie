import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CompactionStatusReader } from "../src/compaction-status";
import { startCompactionProxy } from "../src/codex-compaction";

test("reads retired generations, distinguishes HTTP headers, completion and lost live state without exposing credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "quotapie-observation-"));
  const generation = join(root, "releases", "123");
  await mkdir(generation, {recursive:true});
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const events: any[] = [];
  const token = "ab".repeat(24);
  const proxy = startCompactionProxy({token, fetchUpstream: async () => new Response(new ReadableStream({start(c) {controller=c; c.enqueue(new TextEncoder().encode(": keepalive\n\n"));}}),
    {headers:{"content-type":"text/event-stream"}}), onRequest: e => events.push(e)});
  try {
    const settings = {port:Number(new URL(proxy.baseUrl).port), token};
    await writeFile(join(generation, "settings.json"), JSON.stringify(settings));
    const response = await fetch(proxy.baseUrl + "/responses/compact", {method:"POST", body:JSON.stringify({model:"gpt-6-astra",reasoning:{effort:"xhigh"}})});
    const body = response.text();
    // Headers reached the client; the compaction is still in progress.
    const reader = new CompactionStatusReader(root);
    const running = await reader.status();
    expect(running.active[0]?.phase).toBe("response_headers");
    expect(running.active[0]?.to).toBe("gpt-5.6-sol");
    expect(running.active[0]?.reasoningEffort).toBe("low");
    expect(running.recent).toHaveLength(0);
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n')); controller.close();
    await body;
    await writeFile(join(generation,"relay.log"), events.map(e=>JSON.stringify(e)).join("\n")+"\n");
    const completed = await reader.status(Date.now()+3000);
    expect(completed.active).toHaveLength(0);
    expect(completed.recent[0]?.phase).toBe("completed");
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
