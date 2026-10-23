import { expect, test } from "bun:test";
import { nativeHistoryFailure, portableReplay } from "../src/account-replay";
import { nativeToolHistory } from "./fixtures/native-history";

for (const [index, item] of nativeToolHistory.entries()) {
  test(`native protocol item ${index}: ${item.type} is preserved without portable replay`, () => {
    for (const anchor of [{ role: "user", content: "Continue" }, { type: "compaction", encrypted_content: "original" }]) {
      const body = { input: [anchor, structuredClone(item)] }, original = JSON.stringify(body);
      expect(nativeHistoryFailure(body)).toBeNull();
      expect(JSON.stringify(body)).toBe(original);
      expect(portableReplay(body)).toBeNull();
      expect(nativeHistoryFailure({ input: [anchor, { ...item, file_id: "foreign-file" }] })).toBe("remote_reference");
    }
  });
}

test("native context compaction and legacy compaction alias can anchor history", () => {
  for (const type of ["context_compaction", "compaction_summary"]) {
    expect(nativeHistoryFailure({ input: [{ type, encrypted_content: "original" }] })).toBeNull();
    expect(nativeHistoryFailure({ input: [{ type }] })).not.toBeNull();
    expect(nativeHistoryFailure({ input: [{ type, encrypted_content: {} }] })).not.toBeNull();
  }
});

test("request metadata names are ordinary user strings, not provider handles", () => {
  const body = { input: [{ role: "user", content: "Continue" }], metadata: { file_id: "label", conversation: "label", image_url: "label" } };
  expect(nativeHistoryFailure(body)).toBeNull();
  for (const key of Object.keys(body.metadata)) expect(nativeHistoryFailure({ ...body, [key]: "foreign" })).toBe("remote_reference");
});

test("structured output schema property names do not imply provider resources", () => {
  const schema = { type: "object", properties: { file_id: { type: "string" }, conversation: { type: "object",
    properties: { image_url: { type: "string" }, container: { type: "string" } } } } };
  const body = { input: [{ role: "user", content: "Return structured output" }],
    text: { format: { type: "json_schema", name: "codex_output_schema", strict: true, schema } } };
  expect(nativeHistoryFailure(body)).toBeNull();
  expect(nativeHistoryFailure({ ...body, tools: [{ type: "file_search", vector_store_ids: ["foreign"] }] })).toBe("remote_reference");
});

test("native tool shape support retains malformed and actual remote-reference rejection", () => {
  const user = { role: "user", content: "Continue" };
  for (const item of [
    { type: "function_call_output", id: "fco_fixture", output: "missing name" },
    { type: "function_call_output", name: "tool", output: "missing id" },
    { type: "function_call_output", call_id: {}, id: "fco_fixture", name: "tool", output: "malformed call id" },
    { type: "function_call_output", call_id: "call", output: [{ type: "encrypted_content", encrypted_content: null }] },
    { type: "message", role: "assistant", content: [{ type: "encrypted_content", encrypted_content: "tool-only content" }] },
    { type: "local_shell_call", status: "completed", action: { type: "exec", command: "pwd" } },
    { type: "local_shell_call", status: "completed", action: { type: "exec", command: ["pwd"], env: { key: {} } } },
    { type: "tool_search_call", execution: "client" },
    { type: "tool_search_call", execution: "client", call_id: {}, arguments: {} },
    { type: "tool_search_output", status: "completed", execution: "client", tools: null },
    { type: "web_search_call", action: "search" },
    { type: "image_generation_call", status: "completed", result: null },
    { type: "context_compaction", encrypted_content: {} },
  ]) expect(nativeHistoryFailure({ input: [user, item] })).toBe("invalid_native_shape");
  for (const tool of [
    { type: "file_search", vector_store_ids: ["foreign"] },
    { type: "code_interpreter", container: "foreign" },
    { type: "namespace", tools: [{ type: "file_search" }] },
  ]) expect(nativeHistoryFailure({ input: [user, { type: "tool_search_output", status: "completed", execution: "server", tools: [tool] }] })).toBe("remote_reference");
});
