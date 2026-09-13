import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { executeJobStep, type JobStepInput } from "../src/jobs/executor";

const SESSION = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const OTHER_SESSION = "0199a213-81c0-7800-8aa1-bbab2a035a54";
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(script: string, provider: "codex" | "claude" = "codex"): JobStepInput {
  const directory = mkdtempSync(join(tmpdir(), "quotapie-job-executor-"));
  directories.push(directory);
  const executable = join(directory, provider);
  writeFileSync(executable, `#!${process.execPath}
const emit = (value) => console.log(JSON.stringify(value));
const prompt = await Bun.stdin.text();
const session = ${JSON.stringify(SESSION)};
${script}
`);
  chmodSync(executable, 0o700);
  return { provider, executable, profileRoot: directory, cwd: directory, prompt: "Finish the saved step.", timeoutMs: 3000 };
}

const codexStart = `emit({type:"thread.started",thread_id:session}); emit({type:"turn.started"});`;
const codexSuccess = `${codexStart}
emit({type:"item.completed",item:{type:"agent_message",text:"완료했습니다."}});
emit({type:"turn.completed"});`;
const claudeSuccess = `emit({type:"system",subtype:"init",session_id:session});
emit({type:"result",subtype:"success",is_error:false,result:"Done",session_id:session});`;

describe("managed job provider execution", () => {
  test("Codex requires a complete turn and preserves its native session", async () => {
    expect(await executeJobStep(fixture(codexSuccess))).toEqual({
      kind: "succeeded", reason: "completed", output: "완료했습니다.", sessionId: SESSION,
    });
  });

  test("passes prompt only on stdin, fixes sandbox, and isolates provider credentials", async () => {
    const sensitive = ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "AWS_ACCESS_KEY_ID", "CUSTOM_PROVIDER_KEY", "NODE_OPTIONS",
      "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"];
    const original = new Map(sensitive.map(key => [key, process.env[key]]));
    try {
      for (const key of sensitive) process.env[key] = "must-not-reach-child";
      const input = fixture(`${codexStart}
const details = {args:process.argv.slice(2),prompt,profile:process.env.CODEX_HOME,
  inherited:${JSON.stringify(sensitive)}.filter(key => process.env[key] !== undefined)};
emit({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(details)}});
emit({type:"turn.completed"});`);
      input.prompt = "Write literal $(touch never-created) ; `id` and new\nline";
      input.model = "gpt-6-astra";
      const result = await executeJobStep(input);
      expect(result.kind).toBe("succeeded");
      const details = JSON.parse(result.output!);
      expect(details).toEqual({
        args: ["exec", "--sandbox", "workspace-write", "--json", "--model", "gpt-6-astra", "-"],
        prompt: input.prompt, profile: input.profileRoot, inherited: [],
      });
      expect(existsSync(join(input.cwd, "never-created"))).toBeFalse();
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test("Codex resumes the exact UUID with parent sandbox option", async () => {
    const input = fixture(`${codexStart}
emit({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(process.argv.slice(2))}});
emit({type:"turn.completed"});`);
    input.sessionId = SESSION;
    expect(JSON.parse((await executeJobStep(input)).output!)).toEqual([
      "exec", "--sandbox", "workspace-write", "resume", SESSION, "--json", "-",
    ]);
  });

  test("Claude uses stream JSON, default permissions and one selected profile", async () => {
    const input = fixture(`emit({type:"result",subtype:"success",is_error:false,session_id:session,
result:JSON.stringify({args:process.argv.slice(2),prompt,profile:process.env.CLAUDE_CONFIG_DIR,codexHome:process.env.CODEX_HOME??null})});`, "claude");
    input.sessionId = SESSION;
    const result = await executeJobStep(input);
    expect(result.kind).toBe("succeeded");
    expect(JSON.parse(result.output!)).toEqual({
      args: ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--resume", SESSION],
      prompt: input.prompt, profile: input.profileRoot, codexHome: null,
    });
  });

  test("accepts Claude's final success result", async () => {
    expect(await executeJobStep(fixture(claudeSuccess, "claude"))).toEqual({
      kind: "succeeded", reason: "completed", output: "Done", sessionId: SESSION,
    });
  });

  test("Claude's default profile retains native login without inherited credential namespace overrides", async () => {
    const keys = ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"];
    const original = new Map(keys.map(key => [key, process.env[key]]));
    try {
      for (const key of keys) process.env[key] = "unrelated-profile-override";
      const input = fixture(`emit({type:"result",subtype:"success",is_error:false,session_id:session,
result:JSON.stringify(${JSON.stringify(keys)}.filter(key=>process.env[key]!==undefined))});`, "claude");
      input.profileRoot = join(homedir(), ".claude");
      const result = await executeJobStep(input);
      expect(result.kind).toBe("succeeded");
      expect(JSON.parse(result.output!)).toEqual([]);
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  test("exit zero alone and an agent message without turn completion stay uncertain", async () => {
    for (const script of ["", codexStart,
      `${codexStart} emit({type:"item.completed",item:{type:"agent_message",text:"Working"}});`,
      `${codexStart} emit({type:"turn.completed"});`]) {
      expect((await executeJobStep(fixture(script))).kind).toBe("uncertain");
    }
  });

  test("a successful event followed by nonzero exit is not a completed checkpoint", async () => {
    const result = await executeJobStep(fixture(`${codexSuccess} process.exitCode=2;`));
    expect(result.kind).toBe("uncertain");
    expect(result.sessionId).toBe(SESSION);
  });

  test("structured quota errors retain session and provider retry time", async () => {
    const retryAtMs = Date.now() + 60_000;
    const result = await executeJobStep(fixture(`${codexStart}
emit({type:"turn.failed",error:{code:"usage_limit_reached",retry_at_ms:${retryAtMs}}}); process.exitCode=1;`));
    expect(result).toEqual({ kind: "quota", reason: "provider-quota", sessionId: SESSION, retryAtMs });
  });

  test("HTTP 429 in the structured failure envelope is quota, an unknown retry date is ignored", async () => {
    const result = await executeJobStep(fixture(`${codexStart}
emit({type:"turn.failed",error:{status_code:429,reset_at:"not a date"}});`));
    expect(result).toEqual({ kind: "quota", reason: "provider-quota", sessionId: SESSION });
  });

  test("overload, capacity, retry requests and bare 429 messages are not quota evidence", async () => {
    const result = await executeJobStep(fixture(`${codexStart}
emit({type:"turn.failed",error:{code:"server_error",message:"capacity overloaded, try again: 429 quota exceeded secret-token"}});
console.error("Authorization: Bearer secret-token");`));
    expect(result.kind).toBe("uncertain");
    expect(result.reason).toBe("provider-turn-failed");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("tool output cannot masquerade as a provider quota error", async () => {
    const result = await executeJobStep(fixture(`${codexStart}
emit({type:"item.completed",item:{type:"command_execution",output:{error:{code:"rate_limit_error"}},exit_code:429}});
emit({type:"turn.failed",error:{message:"tool failed"}});`));
    expect(result.kind).toBe("uncertain");
  });

  test("reports the explicit Codex CLI upgrade requirement without retaining raw error detail", async () => {
    const message = JSON.stringify({ detail: "The 'gpt-5.6-luna' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." });
    for (const event of [{ type: "error", message }, { type: "turn.failed", error: { message } }]) {
      const result = await executeJobStep(fixture(`${codexStart}
emit(${JSON.stringify(event)}); process.exitCode=1;`));
      expect(result).toEqual({ kind: "uncertain", reason: "cli-update-required", sessionId: SESSION });
      expect(JSON.stringify(result)).not.toContain("gpt-5.6-luna");
    }
  });

  test("a recovered transient quota event does not override final success", async () => {
    const result = await executeJobStep(fixture(`${codexStart}
emit({type:"error",error:{code:"rate_limit_exceeded"}});
emit({type:"item.completed",item:{type:"agent_message",text:"Recovered"}});
emit({type:"turn.completed"});`));
    expect(result.kind).toBe("succeeded");
    expect(result.retryAtMs).toBeUndefined();
  });

  test("Claude structured rate-limit failure is a pause", async () => {
    const result = await executeJobStep(fixture(`emit({type:"system",subtype:"init",session_id:session});
emit({type:"assistant",error:"rate_limit",message:{content:[]}});
emit({type:"result",subtype:"error_during_execution",is_error:true,session_id:session,errors:["request failed"]});`, "claude"));
    expect(result).toEqual({ kind: "quota", reason: "provider-quota", sessionId: SESSION });
  });

  test("Claude's result with is_error true cannot complete even with success subtype", async () => {
    const result = await executeJobStep(fixture(`emit({type:"result",subtype:"success",is_error:true,result:"No",session_id:session});`, "claude"));
    expect(result.kind).toBe("uncertain");
  });

  test("Claude authentication refusal has an actionable reason without retaining its raw message", async () => {
    for (const status of [false, true]) {
      const result = await executeJobStep(fixture(`emit({type:"system",subtype:"init",session_id:session});
${status ? "" : 'emit({type:"assistant",error:"authentication_failed",message:{content:[{type:"text",text:"Not logged in · Please run /login"}]}});'}
emit({type:"result",subtype:"success",is_error:true,session_id:session,result:"Not logged in · Please run /login"${status ? ",api_error_status:401" : ""}});`, "claude"));
      expect(result).toEqual({ kind: "uncertain", reason: "auth-required", sessionId: SESSION });
      expect(JSON.stringify(result)).not.toContain("Not logged in");
    }
  });

  test("Claude permission denials remain reviewable instead of completing the step", async () => {
    const result = await executeJobStep(fixture(`emit({type:"result",subtype:"success",is_error:false,result:"Could not edit",session_id:session,
permission_denials:[{tool_name:"Edit"}]});`, "claude"));
    expect(result).toEqual({ kind: "uncertain", reason: "permission-required", sessionId: SESSION });
  });

  test("Claude's structured organization access refusal is distinct from missing login", async () => {
    const result = await executeJobStep(fixture(`emit({type:"system",subtype:"init",session_id:session});
emit({type:"assistant",error:"oauth_org_not_allowed",message:{content:[{type:"text",text:"Your organization has disabled Claude subscription access for Claude Code"}]}});
emit({type:"result",subtype:"success",is_error:true,session_id:session,result:"Your organization has disabled Claude subscription access for Claude Code"});`, "claude"));
    expect(result).toEqual({ kind: "uncertain", reason: "provider-access-denied", sessionId: SESSION });
    expect(JSON.stringify(result)).not.toContain("Your organization");
  });

  test("Claude's deferred tools and background results cannot complete the submitted step", async () => {
    for (const extra of ['stop_reason:"tool_deferred"', 'origin:{kind:"task-notification"}', 'parent_tool_use_id:"child"']) {
      const result = await executeJobStep(fixture(`emit({type:"result",subtype:"success",is_error:false,result:"Done",session_id:session,${extra}});`, "claude"));
      expect(result.kind).toBe("uncertain");
    }
  });

  test("malformed JSON blocks completion even if a later success exists", async () => {
    const result = await executeJobStep(fixture(`console.log("invalid event"); ${codexSuccess}`));
    expect(result.reason).toBe("invalid-event-stream");
    expect(result.kind).toBe("uncertain");
  });

  test("a resumed provider must not silently switch native sessions", async () => {
    const input = fixture(codexSuccess);
    input.sessionId = OTHER_SESSION;
    const result = await executeJobStep(input);
    expect(result.reason).toBe("session-mismatch");
    expect(result.kind).toBe("uncertain");
    expect(result.sessionId).toBe(OTHER_SESSION);
  });

  test("supports a UTF-8 final event without trailing newline", async () => {
    const result = await executeJobStep(fixture(`${codexStart}
const bytes=Buffer.from(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"일본어 日本語"}})+"\\n"+JSON.stringify({type:"turn.completed"}));
for(const byte of bytes) process.stdout.write(Buffer.from([byte]));`));
    expect(result.kind).toBe("succeeded");
    expect(result.output).toBe("일본어 日本語");
  });

  test("aborting before execution never starts a provider", async () => {
    const controller = new AbortController();
    controller.abort();
    const input = fixture(`await Bun.write("unexpected-start", "started");`);
    input.signal = controller.signal;
    expect((await executeJobStep(input)).reason).toBe("aborted-before-start");
    expect(existsSync(join(input.cwd, "unexpected-start"))).toBeFalse();
  });

  test("timeout kills only the owned child and preserves its session for inspection", async () => {
    const input = fixture(`${codexStart} await Bun.write("child-pid",String(process.pid)); setInterval(()=>{},1000);`);
    input.timeoutMs = 1000;
    const result = await executeJobStep(input);
    expect(result).toEqual({ kind: "uncertain", reason: "timeout", sessionId: SESSION });
    const pid = Number(readFileSync(join(input.cwd, "child-pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  test("abort after a native session starts preserves the session and remains uncertain", async () => {
    const controller = new AbortController();
    const input = fixture(`${codexStart} await Bun.write("started", "yes"); setInterval(()=>{},1000);`);
    input.signal = controller.signal;
    const execution = executeJobStep(input);
    for (let i = 0; i < 100 && !existsSync(join(input.cwd, "started")); i++) await Bun.sleep(10);
    controller.abort();
    expect(await execution).toEqual({ kind: "uncertain", reason: "aborted", sessionId: SESSION });
  });

  test("escalates an uncooperative owned child after timeout", async () => {
    const input = fixture(`${codexStart} process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);`);
    input.timeoutMs = 1000;
    expect((await executeJobStep(input)).reason).toBe("timeout");
  });

  test("stdout has a strict total byte budget", async () => {
    const input = fixture(`${codexStart} process.stdout.write("x".repeat(2*1024*1024+1)); setInterval(()=>{},1000);`);
    const result = await executeJobStep(input);
    expect(result.kind).toBe("uncertain");
    expect(result.reason).toBe("stdout-limit");
    expect(result.output).toBeUndefined();
  });

  test("stderr is discarded and bounded", async () => {
    const result = await executeJobStep(fixture(`${codexStart} process.stderr.write("secret".repeat(50000)); setInterval(()=>{},1000);`));
    expect(result.kind).toBe("uncertain");
    expect(result.reason).toBe("stderr-limit");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("launch failure is safe to retry and exposes no raw diagnostic", async () => {
    const input = fixture(codexSuccess);
    input.executable = join(input.cwd, "missing", "codex");
    expect(await executeJobStep(input)).toEqual({ kind: "failed", reason: "process-start-failed" });
  });

  test("rejects executable/provider confusion, option injection and invalid resume identifiers", async () => {
    const input = fixture(codexSuccess);
    for (const change of [{ executable: "sh" }, { executable: "./codex" }, { provider: "claude" as const },
      { model: "--dangerously-bypass-approvals-and-sandbox" }, { sessionId: "--last" },
      { profileRoot: "relative" }, { cwd: "relative" }, { timeoutMs: NaN }]) {
      expect(await executeJobStep({ ...input, ...change })).toEqual({ kind: "failed", reason: "invalid-arguments" });
    }
  });
});
