import { afterEach, expect, test } from "bun:test";
import { appendFileSync, realpathSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { UsageReportIndex } from "../src/usage-report";
const DAY = 86400000, NOW = Date.parse("2026-10-19T09:00:00Z"), FROM = NOW - DAY;
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const dirs: string[] = []; afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "quotapie-report-")); dirs.push(dir);
  const codex = join(dir, "codex"), claude = join(dir, "claude"), relay = join(dir, "relay");
  for (const path of [join(codex, "sessions"), join(claude, "projects"), relay]) mkdirSync(path, { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG);
  config.accounts = { codex: [{ id: "main", label: "Main", enabled: true, codexHome: codex }], claude: [{ id: "claude", label: "Claude", enabled: true, configDir: claude, keychainService: null }] };
  return { dir, codex, claude, relay, config, index: new UsageReportIndex({ relayRoot: null, relayLogsRoot: relay, inventoryTtlMs: 0, ...options }) };
}
const iso = (at: number) => new Date(at).toISOString();
const meta = (id = A, source?: unknown, fork?: string, at = FROM - DAY) => ({ timestamp: iso(at), type: "session_meta", payload: { id, cwd: "/private/projects/Example", source, forked_from_id: fork } });
const context = (model: string) => ({ type: "turn_context", payload: { model } });
const usage = (at: number, input: number, cached: number, output: number, last?: number) => ({ timestamp: iso(at), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output }, last_token_usage: last == null ? null : { input_tokens: last, total_tokens: last } } } });
function file(path: string, records: unknown[]) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, records.map(r => JSON.stringify(r)).join("\n") + "\n"); return path; }
const query = { fromMs: FROM, toMs: NOW, timeZone: "Asia/Seoul" };
test("cumulative deltas, model changes, mirror dedupe and equal preceding range", async () => {
  const f = fixture(); const rows = [meta(), context("astra"), usage(FROM - 1000, 100, 20, 10), usage(FROM + 1000, 200, 40, 20), context("sol"), usage(FROM + 2000, 300, 60, 30), usage(FROM + 3000, 300, 60, 30)];
  file(join(f.codex, "sessions", "main.jsonl"), rows); file(join(f.codex, "archived_sessions", "mirror.jsonl"), rows);
  const r = await f.index.report(f.config, query);
  expect(r.total.totalTokens).toBe(220); expect(r.previous.totalTokens).toBe(110); expect(r.total.cachedInputTokens).toBe(40);
  expect(r.models.find(m => m.model === "astra")?.previousTotalTokens).toBe(110); expect(r.models.find(m => m.model === "sol")?.totalTokens).toBe(110);
  expect(r.total.requests).toBe(2); expect(r.days).toHaveLength(1); expect(r.coverage.filesPending).toBe(0);
});
test("fork copied metadata does not replace identity or count inherited usage; subagents included", async () => {
  const f = fixture();
  file(join(f.codex, "sessions", "fork.jsonl"), [meta(B, { subagent: {} }, A, FROM), meta(A), context("sol"), usage(FROM - 1000, 1000, 0, 0), usage(FROM + 1000, 1100, 0, 0)]);
  const r = await f.index.report(f.config, query); expect(r.total.totalTokens).toBe(100); expect(r.total.subagentTokens).toBe(100);
  expect(r.sessions[0]?.sessionId).toBe(B); expect(r.sessions[0]?.isSubagent).toBe(true);
});
test("Claude stream updates dedupe message IDs globally and include cache subsets plus subagent files", async () => {
  const f = fixture(); const row = (n: number) => ({ type: "assistant", sessionId: A, timestamp: iso(FROM + 1000), cwd: "/project",
    message: { id: "message1", model: "claude-model", content: "SECRET PROMPT", usage: { input_tokens: n, cache_creation_input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 20 } } });
  file(join(f.claude, "projects", "x", A, "subagents", "agent-one.jsonl"), [row(5), row(15)]);
  file(join(f.claude, "projects", "mirror", A, "subagents", "agent-one.jsonl"), [row(15)]);
  const r = await f.index.report(f.config, query); expect(r.total.totalTokens).toBe(50); expect(r.total.inputTokens).toBe(30);
  expect(r.total.cachedInputTokens).toBe(10); expect(r.total.cacheCreationTokens).toBe(5); expect(r.total.subagentTokens).toBe(50);
  expect(JSON.stringify(r)).not.toContain("SECRET");
});
test("append, partial line and rewrite accounting remains stable", async () => {
  const f = fixture(); const path = file(join(f.codex, "sessions", "a.jsonl"), [meta(), usage(FROM + 1000, 10, 0, 0)]);
  expect((await f.index.report(f.config, query)).total.totalTokens).toBe(10);
  const next = JSON.stringify(usage(FROM + 2000, 20, 0, 0)); appendFileSync(path, next.slice(0, 20));
  expect((await f.index.report(f.config, query)).total.totalTokens).toBe(10); appendFileSync(path, next.slice(20) + "\n");
  expect((await f.index.report(f.config, query)).total.totalTokens).toBe(20);
  file(path, [meta(), usage(FROM + 1000, 3, 0, 0)]); expect((await f.index.report(f.config, query)).total.totalTokens).toBe(3);
});
test("bounded scan exposes partial coverage and continues on next passes", async () => {
  const f = fixture({ maxBytesPerScan: 1024 });
  const rows = [meta(), context("sol"), ...Array.from({ length: 20 }, (_,i) => usage(FROM + i, (i+1)*10, 0, 0))];
  file(join(f.codex, "sessions", "a.jsonl"), rows);
  let r = await f.index.report(f.config, query); expect(r.coverage.filesPending).toBeGreaterThan(0);
  for (let i = 0; i < 30 && r.coverage.filesPending; i++) r = await f.index.report(f.config, query);
  expect(r.coverage.filesPending).toBe(0); expect(r.total.totalTokens).toBe(200);
});
test("relay request lifecycle and mirrored rotations count once, usage not double added", async () => {
  const f = fixture(); file(join(f.codex, "sessions", "a.jsonl"), [meta(), usage(FROM + 1000, 100, 0, 0)]);
  const event = { requestId: B, threadId: A, turnId: null, kind: "compaction", from: "astra", to: "sol", routed: true, phase: "completed", status: 200, requestedEffort: null, reasoningEffort: null, at: iso(FROM+2000), durationMs: 100, retryCount: 2, usage: { input: 80, cachedInput: 20, output: 20 } };
  file(join(f.relay, "one.jsonl"), [{...event, phase: "started", usage: null}, event]); file(join(f.relay, "two.jsonl.1"), [event]);
  const r = await f.index.report(f.config, query); expect(r.total.totalTokens).toBe(100); expect(r.activity.compactions).toBe(1); expect(r.activity.retries).toBe(2); expect(r.activity.compactionTokens).toBe(100);
});
test("reset periods separate account buckets and provider scope filters", async () => {
  const f = fixture(); file(join(f.codex, "sessions", "a.jsonl"), [meta(), usage(FROM+1000, 100, 0, 0), usage(FROM+3000, 300, 0, 0)]);
  const r = await f.index.report(f.config, { ...query, resetBoundaries: [{ provider: "codex", account: "main", bucket: "weekly", label: "주간", atMs: FROM+2000 }, { provider: "codex", account: "main", bucket: "5h", label: "5시간", atMs: FROM+500 }] });
  expect(r.resetPeriods.filter(b => b.bucket === "weekly").map(b => b.totalTokens).sort((a,b)=>a-b)).toEqual([100,200]);
  expect(r.total.totalTokens).toBe(300); expect((await f.index.report(f.config, { ...query, provider: "claude", account: "claude" })).total.totalTokens).toBe(0);
});

test("first fork event uses own last usage rather than inherited cumulative total", async () => {
  const f = fixture();
  file(join(f.codex, "sessions", "fork.jsonl"), [meta(B, { subagent: {} }, A, FROM), context("sol"), usage(FROM+1000, 10000, 0, 0, 200), usage(FROM+2000, 10100, 0, 0, 100)]);
  const r = await f.index.report(f.config, query); expect(r.total.totalTokens).toBe(300); expect(r.total.subagentTokens).toBe(300);
});

test("cross-account copied session events dedupe globally and remain unassigned", async () => {
  const f = fixture(), other = join(f.dir, "other");
  const rows = [meta(), context("sol"), usage(FROM+1000, 100, 0, 0)];
  file(join(f.codex, "sessions", "one.jsonl"), rows); file(join(other, "sessions", "two.jsonl"), rows);
  f.config.accounts.codex.push({ id: "other", label: "Other", enabled: true, codexHome: other });
  const r = await f.index.report(f.config, query); expect(r.total.totalTokens).toBe(100); expect(r.sessions[0]?.account).toBe("unknown");
  expect((await f.index.report(f.config, { ...query, provider: "codex", account: "main" })).total.totalTokens).toBe(0);
});
test("relay evidence attributed separately to day/session/reset and observed response model", async () => {
  const f = fixture(); file(join(f.codex, "sessions", "a.jsonl"), [meta(), usage(FROM+1000, 100, 0, 0)]);
  const event = { requestId: B, threadId: A, turnId: null, kind: "compaction", from: "astra", to: "sol", responseModel: "actual-sol", routed: true, phase: "completed", status: 200, requestedEffort: null, reasoningEffort: null, at: iso(FROM+2000), durationMs: 100, retryCount: 1, usage: { input: 80, cachedInput: 20, output: 20 } };
  file(join(f.relay, "one.jsonl"), [event]); appendFileSync(join(f.relay, "one.jsonl"), "normal access log line\n");
  const r = await f.index.report(f.config, {...query, resetBoundaries:[{provider:"codex",account:"main",bucket:"weekly",label:"Week",atMs:FROM-1000,kind:"scheduled_reset"}]});
  expect(r.sessions[0]?.activity?.compactionTokens).toBe(100); expect(r.days[0]?.activity?.retries).toBe(1);
  expect(r.resetPeriods[0]?.activity?.compactions).toBe(1); expect(r.resetPeriods[0]?.startClipped).toBe(true); expect(r.resetPeriods[0]?.resetAtMs).toBe(FROM-1000);
  expect(r.relayModels?.[0]?.model).toBe("actual-sol"); expect(r.relayModels?.[0]?.totalTokens).toBe(100); expect(r.total.totalTokens).toBe(100); expect(r.coverage.malformedLines).toBe(0);
});

test("overlong opaque lines are skipped without marking unscanned trailing usage complete", async () => {
  const f = fixture();
  file(join(f.codex, "sessions", "large.jsonl"), [meta(), {type:"response_item", payload:{content:"x".repeat(5 * 1024 * 1024)}}, context("sol"), usage(FROM+1000, 50, 0, 0)]);
  const r = await f.index.report(f.config, query); expect(r.total.totalTokens).toBe(50); expect(r.coverage.filesPending).toBe(0); expect(r.coverage.malformedLines).toBe(1);
});

test("local compaction markers survive absent relay receipts and ignore inherited fork history", async () => {
  const f = fixture();
  const compacted = (at:number) => ({type:"compacted",timestamp:iso(at),payload:{replacement_history:"SECRET HISTORY"}});
  const rows = [meta(B, "subagent", A, FROM), meta(A), compacted(FROM-1000), compacted(FROM+1000), usage(FROM+2000,100,0,0,10)];
  file(join(f.codex,"sessions","a.jsonl"),rows);file(join(f.codex,"archived_sessions","mirror.jsonl"),rows);
  const r = await f.index.report(f.config,{...query,resetBoundaries:[{provider:"codex",account:"main",bucket:"weekly",label:"Week",atMs:FROM}]});
  expect(r.activity.compactions).toBe(0);expect(r.activity.localCompactions).toBe(1);expect(r.days[0]?.activity?.localCompactions).toBe(1);
  expect(r.sessions[0]?.activity?.localCompactions).toBe(1);expect(r.resetPeriods[0]?.activity?.localCompactions).toBe(1);expect(JSON.stringify(r)).not.toContain("SECRET HISTORY");
});
test("large-log continuation visits completed sources once and reuses one file snapshot per pass", async () => {
  const f = fixture();
  const small: string[] = [];
  for (let i=0;i<30;i++) small.push(file(join(f.codex,"sessions",`small-${i}.jsonl`),[meta(),usage(FROM+1000,10,0,0)]));
  await f.index.report(f.config,query);
  const large = file(join(f.codex,"sessions","large.jsonl"),[meta(B),context("sol"),
    ...Array.from({length:160},()=>({type:"response_item",payload:{content:"x".repeat(60000)}})),usage(FROM+2000,100,0,0)]);
  const scans = new Map<string,{visits:number,opens:number}>();
  const original = (f.index as any).scan;
  (f.index as any).scan = function(source:any,budget:number,handles:Map<string,unknown>) {
    const counts = scans.get(source.path) ?? {visits:0,opens:0}; counts.visits++; if (!handles.has(source.path)) counts.opens++;
    scans.set(source.path,counts); return original.call(this,source,budget,handles);
 };
  const r = await f.index.report(f.config,query);
  expect(r.total.totalTokens).toBe(110); expect(r.coverage.filesPending).toBe(0);
  expect(scans.get(realpathSync(large))?.visits).toBeGreaterThan(1); expect(scans.get(realpathSync(large))?.opens).toBe(1);
  for(const path of small) expect(scans.get(realpathSync(path))).toEqual({visits:1,opens:1});
  appendFileSync(small[0]!,JSON.stringify(usage(FROM+3000,20,0,0))+"\n");
  expect((await f.index.report(f.config,query)).total.totalTokens).toBe(120);
});
