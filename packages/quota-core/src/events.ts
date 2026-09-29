import type { SavingsReason } from "./task-savings.js";
import { safeEffort } from "./codex-compaction-policy.js";
import { transportFailure } from "./transport-failure.js";

export const QUOTA_CORE_EVENT_SCHEMA_VERSION = 1 as const;

export interface CompactionRequestEvent {
  requestId: string;
  threadId: string | null;
  turnId: string | null;
  kind: "compaction" | "response";
  from: string;
  to: string;
  routed: boolean;
  phase: "started" | "response_headers" | "completed" | "failed" | "cancelled" | "unverified";
  status: number;
  requestedEffort: string | null;
  reasoningEffort: string | null;
  at: string;
  durationMs: number;
  errorCode?: string;
  transportCode?: string;
  retryCount?: number;
  savingsReason?: SavingsReason;
  responseModel?: string | null;
  usage?: { input: number; cachedInput: number; output: number } | null;
}

const savingsReasons = new Set(["disabled", "simple_text_edit", "uncertain_task", "keep_setting", "manual_change", "extended_work", "failure_fallback", "unsupported_model", "unidentified_task", "task_disabled"]);
const phases = new Set(["started", "response_headers", "completed", "failed", "cancelled", "unverified"]);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const label = /^[a-z0-9_.-]{1,80}$/i;

// Explicit metadata projection: credentials, URLs and request bodies never leave this reader.
export function parseCompactionRequestEvent(value: unknown): CompactionRequestEvent | null {
  if (!value || typeof value !== "object") return null;
  return project(value);
}

function project(value: any): CompactionRequestEvent | null {
  if (!["compaction", "response"].includes(value.kind) || (typeof value.requestId !== "string" || !uuid.test(value.requestId)) || !phases.has(value.phase) ||
      typeof value.from !== "string" || typeof value.to !== "string" ||
      !label.test(value.from) || !label.test(value.to) || (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) ||
      !Number.isFinite(value.durationMs) || value.durationMs < 0) return null;
  return { requestId: value.requestId, threadId: typeof value.threadId === "string" && uuid.test(value.threadId) ? value.threadId : null,
    turnId: typeof value.turnId === "string" && uuid.test(value.turnId) ? value.turnId : null, kind: value.kind, from: value.from, to: value.to,
    routed: value.routed === true, phase: value.phase, status: Number.isInteger(value.status) ? value.status : 0,
    requestedEffort: safeEffort(value.requestedEffort),
    reasoningEffort: safeEffort(value.reasoningEffort),
    at: value.at, durationMs: value.durationMs,
    ...(Number.isInteger(value.retryCount) && value.retryCount >= 0 && value.retryCount <= 2 ? { retryCount: value.retryCount } : {}),
    ...(transportFailure({code: value.transportCode}).transportCode ? { transportCode: value.transportCode } : {}),
    ...(savingsReasons.has(value.savingsReason) ? { savingsReason: value.savingsReason } : {}),
    responseModel: typeof value.responseModel === "string" && label.test(value.responseModel) ? value.responseModel : null,
    usage: value.usage && [value.usage.input,value.usage.cachedInput,value.usage.output].every(n=>Number.isSafeInteger(n) && n>=0) && value.usage.cachedInput <= value.usage.input
      ? {input:value.usage.input,cachedInput:value.usage.cachedInput,output:value.usage.output} : null,
    ...(typeof value.errorCode === "string" && label.test(value.errorCode) ? { errorCode: value.errorCode } : {}) };
}
