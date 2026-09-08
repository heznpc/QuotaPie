import { describe, expect, test } from "bun:test";
import { mergedAwakeHooks } from "../src/awake";

describe("power hook connections", () => {
  test("connect and disconnect preserve unrelated hooks and settings", () => {
    const original = { model: "keep", hooks: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "other-hook" }] }] } };
    const command = "/usr/bin/python3 '/safe/quotapie-awake-hook.py' codex '/profile'";
    const connected = mergedAwakeHooks(original, "codex", command, true);
    const again = mergedAwakeHooks(connected, "codex", command, true);
    expect(again).toEqual(connected);
    expect(connected.hooks!.Stop!.length).toBe(2);
    expect(connected.hooks!.Interrupt!.length).toBe(1);
    const disconnected = mergedAwakeHooks(connected, "codex", command, false);
    expect(disconnected.model).toBe("keep");
    expect(disconnected.hooks!.Stop).toEqual(original.hooks.Stop);
    expect(original.hooks.Stop.length).toBe(1);
  });
  test("Claude does not receive Codex-only events", () => {
    const c = mergedAwakeHooks({}, "claude", "quotapie-awake-hook.py", true);
    expect(c.hooks!.Interrupt).toBeUndefined();
    expect(c.hooks!.PermissionRequest).toHaveLength(1);
  });
  test("reject malformed existing hooks rather than overwrite them", () => {
    expect(() => mergedAwakeHooks(null as never, "codex", "x", true)).toThrow();
    expect(() => mergedAwakeHooks({ hooks: [] as never }, "codex", "x", true)).toThrow();
    expect(() => mergedAwakeHooks({ hooks: { Stop: {} as never } }, "codex", "x", true)).toThrow();
  });
});

test("lifecycle bridge handles stop, wait, expiry, and account isolation without retaining text", async () => {
  const proc = Bun.spawn(["/usr/bin/python3", "-c", `
import importlib.util
spec=importlib.util.spec_from_file_location('hook','script/awake_hook.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p={'session_id':'example-session','hook_event_name':'UserPromptSubmit','prompt':'PRIVATE CONTENT'}
a=m.event_record('codex','/one',p,123,100)
b=m.event_record('codex','/two',p,123,100)
assert a[0] != b[0]
assert a[1]['working'] and a[1]['expiresAt']==1900
assert 'PRIVATE' not in str(a)
p['hook_event_name']='PermissionRequest'
assert not m.event_record('codex','/one',p,None,101)[1]['working']
p['hook_event_name']='PreToolUse';p['tool_name']='request_user_input'
assert not m.event_record('codex','/one',p,123,102)[1]['working']
p['hook_event_name']='Stop'
assert not m.event_record('codex','/one',p,None,103)[1]['working']
p['hook_event_name']='UserPromptSubmit'
assert m.event_record('codex','/one',p,None,104) is None
`], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(proc.stderr).text();
  expect(await proc.exited, error).toBe(0);
});
