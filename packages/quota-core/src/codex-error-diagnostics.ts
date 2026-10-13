import { createHash } from "node:crypto";
import { object } from "./codex-compaction-policy.js";

// Error bodies may echo prompts, account details, credentials or URLs. Persist
// only explicit identifiers and known classifications, never arbitrary text.
export const MAX_ERROR_MESSAGE_CHARS = 16 * 1024;
export type UpstreamRequestIds = Partial<Record<"x-request-id" | "request-id" | "openai-request-id" | "cf-ray" | "event-request-id" | "response-id", string>>;
export type FailureOrigin = "provider_http" | "provider_protocol" | "transport" | "relay" | "client";
export interface ServerErrorDiagnostic {
  source: "provider_http" | "provider_sse" | "provider_json";
  bodyComplete?: boolean;
  eventType?: "error" | "response.failed" | "response.incomplete" | "response.completed";
  type?: string;
  code?: string;
  reason?: string;
  message?: string;
  messageHash?: string;
  messageLength?: number;
  messageCapturedLength?: number;
  messageTruncated?: boolean;
  messageRedacted?: boolean;
}
const ids = ["x-request-id", "request-id", "openai-request-id", "cf-ray", "event-request-id", "response-id"] as const;
const requestId = /^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|req_[a-z0-9]{8,100}|[a-f0-9]{16,64})$/i;
const responseId = /^resp_[a-z0-9]{8,160}$/i;
const rayId = /^[a-f0-9]{16,32}(?:-[a-z]{3})?$/i;
const labels = new Set([
  "server_error", "internal_error", "internal_server_error", "upstream_error", "api_error", "rate_limit_error", "rate_limit_exceeded",
  "tokens", "requests", "usage_limit_reached", "quota_exceeded", "insufficient_quota", "billing_hard_limit_reached", "billing_not_active",
  "invalid_request_error", "invalid_api_key", "authentication_error", "permission_error", "permission_denied", "access_denied",
  "model_not_found", "context_length_exceeded", "max_tokens", "max_output_tokens", "content_filter", "content_policy_violation",
  "overloaded_error", "service_unavailable", "temporarily_unavailable", "timeout", "request_timeout", "gateway_timeout", "bad_gateway",
  "response_cancelled", "response_not_found", "previous_response_not_found", "invalid_prompt", "image_parse_error", "image_too_large",
]);
const messages = {
  internal: "An error occurred while processing your request.",
  gateway: "Bad gateway.",
  unavailable: "Service temporarily unavailable.",
  timeout: "The upstream request timed out.",
  rate_limit: "The provider rate limit was reached.",
  quota: "The provider quota was exceeded.",
  unknown: "Provider error text withheld.",
} as const;

function validId(key: keyof UpstreamRequestIds, value: unknown): value is string {
  return typeof value === "string" && (key === "response-id" ? responseId : key === "cf-ray" ? rayId : requestId).test(value);
}
export function projectUpstreamRequestIds(value: unknown): UpstreamRequestIds | undefined {
  if (!object(value)) return undefined;
  const result: UpstreamRequestIds = {};
  for (const key of ids) if (validId(key, value[key])) result[key] = value[key];
  return Object.keys(result).length ? result : undefined;
}
export function upstreamRequestIds(headers: Headers): UpstreamRequestIds | undefined {
  const values: Record<string, unknown> = {};
  for (const key of ["x-request-id", "request-id", "openai-request-id", "cf-ray"]) values[key] = headers.get(key);
  return projectUpstreamRequestIds(values);
}
export function providerEventRequestIds(event: Record<string, unknown>): UpstreamRequestIds | undefined {
  const response = object(event.response) ? event.response : event;
  const error = object(response.error) ? response.error : object(event.error) ? event.error : event;
  const message = typeof error.message === "string" ? error.message.slice(0, MAX_ERROR_MESSAGE_CHARS) : "";
  const embedded = /\brequest[ _-]id[:\s]+([a-z0-9_-]+)/i.exec(message)?.[1];
  const eventRequestId = [error.request_id, event.request_id, response.request_id, embedded].find(value => validId("event-request-id", value));
  const eventResponseId = [response.id, event.response_id, error.response_id].find(value => validId("response-id", value));
  return projectUpstreamRequestIds({ "event-request-id": eventRequestId, "response-id": eventResponseId });
}

export function errorMessageDiagnostic(value: string, observedLength = value.length): Pick<ServerErrorDiagnostic,
  "message" | "messageHash" | "messageLength" | "messageCapturedLength" | "messageTruncated" | "messageRedacted"> {
  const captured = value.slice(0, MAX_ERROR_MESSAGE_CHARS);
  // Match known diagnoses but output only our constant templates. Redacting
  // emails/URLs alone cannot remove an echoed natural-language prompt.
  const lower = captured.toLowerCase();
  const message = lower.includes("an error occurred while processing your request") ? messages.internal
    : /\bbad gateway\b/.test(lower) ? messages.gateway
    : /\b(?:service (?:temporarily )?unavailable|overloaded)\b/.test(lower) ? messages.unavailable
    : /\b(?:timed out|gateway timeout)\b/.test(lower) ? messages.timeout
    : /\brate limit\b/.test(lower) ? messages.rate_limit
    : /\b(?:quota exceeded|insufficient quota)\b/.test(lower) ? messages.quota : messages.unknown;
  return { message, messageHash: createHash("sha256").update(captured).digest("hex"),
    messageLength: observedLength, messageCapturedLength: captured.length,
    messageTruncated: observedLength > captured.length, messageRedacted: captured !== message || observedLength !== captured.length };
}
export function providerErrorDiagnostic(event: Record<string, unknown>, source: ServerErrorDiagnostic["source"]): ServerErrorDiagnostic {
  const response = object(event.response) ? event.response : event;
  const error = object(response.error) ? response.error : object(event.error) ? event.error : event;
  const incomplete = object(response.incomplete_details) ? response.incomplete_details : {};
  const result: ServerErrorDiagnostic = { source };
  if (typeof event.type === "string" && ["error", "response.failed", "response.incomplete", "response.completed"].includes(event.type))
    result.eventType = event.type as ServerErrorDiagnostic["eventType"];
  for (const key of ["type", "code"] as const) if (typeof error[key] === "string" && labels.has(error[key])) result[key] = error[key];
  if (typeof incomplete.reason === "string" && labels.has(incomplete.reason)) result.reason = incomplete.reason;
  const message = typeof error.message === "string" ? error.message : typeof event.error === "string" ? event.error : undefined;
  if (message !== undefined) Object.assign(result, errorMessageDiagnostic(message));
  return result;
}
export function projectServerErrorDiagnostic(value: unknown): ServerErrorDiagnostic | undefined {
  if (!object(value) || typeof value.source !== "string" || !["provider_http", "provider_sse", "provider_json"].includes(value.source)) return undefined;
  const result: ServerErrorDiagnostic = { source: value.source as ServerErrorDiagnostic["source"] };
  if (typeof value.eventType === "string" && ["error", "response.failed", "response.incomplete", "response.completed"].includes(value.eventType)) result.eventType = value.eventType as ServerErrorDiagnostic["eventType"];
  for (const key of ["type", "code", "reason"] as const) if (typeof value[key] === "string" && labels.has(value[key])) result[key] = value[key];
  if (typeof value.message === "string" && Object.values(messages).includes(value.message as typeof messages[keyof typeof messages])) result.message = value.message;
  if (typeof value.messageHash === "string" && /^[a-f0-9]{64}$/.test(value.messageHash)) result.messageHash = value.messageHash;
  for (const key of ["messageLength", "messageCapturedLength"] as const)
    if (typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0 && (key !== "messageCapturedLength" || value[key] <= MAX_ERROR_MESSAGE_CHARS)) result[key] = value[key];
  for (const key of ["messageRedacted", "messageTruncated", "bodyComplete"] as const) if (typeof value[key] === "boolean") result[key] = value[key];
  return result;
}
export function failureOrigin(errorCode: string | undefined): FailureOrigin | undefined {
  if (!errorCode) return undefined;
  if (errorCode === "client_disconnected") return "client";
  if (["upstream_http_error", "account_rate_limited", "upstream_redirect"].includes(errorCode)) return "provider_http";
  if (["provider_stream_error", "provider_response_error", "unrecognized_response", "unrecognized_compaction_response"].includes(errorCode)) return "provider_protocol";
  if (["upstream_stream_interrupted", "missing_completion_event", "upstream_unavailable", "upstream_timeout", "upstream_connection_reset", "upstream_connection_failed", "upstream_connection_refused", "upstream_network_unreachable", "upstream_dns_error", "upstream_tls_error"].includes(errorCode)) return "transport";
  return "relay";
}
