import { object } from "./codex-compaction-policy";

export type Completion = { phase: "completed" | "failed" | "unverified"; errorCode?: string };
const MAX_EVENT_CHARS = 4 * 1024 * 1024;

/** Observe protocol completion without changing bytes or retaining conversation text. */
export class ResponseCompletionObserver {
  private decoder = new TextDecoder();
  private pending = "";
  private data: string[] = [];
  private dataLength = 0;
  private dropping = false;
  private completed = false;
  private failed = false;
  private oversized = false;
  private readonly sse: boolean;

  constructor(private contentType: string, private compaction: boolean) {
    this.sse = contentType.includes("text/event-stream");
  }

  push(bytes: Uint8Array): void {
    this.accept(this.decoder.decode(bytes, { stream: true }));
  }

  private accept(text: string): void {
    if (!this.sse) {
      if (this.pending.length + text.length > MAX_EVENT_CHARS) {
        this.oversized = true; this.pending = "";
      } else if (!this.oversized) this.pending += text;
      return;
    }
    // Parse lines, including CRLF split across transport chunks. Bound both an
    // unfinished line and a multiline event; oversized payloads still pass through.
    this.pending += text;
    let index: number;
    while ((index = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, index).replace(/\r$/, "");
      this.pending = this.pending.slice(index + 1);
      if (line === "") {
        if (!this.dropping) this.inspect(this.data.join("\n"));
        this.data = []; this.dataLength = 0; this.dropping = false;
      } else if (!this.dropping && line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        this.dataLength += value.length;
        if (this.dataLength > MAX_EVENT_CHARS) {
          this.oversized = true; this.dropping = true; this.data = [];
        } else this.data.push(value);
      }
    }
    if (this.pending.length > MAX_EVENT_CHARS) {
      this.pending = ""; this.data = []; this.dropping = true; this.oversized = true;
    }
  }

  private inspect(data: string): void {
    if (!data || data === "[DONE]") return;
    try {
      const event: unknown = JSON.parse(data);
      if (!object(event)) return;
      if (["error", "response.failed", "response.incomplete"].includes(String(event.type))) this.failed = true;
      if (event.type === "response.completed") {
        const status = object(event.response) ? event.response.status : undefined;
        if (status !== undefined && status !== "completed") this.failed = true;
        else this.completed = true;
      }
    } catch { /* Payloads are forwarded unchanged; never log their contents. */ }
  }

  terminal(): Completion | null {
    if (this.failed) return { phase: "failed", errorCode: "provider_stream_error" };
    return this.completed ? { phase: "completed" } : null;
  }

  finish(): Completion {
    this.accept(this.decoder.decode());
    if (this.sse) {
      // SSE dispatch requires a blank line. A truncated final event is not success.
      const terminal = this.terminal();
      if (terminal) return terminal;
      return this.oversized
        ? { phase: "unverified", errorCode: "completion_event_too_large" }
        : { phase: "failed", errorCode: "missing_completion_event" };
    }
    if (!this.compaction) return { phase: "completed" };
    if (!this.oversized && this.contentType.includes("application/json")) {
      try {
        const result: unknown = JSON.parse(this.pending);
        if (object(result) && !result.error && Array.isArray(result.output) &&
          result.output.some(item => object(item) && ["compaction", "context_compaction"].includes(String(item.type)))) {
          return { phase: "completed" };
        }
      } catch { /* A truncated JSON response is not a completed compaction. */ }
    }
    return { phase: "unverified", errorCode: "unrecognized_compaction_response" };
  }
}
