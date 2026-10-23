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
  return nativeHistoryFailure(body) === null;
}

/** Fixed diagnostic codes only: never include prompts, IDs or encrypted bytes. */
export type NativeHistoryFailure = "invalid_body" | "remote_reference" | "invalid_item" |
  "invalid_compaction" | "invalid_agent_message" | "missing_history" | "invalid_native_shape";

export function nativeHistoryFailure(body: unknown): NativeHistoryFailure | null {
  if (!record(body) || !Array.isArray(body.input)) return "invalid_body";
  if (body.previous_response_id != null || body.conversation != null) return "remote_reference";
  const remoteReference = (value: any): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(remoteReference);
    if (["item_reference", "input_file", "input_audio", "input_video", "file_search", "code_interpreter"].includes(value.type)) return true;
    for (const [key, child] of Object.entries(value)) {
      // A local function's schema names parameters; it is not a provider file
      // handle. Other tool/namespace descriptors are still inspected recursively.
      if (["function","custom"].includes(value.type) && ["parameters","input_schema"].includes(key)) continue;
      if (value.type === "json_schema" && key === "schema") continue;
      // Structured local tool arguments are data, just like the JSON string in
      // function_call.arguments. Parameter names are not provider references.
      if (value.type === "tool_search_call" && key === "arguments" ||
          value.type === "local_shell_call" && key === "action") continue;
      if (value === body && key === "metadata" && record(child) && Object.values(child).every(v => typeof v === "string")) continue;
      if (["file_id","file_ids","file_url","audio_url","video_url","previous_response_id","conversation","vector_store_ids","container","container_id"].includes(key) && child != null) return true;
      if (key === "image_url" && (typeof child !== "string" || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(child))) return true;
      if (remoteReference(child)) return true;
    }
    return false;
  };
  if (remoteReference(body)) return "remote_reference";
  for (const item of body.input) {
    if (!record(item)) return "invalid_item";
    if (["compaction", "compaction_summary"].includes(item.type) && (typeof item.encrypted_content !== "string" || !item.encrypted_content)) return "invalid_compaction";
  }
  // Native Codex histories include messages exchanged by agents. Preserve the
  // original records, including encrypted content, under the independently
  // authorized target. They are not portable replay or user/tool-call records.
  const agentMessageOK = (item: Record<string, any>): boolean =>
    [item.author, item.recipient].every(value => typeof value === "string" && value.length > 0) &&
    Array.isArray(item.content) && item.content.length > 0 && item.content.every((part: any) =>
      record(part) && (part.type === "input_text" && typeof part.text === "string" ||
        part.type === "encrypted_content" && typeof part.encrypted_content === "string" && part.encrypted_content.length > 0));
  if (body.input.some(item => item.type === "agent_message" && !agentMessageOK(item))) return "invalid_agent_message";
  if (!body.input.some(item => ["compaction", "compaction_summary"].includes(item.type) ||
      item.type === "context_compaction" && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0 ||
      (item.type == null || item.type === "message") && item.role === "user")) return "missing_history";
  // A verified lease or explicit account choice authorizes exact native history.
  // Interrupted tools can have no result, and earlier calls may be compacted.
  // Portable replay's complete-pair requirement is inappropriate here: validate
  // native shapes and remote references without rewriting or dropping records.
  const contentOK = (value: any, encrypted = false) => typeof value === "string" || Array.isArray(value) && value.every(part =>
    record(part) && (["input_text","output_text","text"].includes(part.type) && typeof part.text === "string" ||
      encrypted && part.type === "encrypted_content" && typeof part.encrypted_content === "string" && part.encrypted_content.length > 0 ||
      part.type === "input_image" && typeof part.image_url === "string"));
  const optionalString = (value: any) => value == null || typeof value === "string";
  const valid = body.input.every((item, index) => {
    if (["compaction", "compaction_summary"].includes(item.type)) return true;
    if (item.type === "context_compaction") return optionalString(item.encrypted_content);
    // Codex sends this final control on /responses for native compaction.
    // Classification already recognizes it; history admission must do so too.
    if (item.type === "compaction_trigger") return index === body.input.length - 1;
    if (item.type === "agent_message") return agentMessageOK(item);
    if (item.type === "reasoning") return true;
    if ((item.type == null || item.type === "message") && ["system","developer","user","assistant"].includes(item.role)) return contentOK(item.content);
    if (["function_call","custom_tool_call"].includes(item.type)) return typeof item.call_id === "string" && typeof item.name === "string" &&
      typeof (item.type === "function_call" ? item.arguments : item.input) === "string";
    if (["function_call_output","custom_tool_call_output"].includes(item.type)) {
      // Desktop-injected tool results can identify the tool by name/namespace
      // and response item ID without a local call_id (e.g. thread messages).
      const namedOutput = item.type === "function_call_output" && item.call_id == null &&
        typeof item.id === "string" && item.id.length > 0 && typeof item.name === "string" && item.name.length > 0 && optionalString(item.namespace);
      return (typeof item.call_id === "string" || namedOutput) && contentOK(item.output, true);
    }
    // These are durable ResponseItem variants in Codex's native history too.
    // Built-in tools do not necessarily use a local call_id/output pair.
    if (item.type === "tool_search_call") return optionalString(item.call_id) && optionalString(item.status) &&
      typeof item.execution === "string" && Object.hasOwn(item, "arguments");
    if (item.type === "tool_search_output") return optionalString(item.call_id) && typeof item.status === "string" &&
      typeof item.execution === "string" && Array.isArray(item.tools);
    if (item.type === "web_search_call") return optionalString(item.status) &&
      (item.action == null || record(item.action) && typeof item.action.type === "string");
    if (item.type === "image_generation_call") return typeof item.status === "string" &&
      typeof item.result === "string" && optionalString(item.revised_prompt);
    if (item.type === "local_shell_call") {
      const action = item.action;
      return optionalString(item.call_id) && ["completed", "in_progress", "incomplete"].includes(item.status) &&
        record(action) && action.type === "exec" && Array.isArray(action.command) && action.command.every((arg: any) => typeof arg === "string") &&
        (action.timeout_ms == null || Number.isSafeInteger(action.timeout_ms) && action.timeout_ms >= 0) &&
        optionalString(action.working_directory) && optionalString(action.user) &&
        (action.env == null || record(action.env) && Object.values(action.env).every(v => typeof v === "string"));
    }
    return item.type === "additional_tools" && item.role === "developer";
  });
  return valid ? null : "invalid_native_shape";
}
