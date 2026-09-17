import { expect, test } from "bun:test";
import { fetchCodexUpstream, transportFailure } from "../src/codex-transport";
import { startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";

const body = JSON.stringify({model: "gpt-6-astra", input: [], stream: true});
const complete = () => new Response('data: {"type":"response.completed","response":{"status":"completed","model":"gpt-6-astra"}}\n\n', {headers: {"content-type":"text/event-stream"}});

test("recovers pre-connect failure and records retry without duplicate terminal events", async () => {
  let calls = 0;
  const events: CompactionRequestEvent[] = [];
  const proxy = startCompactionProxy({onRequest: e => events.push(e), fetchUpstream: async () => {
    if (++calls === 1) throw Object.assign(new Error("private URL"), {code:"ECONNREFUSED"});
    return complete();
  }});
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {method:"POST", body});
    await response.text();
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(events.filter(e => e.phase === "completed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({phase:"completed", retryCount:1, transportCode:"ECONNREFUSED"});
  } finally { proxy.stop(); }
});

for (const [code, expected] of [["ECONNRESET","upstream_connection_reset"],["ETIMEDOUT","upstream_timeout"],["CERT_HAS_EXPIRED","upstream_tls_error"],["ENOTFOUND","upstream_dns_error"],["secret-token","upstream_unavailable"]]) {
  test(`does not replay ${code}; exposes only safe diagnostic fields`, async () => {
    let calls = 0;
    const events: CompactionRequestEvent[] = [];
    const proxy = startCompactionProxy({onRequest:e=>events.push(e), fetchUpstream: async () => {
      calls++; throw new Error("Bearer private-secret", {cause: Object.assign(new Error("private URL"),{code})});
    }});
    try {
      const response = await fetch(`${proxy.baseUrl}/responses`, {method:"POST",body});
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(`QuotaPie relay: ${expected}`);
      expect(calls).toBe(1);
      expect(events.at(-1)).toMatchObject({phase:"failed",status:0,errorCode:expected,retryCount:0});
      expect(JSON.stringify(events)).not.toMatch(/private|secret/);
    } finally {proxy.stop();}
  });
}

test("bounded reconnect stops after three attempts", async () => {
  let calls = 0, retries = 0;
  await expect(fetchCodexUpstream(async () => {calls++; throw {code:"EAI_AGAIN"};},"https://unused.invalid",{},()=>retries++)).rejects.toMatchObject({code:"EAI_AGAIN"});
  expect(calls).toBe(3); expect(retries).toBe(2);
});

test("cancellation during reconnect delay never sends another request", async () => {
  let calls = 0;
  const controller = new AbortController();
  await expect(fetchCodexUpstream(async () => {calls++; throw {code:"ENETUNREACH"};},"https://unused.invalid",{signal:controller.signal},()=>controller.abort())).rejects.toBeDefined();
  expect(calls).toBe(1);
});

test("does not retry HTTP errors or cancelled calls", async () => {
  let calls = 0;
  const fetcher = async () => {calls++; return new Response(null,{status:503});};
  expect((await fetchCodexUpstream(fetcher,"https://unused.invalid",{},()=>{})).status).toBe(503);
  const controller = new AbortController(); controller.abort();
  await expect(fetchCodexUpstream(fetcher,"https://unused.invalid",{signal:controller.signal},()=>{})).rejects.toBeDefined();
  expect(calls).toBe(1);
  expect(transportFailure({code:"toString"}).errorCode).toBe("upstream_unavailable");
});

test("client cancellation before headers is recorded as cancelled, not upstream failure", async () => {
  const events: CompactionRequestEvent[] = [];
  let ready!: () => void;
  const started = new Promise<void>(resolve => ready = resolve);
  const proxy = startCompactionProxy({onRequest:e=>events.push(e), fetchUpstream: async (_url, init) => {
    ready();
    await new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {once:true}));
    return complete();
  }});
  try {
    const controller = new AbortController();
    const pending = fetch(`${proxy.baseUrl}/responses`,{method:"POST",body,signal:controller.signal}).catch(()=>null);
    await started; controller.abort(); await pending;
    for (let i=0; i<50 && !events.some(e=>e.phase==="cancelled"); i++) await Bun.sleep(5);
    expect(events.filter(e=>["failed","cancelled","completed"].includes(e.phase))).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({phase:"cancelled",errorCode:"client_disconnected"});
  } finally {proxy.stop();}
});

test("actual Bun connection failure recovers through a live loopback relay", async () => {
  const target = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>complete()});
  const port = target.port!; target.stop(true);
  let calls = 0;
  let restored: ReturnType<typeof Bun.serve> | undefined;
  const events: CompactionRequestEvent[] = [];
  const proxy = startCompactionProxy({onRequest:e=>events.push(e),fetchUpstream:async () => {
    calls++;
    try {return await fetch(`http://127.0.0.1:${port}`);}
    catch(error) {
      expect(transportFailure(error)).toMatchObject({errorCode:"upstream_connection_failed",transportCode:"ConnectionRefused",retryable:true});
      restored = Bun.serve({hostname:"127.0.0.1",port,fetch:()=>complete()});
      throw error;
    }
  }});
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`,{method:"POST",body});
    await response.text();
    expect(calls).toBe(2);
    expect(events.at(-1)).toMatchObject({phase:"completed",retryCount:1,transportCode:"ConnectionRefused"});
  } finally {proxy.stop();restored?.stop(true);}
});
