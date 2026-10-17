import { createHmac, randomBytes } from "node:crypto";

// Process-local key permits cross-stream correlation without recording content or
// reusable hashes of low-entropy text. A restart intentionally rotates the key.
const key = randomBytes(32);
const digest = (value: string | Uint8Array) => createHmac("sha256", key).update(value).digest("hex");
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export type OwnershipIdentity = { threadId: string | null; turnId: string | null };
export type OwnershipProvenance = {
  ordinal: number; bytes: number; digest: string;
  stage: "validated" | "queued" | "blocked";
  ownership: "matched" | "partial" | "unattributed";
  response: string | null; item: string | null;
  errorCode?: string;
};
export class ResponseOwnershipError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Each instance belongs to one HTTP request. Never consult history/root turn IDs:
 * steering uses the request's current turn; forks may legitimately retain parent
 * items in input, which is deliberately outside this output-only inspection. */
export class ResponseOwnershipGuard {
  private decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private pending = "";
  private cursor = 0;
  private frame = "";
  private data: string[] = [];
  private ordinal = 0;
  private responseId: string | null = null;
  private failed = false;
  private beginning = true;
  private jsonChunks: Uint8Array[] = [];
  private jsonBytes = 0;
  constructor(private identity: OwnershipIdentity,
    private provenance: (entry: OwnershipProvenance) => void = () => {},
    private maxBytes = 4 * 1024 * 1024,
    private format: "sse" | "json" = "sse") {}

  private report(entry: OwnershipProvenance) {
    try { this.provenance(entry); } catch { /* Telemetry must not affect delivery. */ }
  }
  private reject(code: string): never {
    const buffered = this.format === "json" ? Buffer.concat(this.jsonChunks) : this.frame + this.pending;
    if (this.last?.stage !== "blocked") this.report({ ordinal: ++this.ordinal,
      bytes: Buffer.byteLength(buffered),
      digest: digest(buffered), stage: "blocked", ownership: "unattributed",
      response: this.responseId ? digest(this.responseId) : null, item: null, errorCode: code });
    this.failed = true;
    throw new ResponseOwnershipError(code);
  }
  /** Deliver only complete, checked frames. The callback is the sole egress. */
  push(bytes: Uint8Array, deliver: (bytes: Uint8Array) => void, final = false): void {
    if (this.failed) this.reject("response_ownership_already_blocked");
    if (this.format === "json") {
      if (this.jsonBytes + bytes.byteLength > this.maxBytes) this.reject("response_ownership_body_too_large");
      this.jsonBytes += bytes.byteLength;
      this.jsonChunks.push(bytes.slice());
      return;
    }
    try { this.pending += this.decoder.decode(bytes, { stream: true }); }
    catch { this.reject("response_ownership_invalid_utf8"); }
    while (this.cursor < this.pending.length) {
      const c = this.pending[this.cursor];
      if (c !== "\r" && c !== "\n") { this.cursor++; continue; }
      if (c === "\r" && this.cursor + 1 === this.pending.length && !final) break;
      const end = this.cursor + (c === "\r" && this.pending[this.cursor + 1] === "\n" ? 2 : 1);
      let line = this.pending.slice(0, this.cursor);
      this.frame += this.pending.slice(0, end);
      this.pending = this.pending.slice(end); this.cursor = 0;
      if (this.beginning) { line = line.replace(/^\uFEFF/, ""); this.beginning = false; }
      if (Buffer.byteLength(this.frame) > this.maxBytes) this.reject("response_ownership_event_too_large");
      if (line === "") {
        const output = new TextEncoder().encode(this.frame);
        this.inspect(output, this.data.join("\n"));
        deliver(output);
        this.report({ ...this.last!, stage: "queued" });
        this.frame = ""; this.data = [];
      } else if (line.startsWith("data:")) this.data.push(line.slice(5).replace(/^ /, ""));
    }
    if (Buffer.byteLength(this.frame) + Buffer.byteLength(this.pending) > this.maxBytes)
      this.reject("response_ownership_event_too_large");
  }
  private last?: OwnershipProvenance;
  private inspect(bytes: Uint8Array, data: string): void {
    let matched = false, partial = false;
    let itemId: string | null = null;
    let failure: string | undefined;
    const expectedFields = Number(this.identity.turnId != null) + Number(this.identity.threadId != null);
    const check = (value: unknown): boolean => {
      if (!record(value)) return false;
      // Only protocol-owned metadata is attribution. Never scan tool arguments,
      // text, arbitrary user metadata, previous_response_id, or root_turn_id.
      const meta = value.internal_chat_message_metadata_passthrough;
      if (!record(meta)) return false;
      const fields = new Set<string>();
      for (const [field, expected] of [["turn_id", this.identity.turnId], ["thread_id", this.identity.threadId], ["session_id", this.identity.threadId]] as const) {
        if (expected && meta[field] != null) {
          if (typeof meta[field] !== "string" || (meta[field] as string).toLowerCase() !== expected.toLowerCase()) failure = "response_ownership_mismatch";
          else fields.add(field === "session_id" ? "thread_id" : field);
        }
      }
      partial ||= fields.size > 0;
      return expectedFields > 0 && fields.size === expectedFields;
    };
    if (data && data !== "[DONE]") {
      let value: unknown;
      try { value = JSON.parse(data); } catch { failure = "response_ownership_invalid_json"; }
      if (record(value)) {
        matched = check(value);
        const response = record(value.response) ? value.response : this.format === "json" ? value : null;
        for (const id of [response?.id, value.response_id]) if (typeof id === "string") {
          if (this.responseId && this.responseId !== id) failure = "response_ownership_response_changed";
          else this.responseId = id;
        }
        const responseMatched = check(response);
        const errorMatched = check(value.error);
        const responseErrorMatched = check(response?.error);
        matched ||= responseMatched || errorMatched || responseErrorMatched;
        const outputMatches: boolean[] = [];
        if (record(value.item)) {
          outputMatches.push(check(value.item));
          if (typeof value.item.id === "string") itemId = value.item.id;
        }
        if (typeof value.item_id === "string") itemId = value.item_id;
        if (response && Array.isArray(response.output)) for (const item of response.output) outputMatches.push(check(item));
        // One attributed item cannot vouch for other, unattributed output in the
        // same event. Envelope attribution covers the event; otherwise every
        // output object needs the full identity known to this request.
        matched ||= outputMatches.length > 0 && outputMatches.every(Boolean);
      }
    } else if (this.format === "json") failure = "response_ownership_invalid_json";
    this.last = { ordinal: ++this.ordinal, bytes: bytes.length, digest: digest(bytes),
      stage: failure ? "blocked" : "validated", ownership: !failure && matched ? "matched" : partial ? "partial" : "unattributed",
      response: this.responseId ? digest(this.responseId) : null, item: itemId ? digest(itemId) : null,
      ...(failure ? { errorCode: failure } : {}) };
    this.report(this.last);
    if (failure) this.reject(failure);
  }
  finish(deliver: (bytes: Uint8Array) => void): void {
    if (this.format === "json") {
      if (this.failed) this.reject("response_ownership_already_blocked");
      const output = Buffer.concat(this.jsonChunks);
      let data: string;
      try { data = new TextDecoder("utf-8", { fatal: true }).decode(output); }
      catch { this.reject("response_ownership_invalid_utf8"); }
      this.inspect(output, data!);
      deliver(output);
      this.report({ ...this.last!, stage: "queued" });
      this.jsonChunks = [];
      return;
    }
    try { this.decoder.decode(); } catch { this.reject("response_ownership_invalid_utf8"); }
    // Flush a terminal CR as its actual one-byte line ending.
    this.push(new Uint8Array(), deliver, true);
    if (this.pending || this.frame) this.reject("response_ownership_truncated_event");
  }
}
