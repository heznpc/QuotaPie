/** Finite local-only installed-client check. Never calls an inference endpoint. */
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCompactionProxy, type CompactionRequestEvent } from "../src/codex-compaction";
const binary = process.env.CODEX_OWNERSHIP_PROBE_BINARY ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const directory = mkdtempSync(join(tmpdir(), "quotapie-ownership-"));
const foreign = "11111111-2222-4333-8444-555555555555";
const results = [];
for (const scenario of ["normal", "foreign", "late-foreign", "missing"] as const) {
  const cwd = join(directory, scenario); mkdirSync(cwd);
  const home = join(cwd, "home"); mkdirSync(home);
  const marker = join(cwd, "marker.txt");
  const events: CompactionRequestEvent[] = [];
  let requests = 0;
  const proxy = startCompactionProxy({ onRequest: e => events.push(e), fetchUpstream: async (_url, init) => {
    // This injected transport returns only in-memory fixtures. No fetch fallback.
    if (++requests > 3) throw new Error("Local fixture request budget exceeded");
    const h = new Headers(init.headers);
    const metadata = JSON.parse(h.get("x-codex-turn-metadata") ?? "{}");
    const turn = h.get("x-codex-turn-id") ?? metadata.turn_id;
    if (!turn) throw new Error("Installed client did not supply current turn identity");
    const first = requests === 1;
    const rid = "resp_fixture_" + requests;
    const item = first ? { type: "custom_tool_call", id: "ctc_fixture", call_id: "call_fixture", name: "exec",
      input: 'text(await tools.exec_command({cmd:"printf verified > marker.txt",max_output_tokens:100}));',
      ...(scenario === "missing" ? {} : { internal_chat_message_metadata_passthrough: { turn_id: scenario === "normal" ? turn : foreign } }) }
      : { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "Local fixture finished." }] };
    const added = scenario === "late-foreign" && first ? { ...item, internal_chat_message_metadata_passthrough: undefined } : item;
    const frames = [ { type: "response.created", response: { id: rid, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: added },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: rid, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } ];
    const bytes = new TextEncoder().encode(frames.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    let offset = 0;
    return new Response(new ReadableStream({ pull(c) {
      if (offset >= bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(offset, offset + 13)); offset += 13;
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const child = Bun.spawn([binary, "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "-C", cwd,
      "-s", "workspace-write", "-m", "gpt-6-astra", "-c", 'model_provider="fixture"', "-c",
      `model_providers.fixture={name="Local fixture",base_url=${JSON.stringify(proxy.baseUrl)},wire_api="responses",requires_openai_auth=false,stream_max_retries=0,request_max_retries=0}`,
      "--json", "Local offline fixture: run the supplied marker command once and finish."],
      { env: { ...process.env, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 25_000);
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    clearTimeout(timer);
    const executed = existsSync(marker) && readFileSync(marker, "utf8") === "verified";
    const blocked = events.some(e => e.errorCode === "response_ownership_mismatch");
    const expected = scenario === "normal" || scenario === "missing";
    const commandEvents = stdout.split("\n").filter(line => line.includes('"type":"command_execution"')).length;
    const ok = executed === expected && (expected ? exitCode === 0 : blocked && commandEvents === 0) && requests <= 3;
    results.push({ scenario, ok, executed, commandEvents, blocked, requests, exitCode,
      // Only booleans, never raw client logs, tool content, or private IDs.
      clientReportedOwnershipError: (stdout + stderr).includes("blocked an invalid or foreign") });
  } finally { proxy.stop(); }
}
console.log(JSON.stringify({ localOnly: true, results }, null, 2));
if (results.some(r => !r.ok)) process.exitCode = 1;
