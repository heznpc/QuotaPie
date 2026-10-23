import { expect, test } from "bun:test";
import { nativeExecutionHistory, portableReplay } from "../src/account-replay";

const agent = { type: "agent_message", id: "original-id", author: "/root/research", recipient: "/root",
  content: [{ type: "input_text", text: "Research complete" }, { type: "encrypted_content", encrypted_content: "original-ciphertext" }] };
for (const compacted of [false, true]) {
  const body = () => ({ input: [...(compacted ? [{ type: "compaction", encrypted_content: "original-compaction" }] : []),
    { role: "user", content: "Continue" }, structuredClone(agent)] });
  test(`native agent history is preserved with compaction ${compacted}`, () => {
    const original = body(), before = JSON.stringify(original);
    expect(nativeExecutionHistory(original)).toBe(true);
    expect(JSON.stringify(original)).toBe(before);
    expect(portableReplay(original)).toBeNull();
  });
  for (const invalid of [
    { ...agent, author: null }, { ...agent, recipient: "" }, { ...agent, content: [] },
    { ...agent, content: [{ type: "encrypted_content", encrypted_content: "" }] },
    { ...agent, content: [{ type: "unknown", text: "unknown" }] },
    { ...agent, content: [{ type: "input_text", text: "reference", file_id: "foreign-file" }] },
  ]) test(`native malformed agent is rejected with compaction ${compacted}: ${JSON.stringify(invalid)}`, () => {
    const original = body(); original.input[original.input.length - 1] = invalid as any;
    expect(nativeExecutionHistory(original)).toBe(false);
  });
}
test("agent messages cannot replace user history; cancelled calls do not invalidate native history", () => {
  expect(nativeExecutionHistory({ input: [agent] })).toBe(false);
  const body = { input: [{ role: "user", content: "Continue" }, agent,
    { type: "function_call", call_id: "cancelled", name: "tool", arguments: "{}" }] };
  expect(nativeExecutionHistory(body)).toBe(true);
  expect(portableReplay(body)).toBeNull();
});

for (const compacted of [false, true]) {
  test(`native compaction trigger preserves history with prior compaction ${compacted}`, () => {
    const body = { input: [
      ...(compacted ? [{ type: "compaction", encrypted_content: "original" }] : []),
      { role: "user", content: "Continue" },
      { type: "custom_tool_call", call_id: "cancelled", name: "tool", input: "original input" },
      { type: "compaction_trigger" },
    ] };
    const original = JSON.stringify(body);
    expect(nativeExecutionHistory(body)).toBe(true);
    expect(JSON.stringify(body)).toBe(original);
    expect(portableReplay(body)).toBeNull();
    expect(nativeExecutionHistory({ input: [body.input.at(-1), ...body.input.slice(0, -1)] })).toBe(false);
    expect(nativeExecutionHistory({ input: [...body.input, { type: "compaction_trigger" }] })).toBe(false);
    expect(nativeExecutionHistory({ input: [...body.input.slice(0, -1), { type: "compaction_trigger", file_id: "foreign" }] })).toBe(false);
  });
}
test("native history still rejects malformed calls and unknown items", () => {
  for (const item of [
    { type: "function_call", call_id: "bad", name: "tool", arguments: null },
    { type: "custom_tool_call", call_id: "bad", name: "tool", input: {} },
    { type: "function_call_output", call_id: "bad", output: null },
    { type: "unknown_control" },
  ]) expect(nativeExecutionHistory({ input: [{ role: "user", content: "Continue" }, item] })).toBe(false);
});
