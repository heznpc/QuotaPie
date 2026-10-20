import { expect, test } from "bun:test";
import { requestContext } from "../src/request-context";
import { parseCompactionRequestEvent } from "../packages/quota-core/src/events";

test("context evidence counts repeated instructions and tool results without persisting content or altering history", () => {
  const instruction = { role: "developer", content: "private instruction" };
  const body = { model: "gpt-6-astra", instructions: "private policy", tools: [{ name: "private-tool" }],
    input: [instruction, { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,secret" }] },
      { type: "function_call_output", call_id: "call", output: "private output" }, { ...instruction }] };
  const original = JSON.stringify(body);
  const evidence = requestContext(body);
  expect(evidence.bytes).toBe(Buffer.byteLength(original));
  expect(evidence.items).toBe(4);
  expect(evidence.duplicateInstructionBytes).toBe(Buffer.byteLength(JSON.stringify(instruction.content)));
  expect(evidence.toolResultsBytes).toBeGreaterThan(0);
  expect(evidence.imageBytes).toBeGreaterThan(0);
  expect(JSON.stringify(evidence)).not.toMatch(/private|secret|gpt/);
  expect(JSON.stringify(body)).toBe(original);
  const event = { requestId: "11111111-1111-4111-8111-111111111111", kind: "response",
    from: body.model, to: body.model, at: new Date().toISOString(), phase: "completed", durationMs: 1,
    requestContext: { ...evidence, unexpected: "secret" } };
  expect(parseCompactionRequestEvent(event)?.requestContext).toEqual(evidence);
  expect(parseCompactionRequestEvent({ ...event, requestContext: { ...evidence, bytes: -1 } })?.requestContext).toBeUndefined();
});
