type ForkClaim = { status: "absent" } | { status: "invalid" } | { status: "claimed"; parentId: string };

function protocolId(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}

// Request metadata is a claim, not a durable account binding. Keep parsing
// bounded and never expose the rest (workspace paths, instructions, etc.).
export function codexRequestIdentity(headers: Headers): { threadId: string | null; turnId: string | null; fork: ForkClaim } {
  let metadata: Record<string, unknown> = {}, malformed = false;
  const raw = headers.get("x-codex-turn-metadata");
  if (raw) {
    try {
      const value: unknown = raw.length <= 4096 ? JSON.parse(raw) : null;
      if (!value || typeof value !== "object" || Array.isArray(value)) malformed = true;
      else metadata = value as Record<string, unknown>;
    } catch { malformed = true; }
  }
  // Modern forks can share their root's session-id. The thread is the binding
  // key; session headers are only a fallback for older clients.
  const threadId = protocolId(headers.get("thread-id")) ?? protocolId(metadata.thread_id)
    ?? protocolId(headers.get("session_id")) ?? protocolId(headers.get("session-id"));
  const turnId = protocolId(headers.get("x-codex-turn-id")) ?? protocolId(metadata.turn_id);
  let fork: ForkClaim = malformed ? { status: "invalid" } : { status: "absent" };
  if (Object.hasOwn(metadata, "forked_from_thread_id")) {
    const parentId = protocolId(metadata.forked_from_thread_id);
    const headerThread = headers.get("thread-id");
    fork = parentId && threadId && parentId !== threadId && protocolId(metadata.thread_id) === threadId
      && (headerThread === null || protocolId(headerThread) === threadId)
      ? { status: "claimed", parentId } : { status: "invalid" };
  }
  return { threadId, turnId, fork };
}
