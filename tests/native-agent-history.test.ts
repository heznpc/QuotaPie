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
test("agent messages cannot replace user history or satisfy missing tool results", () => {
  expect(nativeExecutionHistory({ input: [agent] })).toBe(false);
  expect(nativeExecutionHistory({ input: [{ role: "user", content: "Continue" }, agent,
    { type: "function_call", call_id: "pending", name: "tool", arguments: "{}" }] })).toBe(false);
});
