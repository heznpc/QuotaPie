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

/** Exact native history for a verified target lease or explicit local per-thread
 * account choice. The provider
 * accepts the original encrypted compaction across owned subscription accounts;
 * local file/response references still have no transferable ownership proof.
 * This validator never removes IDs, reasoning, compaction, or tool messages. */
export function nativeExecutionHistory(body: unknown): boolean {
  if (!record(body) || body.previous_response_id != null || body.conversation != null || !Array.isArray(body.input)) return false;
  const remoteReference = (value: any): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(remoteReference);
    if (["item_reference", "input_file", "input_audio", "input_video", "file_search", "code_interpreter"].includes(value.type)) return true;
    for (const [key, child] of Object.entries(value)) {
      // A local function's schema names parameters; it is not a provider file
      // handle. Other tool/namespace descriptors are still inspected recursively.
      if (["function","custom"].includes(value.type) && ["parameters","input_schema"].includes(key)) continue;
      if (["file_id","file_ids","file_url","audio_url","video_url","previous_response_id","conversation","vector_store_ids","container","container_id"].includes(key) && child != null) return true;
      if (key === "image_url" && (typeof child !== "string" || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(child))) return true;
      if (remoteReference(child)) return true;
    }
    return false;
  };
  if (remoteReference(body)) return false;
  for (const item of body.input) {
    if (!record(item)) return false;
    if (item.type === "compaction" && (typeof item.encrypted_content !== "string" || !item.encrypted_content)) return false;
  }
  const clear = body.input.filter(item => item.type !== "compaction");
  if (!body.input.some(item => item.type === "compaction")) return portableReplay(body) !== null;
  // The compaction can contain the user messages and call definitions preceding
  // these visible records. Validate native shapes without inventing or dropping
  // any messages; the target is independently authorized by a lease or manual choice.
  const contentOK = (value: any) => typeof value === "string" || Array.isArray(value) && value.every(part =>
    record(part) && (["input_text","output_text","text"].includes(part.type) && typeof part.text === "string" ||
      part.type === "input_image" && typeof part.image_url === "string"));
  return clear.every(item => {
    if (item.type === "reasoning") return true;
    if ((item.type == null || item.type === "message") && ["system","developer","user","assistant"].includes(item.role)) return contentOK(item.content);
    if (["function_call","custom_tool_call"].includes(item.type)) return typeof item.call_id === "string" && typeof item.name === "string" &&
      typeof (item.type === "function_call" ? item.arguments : item.input) === "string";
    if (["function_call_output","custom_tool_call_output"].includes(item.type)) return typeof item.call_id === "string" && contentOK(item.output);
    return item.type === "additional_tools" && item.role === "developer";
  });
}
