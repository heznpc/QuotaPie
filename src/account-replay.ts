import { createHash } from "node:crypto";

const record = (v: any): v is Record<string, any> => v != null && typeof v === "object" && !Array.isArray(v);
export const reasoningFingerprint = (item: any) => createHash("sha256")
  .update(typeof item.encrypted_content === "string" ? item.encrypted_content : JSON.stringify(item)).digest("hex");

/** Only complete, portable HTTP history may cross an account boundary.
 * Original rollouts are untouched. Opaque compaction/file references cannot be
 * reconstructed here and are rejected, not silently dropped or summarized.
 */
export function portableReplay(body: unknown): { body: Record<string, any>; fingerprints: string[] } | null {
  if (!record(body) || body.previous_response_id || body.conversation || !Array.isArray(body.input)) return null;
  const calls = new Set<string>(), answered = new Set<string>(), fingerprints: string[] = [];
  let users = 0;
  const input: any[] = [];
  const partsOK = (value: any) => typeof value === "string" || Array.isArray(value) && value.every(p =>
    record(p) && ((["input_text", "output_text", "text"].includes(p.type) && typeof p.text === "string") ||
      (p.type === "input_image" && !p.file_id && typeof p.image_url === "string" && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image_url))));
  for (const item of body.input) {
    if (!record(item)) return null;
    if (item.type === "reasoning") { fingerprints.push(reasoningFingerprint(item)); continue; }
    if ((item.type == null || item.type === "message") && ["system", "developer", "user", "assistant"].includes(item.role)) {
      if (!partsOK(item.content)) return null;
      if (item.role === "user") users++;
    } else if (["function_call", "custom_tool_call"].includes(item.type)) {
      if (typeof item.call_id !== "string" || calls.has(item.call_id)) return null;
      calls.add(item.call_id);
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      if (!calls.has(item.call_id) || answered.has(item.call_id) || !partsOK(item.output)) return null;
      answered.add(item.call_id);
    } else if (!(item.type === "additional_tools" && item.role === "developer")) return null;
    // Response item IDs refer to the old account; call_id is the local tool pair.
    const { id: _id, ...portable } = item;
    input.push(portable);
  }
  if (!users || calls.size !== answered.size) return null;
  return { body: { ...body, input }, fingerprints };
}

export function filterForeignReasoning(body: unknown, fingerprints: string[] | undefined): unknown {
  if (!fingerprints || !record(body) || !Array.isArray(body.input)) return body;
  const foreign = new Set(fingerprints);
  const input = body.input.filter(item => !record(item) || item.type !== "reasoning" || !foreign.has(reasoningFingerprint(item)))
    .map(item => {
      if (!record(item) || item.type === "reasoning") return item;
      const { id: _id, ...portable } = item;
      return portable;
    });
  return { ...body, input };
}
