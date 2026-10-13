import { object } from "./codex-compaction-policy.js";
import { errorMessageDiagnostic, MAX_ERROR_MESSAGE_CHARS, providerErrorDiagnostic, providerEventRequestIds,
  type ServerErrorDiagnostic, type UpstreamRequestIds } from "./codex-error-diagnostics.js";

export type Completion = { phase: "completed" | "failed" | "unverified"; errorCode?: string };
const MAX_EVENT_CHARS = 4 * 1024 * 1024;

/** Observe protocol completion without changing bytes or retaining conversation text. */
export class ResponseCompletionObserver {
  private decoder = new TextDecoder();
  private pending = "";
  private data: string[] = [];
  private dataLength = 0;
  private eventType = "";
  private dropping = false;
  private completed = false;
  private failed = false;
  private oversized = false;
  private readonly sse: boolean;
  private errorBody = "";
  private errorBodyLength = 0;
  private bodyComplete = false;
  private observedError: ServerErrorDiagnostic | undefined;
  requestIds: UpstreamRequestIds | undefined;
  responseModel: string | null = null;
  usage: { input: number; cachedInput: number; output: number } | null = null;

  constructor(private contentType: string, private compaction: boolean, private httpStatus = 200) {
    this.sse = contentType.includes("text/event-stream");
  }

  push(bytes: Uint8Array): void {
    this.accept(this.decoder.decode(bytes, { stream: true }));
  }

  private accept(text: string): void {
    if (this.httpStatus >= 400) {
      this.errorBodyLength += text.length;
      this.errorBody += text.slice(0, Math.max(0, MAX_ERROR_MESSAGE_CHARS - this.errorBody.length));
    }
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
        if (!this.dropping) this.inspect(this.data.join("\n"), this.eventType);
        this.data = []; this.dataLength = 0; this.eventType = ""; this.dropping = false;
      } else if (!this.dropping && line.startsWith("event:")) {
        this.eventType = line.slice(6).trim().slice(0, 80);
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

  private inspect(data: string, eventType: string): void {
    if (!data || data === "[DONE]") return;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!object(parsed)) return;
      const event = typeof parsed.type === "string" ? parsed : { ...parsed, type: eventType };
      const eventIds = providerEventRequestIds(event);
      if (eventIds) this.requestIds = { ...this.requestIds, ...eventIds };
      if (["error", "response.failed", "response.incomplete"].includes(String(event.type))) {
        this.failed = true;
        this.observedError ??= providerErrorDiagnostic(event, "provider_sse");
      }
      if (object(event.response)) this.inspectResponse(event.response);
      if (event.type === "response.completed") {
        const status = object(event.response) ? event.response.status : undefined;
        if (status !== undefined && status !== "completed") {
          this.failed = true;
          this.observedError ??= providerErrorDiagnostic(event, "provider_sse");
        }
        else this.completed = true;
      }
    } catch {
      // Named SSE errors may carry non-JSON text (e.g. an upstream gateway).
      // Preserve failure classification and a bounded digest, never its body.
      if (["error", "response.failed", "response.incomplete"].includes(eventType)) {
        this.failed = true;
        this.observedError ??= { source: "provider_sse", eventType: eventType as ServerErrorDiagnostic["eventType"],
          ...errorMessageDiagnostic(data) };
        const eventIds = providerEventRequestIds({ message: data });
        if (eventIds) this.requestIds = { ...this.requestIds, ...eventIds };
      }
    }
  }

  private inspectResponse(response: Record<string, unknown>): void {
    if (typeof response.model === "string" && /^[a-z0-9_.-]{1,100}$/i.test(response.model)) this.responseModel = response.model;
    const usage = response.usage;
    if (object(usage)) {
      const input = usage.input_tokens, output = usage.output_tokens;
      const cached = object(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : 0;
      if ([input, output, cached].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) && (cached as number) <= (input as number)) {
        this.usage = { input: input as number, cachedInput: cached as number, output: output as number };
      }
    }
  }

  /** Sanitized metadata only. Raw diagnostics never cross this boundary. */
  get serverError(): ServerErrorDiagnostic | undefined {
    if (this.httpStatus < 400) return this.observedError;
    if (this.observedError) return { ...this.observedError, source: "provider_http", bodyComplete: this.bodyComplete };
    if (this.errorBodyLength <= MAX_ERROR_MESSAGE_CHARS) {
      try {
        const body: unknown = JSON.parse(this.errorBody);
        if (object(body)) {
          const eventIds = providerEventRequestIds(body);
          if (eventIds) this.requestIds = { ...this.requestIds, ...eventIds };
          return { ...providerErrorDiagnostic(body, "provider_http"), bodyComplete: this.bodyComplete };
        }
      } catch { /* Non-JSON/partial error pages get a bounded digest, not raw text. */ }
    }
    return { source: "provider_http", bodyComplete: this.bodyComplete,
      ...(this.errorBodyLength ? errorMessageDiagnostic(this.errorBody, this.errorBodyLength) : {}) };
  }

  terminal(): Completion | null {
    if (this.failed) return { phase: "failed", errorCode: "provider_stream_error" };
    return this.completed ? { phase: "completed" } : null;
  }

  finish(): Completion {
    this.accept(this.decoder.decode());
    this.bodyComplete = true;
    if (this.sse) {
      // SSE dispatch requires a blank line. A truncated final event is not success.
      const terminal = this.terminal();
      if (terminal) return terminal;
      return this.oversized
        ? { phase: "unverified", errorCode: "completion_event_too_large" }
        : { phase: "failed", errorCode: "missing_completion_event" };
    }
    if (!this.compaction) {
      if (!this.oversized && this.contentType.includes("application/json")) {
        try {
          const result: unknown = JSON.parse(this.pending);
          if (object(result)) {
            this.inspectResponse(result);
            const eventIds = providerEventRequestIds(result);
            if (eventIds) this.requestIds = { ...this.requestIds, ...eventIds };
            if (result.error || ["failed", "incomplete", "cancelled"].includes(String(result.status))) {
              this.observedError ??= providerErrorDiagnostic(result, "provider_json");
              return { phase: "failed", errorCode: "provider_response_error" };
            }
            if (result.status === "completed" && Array.isArray(result.output)) return { phase: "completed" };
          }
        } catch { /* Opaque or truncated bodies cannot establish completion. */ }
      }
      return { phase: "unverified", errorCode: "unrecognized_response" };
    }
    if (!this.oversized && this.contentType.includes("application/json")) {
      try {
        const result: unknown = JSON.parse(this.pending);
        if (object(result)) {
          this.inspectResponse(result);
          const eventIds = providerEventRequestIds(result);
          if (eventIds) this.requestIds = { ...this.requestIds, ...eventIds };
          if (result.error || ["failed", "incomplete", "cancelled"].includes(String(result.status))) {
            this.observedError ??= providerErrorDiagnostic(result, "provider_json");
            return { phase: "failed", errorCode: "provider_response_error" };
          }
        }
        if (object(result) && !result.error && Array.isArray(result.output) &&
          result.output.some(item => object(item) && ["compaction", "context_compaction"].includes(String(item.type)))) {
          return { phase: "completed" };
        }
      } catch { /* A truncated JSON response is not a completed compaction. */ }
    }
    return { phase: "unverified", errorCode: "unrecognized_compaction_response" };
  }
}
