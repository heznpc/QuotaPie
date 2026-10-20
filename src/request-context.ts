import { createHash } from "node:crypto";

/** Sizes, never prompt contents. Wire bytes are not token estimates. */
export interface RequestContext {
  bytes: number;
  instructionsBytes: number;
  toolsBytes: number;
  historyBytes: number;
  toolResultsBytes: number;
  imageBytes: number;
  items: number;
  duplicateInstructionBytes: number;
}

export function requestContext(body: Record<string, unknown>): RequestContext {
  const size = (v: unknown) => v == null ? 0 : Buffer.byteLength(JSON.stringify(v));
  const input = Array.isArray(body.input) ? body.input : [];
  const seen = new Set<string>();
  let toolResultsBytes = 0, imageBytes = 0, duplicateInstructionBytes = 0;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (["function_call_output", "custom_tool_call_output"].includes(item.type))
      toolResultsBytes += size(item.output);
    if (["developer", "system"].includes(item.role)) {
      const content = JSON.stringify(item.content) ?? "null";
      const digest = createHash("sha256").update(item.role + ":" + content).digest("hex");
      if (seen.has(digest)) duplicateInstructionBytes += Buffer.byteLength(content);
      seen.add(digest);
    }
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type === "input_image") imageBytes += size(part);
    }
  }
  return { bytes: size(body), instructionsBytes: size(body.instructions), toolsBytes: size(body.tools),
    historyBytes: size(body.input), toolResultsBytes, imageBytes, items: input.length, duplicateInstructionBytes };
}
