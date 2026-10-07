/** Reviewable integration component. Not enabled in the production relay. */
export type Outcome = {
  phase: string; status: number; errorCode?: string; upstreamBytes?: number;
};
export function failureStage(e: Outcome): string | null {
  if (e.phase === "completed") return null;
  if (e.phase === "cancelled") return "client_disconnected"; // not proof of user intent
  if (e.status >= 400) return "upstream_http_error";
  if (e.status === 0) return "before_response_headers"; // not proof request was undelivered
  if (e.upstreamBytes === 0) return "empty_response";
  if (e.upstreamBytes === undefined) return "unknown_response_progress";
  return "partial_response"; // bytes queued do not prove client receipt/tool execution
}

/** Process-local, fail-closed fence. Never evict uncertain turns to make room.
 * Caller owns a single instance per relay, BEFORE account selection or fetching.
 * No TTL/reset API: reconciliation and a new turn are required after uncertainty.
 * Restart loses state; persistence is required before claiming cross-restart safety.
 */
export type Lease = { key: string; id: number };
export class TurnRecoveryFence {
  private serial = 0;
  private turns = new Map<string, { id: number; state: "active" | "blocked" }>();
  constructor(private readonly capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid capacity");
  }
  begin(threadId: string | null, turnId: string | null): { lease: Lease } | { response: Response } {
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    if (!threadId || !turnId || !uuid.test(threadId) || !uuid.test(turnId)) return this.reject("recovery_identity_required");
    const key = `${threadId.toLowerCase()}:${turnId.toLowerCase()}`;
    if (this.turns.has(key)) return this.reject("recovery_reconciliation_required");
    if (this.turns.size >= this.capacity) return this.reject("recovery_capacity_reached");
    const id = ++this.serial;
    this.turns.set(key, { id, state: "active" });
    return { lease: { key, id } };
  }
  finish(lease: Lease, outcome: Outcome): void {
    const {key,id} = lease;
    const current = this.turns.get(key);
    if (current?.state !== "active" || current.id !== id) return; // late success cannot clear a tombstone
    if (outcome.phase === "completed") this.turns.delete(key);
    else this.turns.set(key, { id, state: "blocked" });
  }
  private reject(code: string): { response: Response } {
    // Deliberately 400: 409/429/5xx may induce another client retry.
    return { response: Response.json({ error: {
      type: "invalid_request_error", code,
      message: "The previous response did not finish safely. Automatic replay is stopped. Check completed tool effects and saved results, then continue in a new turn without repeating those actions.",
    } }, { status: 400 }) };
  }
}
