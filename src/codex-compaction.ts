import { ResponseOwnershipGuard, NativeResponseOwnershipGuard, ResponseOwnershipError, type OwnershipProvenance } from "./codex-response-ownership";
import { fetchCodexUpstream, transportFailure } from "./codex-transport";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_COMPACTION_ROUTE, isCompaction, object, routeCompaction, safeEffort, validateCompactionRoute, type CompactionRoute } from "./codex-compaction-policy";
import { DEFAULT_TASK_SAVINGS, TaskSavingsRouter, validateTaskSavings, type TaskSavingsPolicy, type SavingsReason, type TaskState } from "./task-savings";
import { failureOrigin, upstreamRequestIds, type UpstreamRequestIds } from "../packages/quota-core/src/codex-error-diagnostics.js";
import { ResponseCompletionObserver } from "./codex-compaction-stream";
import { AccountPool, PoolError, type PoolRoute, type SourceHistoryPolicy } from "./account-pool";
import { codexRequestIdentity } from "./codex-request-identity";
import { createSavingsModelSupport } from "./savings-model-support";
import { createSubscriptionGuard, type SubscriptionGuard } from "./subscription-guard";
import { codexProfileRoot, loadConfig } from "./config";
import { readCodexForkParent } from "./account-pool-lineage";
import { createSourceHistoryGuard, type SourceHistoryGuard } from "./source-history-guard";
import { inspectNativeBody, nativeRequestPathAllowed } from "./native-request";
import { BodyDecodeError, decodeRequestBody, requestEncoding, type BodyDecodeFailure, type RequestEncoding } from "./request-body-decoder";
import type { ExecutionTargetRelay, FrozenTargetSelection } from "./execution-target-relay";
import { manualNativeToolPayload, type ManualAccountRouting, type ManualRequestTarget } from "./manual-account-routing";
import { interactiveRelayPolicy } from "./interactive-relay-policy";
import { createRelayDiagnostics } from "./relay-diagnostics";
export { DEFAULT_COMPACTION_ROUTE, routeCompaction, validateCompactionRoute, type CompactionRoute } from "./codex-compaction-policy";

import type { CompactionRequestEvent as CoreRequestEvent } from "../packages/quota-core/src/events.js";
export interface CompactionRequestEvent extends CoreRequestEvent {
  accountRouting?: PoolRoute;
  inlineImageCount?: number;
  requestEncoding?: RequestEncoding;
  requestInspection?: NativeInspectionReason;
}
type NativeInspectionReason = "not-applicable" | "empty-body" | "body-too-large" | "parsed" | "invalid-json" | "missing-model" | BodyDecodeFailure;
export interface NativeRequestEvent {
  kind: "native_request"; requestId: string; method: string; routeFamily: string;
  status: number; origin: "relay" | "provider" | "client"; reason: string; at: string;
  requestEncoding?: RequestEncoding;
  requestInspection?: NativeInspectionReason;
}

function requestIdentity(headers: Headers) {
  const { threadId, turnId } = codexRequestIdentity(headers);
  return { threadId, turnId };
}

const UPSTREAM = "https://chatgpt.com/backend-api/codex";
const MAX_BODY_BYTES = 64 * 1024 * 1024;
// Native Codex image operations use the same fixed ChatGPT subscription origin.
// These are not the public /v1 Images API and must never use pool routing.
const IMAGE_ROUTES = new Set(["/images/generations", "/images/edits"]);
// Native web.run uses this Codex route, independently of /responses tools.
const SEARCH_ROUTE = "/alpha/search";
const HOP_HEADERS = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
];

class SubscriptionRequestError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function subscriptionError(reason: string) {
  const messages: Record<string, string> = {
    "reserve-reached": "The configured remaining quota reserve has been reached. Wait for quota recovery or review the reserve in QuotaPie.",
    "quota-exhausted": "The subscription quota is exhausted. Wait for quota recovery; paid credits are not a fallback.",
    "quota-stale": "A fresh quota observation is unavailable. Retry after quota collection has refreshed.",
    "collection-unavailable": "The quota collector is unavailable. Restore quota collection before retrying.",
    "quota-observation-unavailable": "The local quota observation could not be read. QuotaPie needs a fresh verified observation before this managed request can continue.",
    "quota-unknown": "The current subscription allowance has not been verified. Retry after quota collection succeeds.",
    "reset-unconfirmed": "The quota reset has not been confirmed. Wait for a fresh quota observation.",
    "upstream-quota-hold": "The provider rejected a previous inference request for quota or billing limits. Wait for a newer quota observation before retrying.",
    "account-unavailable": "The configured Codex account profile is unavailable.",
    "account-identity-changed": "The Codex login in this profile changed. Reconnect the relay to the intended account before retrying.",
    "request-identity-mismatch": "This request does not match the configured Codex login. Reopen the task in its owning account profile.",
    "subscription-auth-required": "This relay requires the configured ChatGPT subscription login.",
    "subscription-auth-unavailable": "The configured ChatGPT login is expired or unavailable. Refresh that profile's login before retrying.",
    "guard-unavailable": "QuotaPie could not read or validate its local account protection settings. Restore the account connection and local settings before retrying.",
    "budget-baseline-invalid": "The automatic continuation has an invalid quota budget. QuotaPie must prepare a verified budget before retrying.",
    "budget-baseline-changed": "The quota period changed since this automatic continuation was approved. QuotaPie must verify a new budget before retrying.",
    "profile-mismatch": "The quota observation belongs to a different account profile.",
    "model-unverified": "This model has not been verified for the configured subscription.",
    "route-unsupported": "This request route is not supported by subscription protection.",
    "pool_lineage_unavailable": "This task's parent conversation metadata could not be read. Restore access to its original Codex history before retrying.",
    "pool_lineage_invalid": "This task's parent conversation metadata is invalid. Its account ownership could not be verified.",
    "pool_lineage_conflict": "This task's reported parent does not match its saved Codex history. Its account ownership could not be verified.",
    "pool_source_history_unverified": "This request contains history whose original account could not be verified. Continue from the original task and account profile.",
    "pool_source_continuation_mismatch": "This task's saved history belongs to a different account. Reopen it in its original account profile.",
    "pool_source_continuation_unavailable": "The local account ownership record could not be read. QuotaPie must restore access to that record before continuing this task.",
    "source-continuation-unverified": "QuotaPie could not verify this task's original account history. The original account binding must be verified before continuing.",
    "execution-target-unavailable": "The automatic continuation's account binding could not be read or validated. QuotaPie must verify that binding before continuing.",
    "execution-target-identity-changed": "The account selected for this automatic continuation changed. QuotaPie must verify the intended account before continuing.",
    "execution-target-request-unverified": "This native request could not be matched to its authorized automatic continuation. QuotaPie must verify its host turn before continuing.",
    "pool_execution_target_unavailable": "The saved automatic continuation could not be read or validated. QuotaPie must verify its saved account binding before continuing.",
    "pool_execution_target_conflict": "QuotaPie found conflicting saved automatic continuation attempts for this conversation. Their host turn receipts must be reconciled before continuing.",
    "pool_execution_target_message_unverified": "QuotaPie could not match the automatic continuation to its official host turn receipt. The receipt must be verified before continuing this conversation.",
    "pool_execution_target_expired": "The authorization for this automatic continuation expired. QuotaPie must verify a new continuation before retrying.",
    "pool_execution_target_identity_required": "The thread or turn identity needed to verify this automatic continuation is missing. No account binding was changed.",
    "pool_execution_target_identity_conflict": "This automatic continuation contains conflicting thread or turn identities. No account binding was changed.",
    "pool_execution_target_source_changed": "The original account for this automatic continuation changed. Restore its verified account connection before continuing.",
    "pool_execution_target_target_changed": "The selected account profile for this automatic continuation changed. QuotaPie must verify the intended account before continuing.",
    "pool_execution_target_target_unavailable": "The selected account's login or model is unavailable. QuotaPie must verify that account before continuing.",
    "pool_execution_target_model_changed": "The requested model differs from the model authorized for this automatic continuation. QuotaPie must verify a new continuation before retrying.",
    "pool_execution_target_policy_changed": "The account routing policy changed after this automatic continuation was approved. QuotaPie must verify a new continuation before retrying.",
    "pool_execution_target_quota_unavailable": "The selected account's quota could not be verified for this automatic continuation. Wait for a fresh quota observation.",
    "pool_execution_target_native_route_unverified": "QuotaPie could not verify this conversation's original quota failure in its live account connection. No continuation was authorized.",
    "pool_execution_target_repeat_or_unverified_send": "QuotaPie could not verify that this automatic continuation is a new, authorized request. It was not sent again.",
    "pool_execution_target_response_unconfirmed": "The preceding response for this automatic continuation has not been confirmed. QuotaPie must verify its completion before sending the next request.",
    "pool_execution_target_local_recovery_unverified": "The authorization to recover this locally interrupted continuation could not be verified. QuotaPie must reconcile its saved host turn receipt.",
    "pool_execution_target_local_recovery_changed": "The authorization to recover this locally interrupted continuation changed or was already used. No additional request was sent.",
    "request-unsupported": "This request format is not supported by subscription protection.",
  };
  return { type: "quotapie_subscription_guard",
    code: `subscription_${reason.replace(/^subscription-/, "").replaceAll("-", "_")}`,
    message: `QuotaPie paused this request. ${messages[reason] ?? "Subscription protection could not be verified for this request."} No other account or paid fallback was used.` };
}

function transportHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of (headers.get("connection") ?? "").split(",")) {
    if (name.trim()) headers.delete(name.trim());
  }
  for (const name of HOP_HEADERS) headers.delete(name);
  return headers;
}

function poolErrorMessage(error: PoolError): string {
  if (error.code === "pool_reserve_reached")
    return "QuotaPie paused this request to preserve your configured remaining quota. No eligible account is above its reserve. Lower the reserve or wait for quota to recover in QuotaPie Settings.";
  if (error.code === "pool_reserve_quota_unavailable")
    return "QuotaPie paused this request because remaining quota is not current enough to protect your reserve. Refresh quota in QuotaPie or lower the reserve.";
  if (error.code === "pool_recovery_requires_full_history")
    return "QuotaPie: another account has capacity, but this request contains account-bound history that cannot be transferred safely. Keep this task and retry after its account recovers.";
  if (error.code === "pool_target_quota_exhausted")
    return "QuotaPie paused this request because its bound account was observed with exhausted quota and continuing may spend paid credits. No request was sent. Retry after fresh quota recovery or use an eligible account.";
  if (error.code === "pool_storage_busy")
    return "QuotaPie account routing is busy. No request was sent to the provider. Retry shortly; the existing task and account protection are preserved.";
  if (error.code === "pool_source_quota_exhausted")
    return "QuotaPie paused this request because the original account's quota is exhausted and continuing may spend paid credits. No request was sent. Retry after quota recovers or use an eligible account in a new task.";
  if (error.code === "pool_account_cooldown")
    return `QuotaPie: this task's account is temporarily rate limited. Retry in ${error.retryAfterSeconds ?? 60} seconds. The task remains on its original account.`;
  if (error.code === "pool_auth_cooldown")
    return "QuotaPie: this task's account credentials were rejected. Refresh that account's login before retrying.";
  if (["pool_source_auth_unavailable", "pool_target_auth_unavailable", "pool_source_identity_mismatch"].includes(error.code))
    return "QuotaPie: the task's registered account credentials need to be refreshed. Its account binding has been preserved.";
  if (["pool_bound_identity_changed", "pool_bound_account_removed"].includes(error.code))
    return "QuotaPie: the task's original account is unavailable or has changed. Restore that registered account to continue this task.";
  return `QuotaPie could not route this request (${error.code}). No request was sent to the provider.`;
}

/** One loopback relay per launched Codex process. Credentials and bodies stay in memory. */
export interface CompactionProxyOptions {
  route?: CompactionRoute;
  port?: number;
  token?: string;
  onRequest?: (event: CompactionRequestEvent) => void;
  onNativeRequest?: (event: NativeRequestEvent) => void;
  onProvenance?: (event: OwnershipProvenance & { requestId: string }) => void;
  taskSavings?: TaskSavingsPolicy;
  savingsModelSupported?: () => boolean;
  savingsState?: Map<string, TaskState>;
  fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>;
  accountPool?: AccountPool;
  resolveAccountPool?: () => AccountPool | undefined;
  poolSubscriptionGuard?: (account: string, identity: string) => SubscriptionGuard;
  executionTargetRelay?: ExecutionTargetRelay;
  manualAccountRouting?: ManualAccountRouting;
  subscriptionGuard?: SubscriptionGuard;
  executionMode?: "interactive" | "managed";
  sourceHistoryGuard?: SourceHistoryGuard;
  /** Only interactive callers opt into source-authenticated native history. */
  sourceHistoryPolicy?: SourceHistoryPolicy;
  /** A reviewed managed report may not invoke inherited or future tools. */
  reportOnly?: boolean;
}

export function createCompactionHandler(options: CompactionProxyOptions = {}) {
  if (options.reportOnly && !options.subscriptionGuard) throw new Error("Report-only execution requires a subscription guard");
  const interactive = options.executionMode === "interactive" && !options.reportOnly;
  if (interactive && !options.subscriptionGuard) throw new Error("Interactive relay requires source authentication");
  const sourceHistoryPolicy = options.reportOnly ? "strict" : interactive ? "authenticated-source" : options.sourceHistoryPolicy ?? "strict";
  const nativePolicy = interactiveRelayPolicy(options.route, options.taskSavings);
  const route = options.route ?? (interactive ? nativePolicy.route : { ...DEFAULT_COMPACTION_ROUTE });
  if (!interactive) validateCompactionRoute(route);
  const savingsPolicy = options.taskSavings ?? (interactive ? nativePolicy.taskSavings : { ...DEFAULT_TASK_SAVINGS });
  const savingsRouter = new TaskSavingsRouter(options.savingsModelSupported, options.savingsState);
  const token = options.token ?? randomBytes(24).toString("hex");
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error("Invalid relay token");
  const prefix = `/${token}/backend-api/codex`;
  let requests = 0;
  let rejectedRequests = 0;
  let compactions = 0;
  let lastRequest: CompactionRequestEvent | null = null;
  let attemptedCompactions = 0, failedCompactions = 0, cancelledCompactions = 0, unverifiedCompactions = 0;
  let activeRequests = 0;
  let draining = false;
  let guardBlockedRequests = 0, guardAbortedRequests = 0;
  const blockedByReason: Record<string, number> = {};
  const abortedByReason: Record<string, number> = {};
  const active = new Map<string, CompactionRequestEvent>();
  const recent: CompactionRequestEvent[] = [];
  const recentNativeRequests: NativeRequestEvent[] = [];
  const record = (update: CompactionRequestEvent) => {
    lastRequest = update;
    if (update.phase === "started" || update.phase === "response_headers") active.set(update.requestId, update);
    else {
      active.delete(update.requestId);
      recent.push(update);
      if (recent.length > 32) recent.shift();
    }
    // Both local rejection and upstream completion use the same evidence path.
    // Observability callbacks must not break or repeat an inference request.
    try { options.onRequest?.(update); } catch { /* Never log callback errors. */ }
  };
  const upstreamFetch = options.fetchUpstream ?? fetch;
  const publicGuardState = () => {
    const state = options.subscriptionGuard?.check();
    if (!state) return undefined;
    const { sourceIdentity, sourceAccountHeader, ...publicState } = state;
    return publicState;
  };
  const snapshot = () => ({ service: "quotapie-compaction", schemaVersion: 3, serverErrorDiagnosticsVersion: 1, accountPoolVersion: (options.accountPool || options.resolveAccountPool) ? 1 : 0, accountPoolReserveVersion: (options.accountPool || options.resolveAccountPool) ? 1 : 0, accountPoolRoutingVersion: (options.accountPool || options.resolveAccountPool) ? 3 : 0, accountPoolRecoveryVersion: (options.accountPool || options.resolveAccountPool) ? 2 : 0, accountPoolInlineImagesVersion: (options.accountPool || options.resolveAccountPool) ? 2 : 0, transportRecoveryVersion: 1, responseOwnershipVersion: 3,
          responseOwnership: { formats: ["sse", "json"], policy: "reject-explicit-mismatch", missingMetadata: "unattributed",
            unsupportedFormats: "unverified", inspectionLimitBytes: 4 * 1024 * 1024,
            inspectionFailure: interactive ? "passthrough-unverified" : "reject" }, taskSavingsPhasesVersion: 1, nativeImageRoutesVersion: 1, taskSavings: interactive ? interactiveRelayPolicy(route, savingsPolicy).taskSavings : validateTaskSavings(savingsPolicy), savingsModelSupported: options.savingsModelSupported?.() === true, pid: process.pid,
          subscriptionGuardVersion: options.subscriptionGuard ? 1 : 0,
          subscriptionGuardRevision: options.subscriptionGuard ? 3 : 0,
          nativeRequestPolicyVersion: 1,
          nativeRequestInspectionVersion: 1,
          nativeRequestPolicy: interactive ? "source-origin" : "managed-allowlist",
          accountPoolOptInVersion: options.resolveAccountPool ? 1 : 0,
          executionTargetVersion: options.executionTargetRelay?.version ?? 0,
          manualAccountRoutingVersion: options.manualAccountRouting?.version ?? 0,
          executionTargetRelayInstanceId: options.executionTargetRelay?.instanceId ?? null,
          recentNativeRequests,
          executionMode: interactive ? "interactive" : "managed",
          sourceContinuationRevision: interactive ? 3 : options.accountPool?.sourceContinuationRevision ?? 0,
          nativeSearchRoutesVersion: 1,
          subscriptionGuard: options.subscriptionGuard ? { ...publicGuardState(),
            sourceHistoryPolicy,
            blockedRequests: guardBlockedRequests, abortedRequests: guardAbortedRequests,
            blockedByReason, abortedByReason } : null,
          accountPoolLineageVersion: (options.accountPool || options.resolveAccountPool) ? 3 : 0,
          route: interactive ? interactiveRelayPolicy(route, savingsPolicy).route : validateCompactionRoute(route), requests, rejectedRequests, compactions, attemptedCompactions,
          failedCompactions, cancelledCompactions, unverifiedCompactions, activeRequests, draining,
          active: [...active.values()], recent, lastRequest });
  return {
    prefix, snapshot,
    get activeRequests() { return activeRequests; },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${prefix}/`) || request.headers.has("origin")) {
        return new Response("Not found", { status: 404 });
      }
      const path = url.pathname.slice(prefix.length);
      const nativeRequestId = randomUUID();
      let nativeRecorded = false;
      const encoding = requestEncoding(request.headers.get("content-encoding"));
      let inspectionReason: NativeInspectionReason = "not-applicable";
      const recordNative = (status: number, origin: NativeRequestEvent["origin"], reason: string) => {
        if (!interactive || nativeRecorded) return;
        nativeRecorded = true;
        // Retain no query, resource ID, payload, token or arbitrary error text.
        const family = path.split("/")[1] ?? "";
        const item: NativeRequestEvent = { kind: "native_request", requestId: nativeRequestId, method: request.method,
          routeFamily: ["responses", "models", "alpha", "images", "files", "audio"].includes(family) ? family : "other",
          status, origin, reason, at: new Date().toISOString(), requestEncoding: encoding, requestInspection: inspectionReason };
        recentNativeRequests.push(item);
        if (recentNativeRequests.length > 32) recentNativeRequests.shift();
        try { options.onNativeRequest?.(item); } catch { /* Diagnostic only. */ }
      };
      if (path === "/quotapie-health" && request.method === "GET") {
        return Response.json(snapshot());
      }
      if (path === "/quotapie-execution-target/ack" && request.method === "POST") {
        if (draining || !options.executionTargetRelay) return Response.json({ error: { code: "execution-target-unavailable" } }, { status: 409 });
        try {
          const raw = await request.text();
          if (raw.length > 4096) throw new Error("execution-target-request-too-large");
          return Response.json(await options.executionTargetRelay.acknowledge(JSON.parse(raw)));
        } catch (error) { return Response.json({ error: { code: error instanceof PoolError ? error.code.replace(/^pool_/, "").replaceAll("_", "-") : "execution-target-unavailable" } }, { status: 409 }); }
      }
      if (path === "/quotapie-drain" && request.method === "POST") {
        draining = true;
        return Response.json({ draining, activeRequests });
      }
      if (draining) return new Response("Relay is draining", { status: 503, headers: { "retry-after": "1" } });
      // Codex explicitly recognizes 426 and falls back to HTTP for this session.
      // This keeps the built-in OpenAI provider identity in the desktop app.
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return new Response("Use streaming HTTP", { status: 426 });
      }
      if (interactive ? !nativeRequestPathAllowed(path) || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method)
        : !/^\/[a-zA-Z0-9_/-]+$/.test(path) || !["GET", "POST"].includes(request.method)) {
        return new Response("Unsupported route", { status: 400 });
      }
      // Management endpoints are local-only, including unknown future names.
      if (path.startsWith("/quotapie-")) return new Response("Not found", { status: 404 });
      const rejectGuard = (reason: string) => {
        recordNative(400, "relay", reason);
        guardBlockedRequests++; rejectedRequests++;
        blockedByReason[reason] = (blockedByReason[reason] ?? 0) + 1;
        // A local hold is not a transient provider conflict. Codex retries 409,
        // which cannot repair a reserve or identity failure.
        return Response.json({ error: { ...subscriptionError(reason),
          ...(reason === "route-unsupported" ? { route: path, method: request.method } : {}) } }, { status: 400 });
      };
      const imageRequest = request.method === "POST" && IMAGE_ROUTES.has(path);
      const searchRequest = request.method === "POST" && path === SEARCH_ROUTE;
      const nativeToolRequest = imageRequest || searchRequest;
      if (!interactive && options.subscriptionGuard && (request.method === "POST"
        ? !["/responses", "/responses/compact"].includes(path) && !nativeToolRequest : path !== "/models"))
        return rejectGuard("route-unsupported");
      if (nativeToolRequest && options.reportOnly) return rejectGuard("request-unsupported");
      if (["/responses", "/responses/compact"].includes(path) && codexRequestIdentity(request.headers).conflict) {
        rejectedRequests++;
        recordNative(400, "relay", "request_identity_conflict");
        return Response.json({ error: { type: "quotapie_request_identity", code: "request_identity_conflict",
          message: "Conflicting thread or turn identifiers were supplied. No request was sent to the provider." } }, { status: 400 });
      }
      const metadataRequest = request.method === "GET" && path === "/models";
      let accountPool = options.accountPool;
      let headers = transportHeaders(request.headers);
      let sourceHeaders = new Headers(headers);
      let selectedGuard: SubscriptionGuard | undefined;
      let frozenTarget: FrozenTargetSelection | null = null;
      let manualTarget: ManualRequestTarget | null = null;
      // Bun fetch decompresses upstream responses; request identity to keep streaming simple.
      headers.set("accept-encoding", "identity");
      let body: BodyInit | undefined;
      let nativeParsed: Record<string, unknown> | undefined;
      let expectsSse = false;
      let event: Omit<CompactionRequestEvent, "phase" | "status" | "at" | "durationMs"> | undefined;
      let poolSelection: ReturnType<AccountPool["select"]> = null;
      let poolInput: { body: unknown; headers: Headers; verifiedSource?: { identity: string; credentialDigest: string } } | undefined;
      let verifiedSource: { identity: string; credentialDigest: string } | undefined;
      let selectingAccount = false;
      let guardModel: string | undefined;
      const bindSelectedGuard = (selection: NonNullable<typeof poolSelection>) => {
        if (!interactive || selection.route.account === selection.route.sourceAccount && !frozenTarget && !manualTarget) return undefined;
        if (frozenTarget && (selection.route.account !== frozenTarget.lease.target.account || selection.identity !== frozenTarget.lease.target.identity))
          throw new PoolError("pool_execution_target_mismatch", 409);
        const guard = frozenTarget?.guard ?? options.poolSubscriptionGuard?.(selection.route.account, selection.identity);
        if (!guard) throw new PoolError("pool_target_quota_unavailable", 409);
        const state = guard.check({ headers: selection.headers, model: guardModel });
        if (!state.ready || state.sourceIdentity !== selection.identity)
          throw new PoolError("pool_target_quota_unavailable", 409);
        return guard;
      };
      const checkRequestGuard = () => {
        const source = options.subscriptionGuard!.checkIdentity({ headers: sourceHeaders });
        if (!source.ready || metadataRequest) return source;
        return selectedGuard ? selectedGuard.check({ headers, model: guardModel })
          : options.subscriptionGuard!.check({ headers: sourceHeaders, model: guardModel });
      };
      const started = performance.now();
      // Freeze the policy for this request. A live policy update cannot change
      // its target, effort, or attribution after the request has been sent.
      const resolved = interactive ? interactiveRelayPolicy(route, savingsPolicy) : null;
      const policy = resolved?.route ?? validateCompactionRoute(route);
      const taskPolicy = resolved?.taskSavings ?? validateTaskSavings(savingsPolicy);
      // Include uploads in drain accounting, before the first body-read await.
      activeRequests++;
      try {
        if (interactive) {
          const guard = options.subscriptionGuard!.checkIdentity({ headers });
          if (!guard.ready) throw new SubscriptionRequestError(guard.reason);
          if (!headers.has("chatgpt-account-id") && guard.sourceAccountHeader)
            headers.set("chatgpt-account-id", guard.sourceAccountHeader);
          sourceHeaders = new Headers(headers);
          if (guard.sourceIdentity && headers.get("authorization")?.startsWith("Bearer ")) verifiedSource = {
            identity: guard.sourceIdentity, credentialDigest: createHash("sha256").update(headers.get("authorization")!.slice(7)).digest("hex") };
          // Inspect only Responses payloads for configured optimizations. Every
          // other native method, media type and route streams through unchanged.
          if (request.method === "POST" && ["/responses", "/responses/compact"].includes(path)) {
            const inspected = await inspectNativeBody(request, MAX_BODY_BYTES);
            body = inspected.body;
            inspectionReason = inspected.reason === "buffered" ? "invalid-json" : inspected.reason;
            if (inspected.bytes?.byteLength) try {
              const decoded = await decodeRequestBody(inspected.bytes, encoding, MAX_BODY_BYTES, request.signal);
              const parsed: unknown = JSON.parse(new TextDecoder().decode(decoded));
              if (object(parsed) && typeof parsed.model === "string") { nativeParsed = parsed; inspectionReason = "parsed"; }
              else inspectionReason = "missing-model";
            } catch (error) {
              request.signal.throwIfAborted();
              inspectionReason = error instanceof BodyDecodeError ? error.reason : "invalid-json";
              // Optional inspection failure preserves original bytes and encoding.
            }
          } else if (!["GET", "HEAD"].includes(request.method)) body = request.body ?? undefined;
        }
        if (!interactive && nativeToolRequest && options.subscriptionGuard) {
          // Native tools have their own payloads, not a Responses chat model.
          // Check the source and configured allowance before reading the body.
          const guard = options.subscriptionGuard.check({ headers });
          if (!guard.ready) throw new SubscriptionRequestError(guard.reason);
        }
        if (request.method === "POST" && (!interactive || nativeParsed)) {
          if (!interactive) body = new Uint8Array(await request.arrayBuffer());
          if (!interactive && nativeToolRequest) {
            const decoded = await decodeRequestBody(body as Uint8Array, encoding, MAX_BODY_BYTES, request.signal);
            if (decoded.byteLength > MAX_BODY_BYTES) throw new SubscriptionRequestError("request-unsupported");
            const mediaType = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
            // Keep the exact native JSON bytes. No model substitution, billing
            // endpoint, account selection, history replay, or paid retry path.
            if (mediaType !== "application/json") throw new SubscriptionRequestError("request-unsupported");
            const input: unknown = JSON.parse(new TextDecoder().decode(decoded));
            if (!object(input)) throw new SubscriptionRequestError("request-unsupported");
            if (options.subscriptionGuard) {
              const guard = options.subscriptionGuard.check({ headers });
              if (!guard.ready) throw new SubscriptionRequestError(guard.reason);
              // Native tool payloads are not Responses replay history.
              // Pin the source identity and never enter the account pool.
            }
          }
          if (path === "/responses" || path === "/responses/compact") {
            const decoded = nativeParsed ? null : await decodeRequestBody(body as Uint8Array, encoding, MAX_BODY_BYTES, request.signal);
            if (decoded && decoded.byteLength > MAX_BODY_BYTES) {
              activeRequests--;
              return new Response("Request too large", { status: 413 });
            }
            const parsed: unknown = nativeParsed ?? JSON.parse(new TextDecoder().decode(decoded!));
            // Apply at the provider boundary as well as in CLI configuration.
            // Old rollout tool definitions cannot authorize a new tool call.
            const input = options.reportOnly && object(parsed) ? { ...parsed, tools: [], tool_choice: "none" } : parsed;
            if (!interactive && options.subscriptionGuard && (!object(input) || typeof input.model !== "string" || !input.model ||
                input.background !== undefined && input.background !== false))
              throw new SubscriptionRequestError("request-unsupported");
            expectsSse = object(input) && (input.stream === true || (path === "/responses" && isCompaction(path, input)));
            const compact = object(input) && isCompaction(path, input);
            if (interactive && options.executionTargetRelay && object(input) && typeof input.model === "string") {
              const identity = requestIdentity(headers);
              try { frozenTarget = await options.executionTargetRelay.resolve({ ...identity, body: input, model: input.model, historyOnly: path === "/responses/compact" }); }
              catch (error) { throw new SubscriptionRequestError(error instanceof PoolError ? error.code : "execution-target-unavailable"); }
            }
            let savings: ReturnType<TaskSavingsRouter["route"]> | null = null;
            let routed: { body: unknown; routed: boolean } = { body: input, routed: false };
            try {
              savings = !frozenTarget && !compact && path === "/responses" ? savingsRouter.route(input, taskPolicy, requestIdentity(headers).threadId) : null;
              routed = !frozenTarget && compact ? routeCompaction(path, input, policy) : savings ?? routed;
            } catch (error) {
              if (!interactive) throw error;
              // Optional classification/catalog failures cannot deny admission.
              // Preserve the original native body and its chosen model.
            }
            if (object(input) && typeof input.model === "string") {
              const outgoing = object(routed.body) ? routed.body : input;
              guardModel = typeof outgoing.model === "string" ? outgoing.model : input.model;
              event = {
                requestId: nativeRequestId, ...requestIdentity(headers),
                kind: isCompaction(path, input) ? "compaction" : "response",
                from: input.model, to: typeof outgoing.model === "string" ? outgoing.model : input.model,
                ...(savings ? { savingsReason: savings.reason } : {}),
                inlineImageCount: Array.isArray(input.input) ? input.input.reduce((count: number, item: any) => count +
                  [item?.content, item?.output].reduce((n: number, parts: any) => n + (Array.isArray(parts) ? parts.filter((p: any) =>
                    p?.type === "input_image" && p.file_id == null && typeof p.image_url === "string" &&
                    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image_url)).length : 0), 0), 0) : 0,
                routed: routed.routed,
                requestedEffort: safeEffort(object(input.reasoning) ? input.reasoning.effort : null),
                reasoningEffort: safeEffort(object(outgoing.reasoning) ? outgoing.reasoning.effort : null),
                ...(interactive ? { requestEncoding: encoding, requestInspection: inspectionReason } : {}),
              };
              if (options.subscriptionGuard && !interactive) {
                const guard = options.subscriptionGuard.check({ headers, model: guardModel });
                if (!guard.ready) throw new SubscriptionRequestError(guard.reason);
                try {
                  // Keep the source login and reject known foreign ownership.
                  // Interactive helpers need not persist a native rollout;
                  // managed work still requires strict history verification.
                  if (!interactive) await accountPool?.assertSourceContinuationAsync({ threadId: event.threadId, body: outgoing, headers,
                    historyPolicy: sourceHistoryPolicy }, request.signal);
                } catch (error) {
                  throw new SubscriptionRequestError(error instanceof PoolError ? error.code : "source-continuation-unverified");
                }
                request.signal.throwIfAborted();
                const currentGuard = options.subscriptionGuard.check({ headers, model: guardModel });
                if (!currentGuard.ready) throw new SubscriptionRequestError(currentGuard.reason);
              }
              if (interactive && options.resolveAccountPool) {
                try { accountPool = options.resolveAccountPool(); } catch { accountPool = undefined; }
              }
              const sourceRecoveryOnly = interactive && !frozenTarget && options.executionTargetRelay?.sourceRecoveryOnly({ threadId: event.threadId, turnId: event.turnId, body: outgoing });
              if (interactive && (frozenTarget || sourceRecoveryOnly)) options.manualAccountRouting?.assertCompatible({ threadId: event.threadId,
                ...(frozenTarget ? { target: frozenTarget.lease.target } : { sourceRecoveryOnly: true }) });
              if (interactive && !frozenTarget && !sourceRecoveryOnly && options.manualAccountRouting) {
                manualTarget = options.manualAccountRouting.response({ threadId: event.threadId, turnId: event.turnId,
                  model: event.to, body: outgoing, identityConflict: codexRequestIdentity(sourceHeaders).fork.status === "invalid" });
                if (manualTarget && !accountPool) throw new PoolError("pool_manual_policy_changed", 409);
              }
              const interactivePool = interactive && !sourceRecoveryOnly && !manualTarget && accountPool && await accountPool.canSelectInteractiveAsync({
                threadId: event.threadId, requestId: event.requestId, headers, body: outgoing, model: event.to }, request.signal);
              if (frozenTarget && !accountPool) throw new SubscriptionRequestError("execution-target-unavailable");
              if (accountPool && (!options.subscriptionGuard || interactivePool || frozenTarget || manualTarget)) {
                selectingAccount = true;
                poolSelection = await accountPool.selectAsync({ threadId: event.threadId, requestId: event.requestId,
                  body: outgoing, model: event.to, headers, verifiedSource,
                  ...(frozenTarget ? { fixedTarget: { account: frozenTarget.lease.target.account, identity: frozenTarget.lease.target.identity, preserveNativeHistory: true } }
                    : manualTarget ? { fixedTarget: { account: manualTarget.account.id, identity: manualTarget.account.identity, preserveNativeHistory: true, manual: true } } : {}) }, request.signal);
                request.signal.throwIfAborted();
                if (manualTarget && (!poolSelection || poolSelection.route.account !== manualTarget.account.id || poolSelection.identity !== manualTarget.account.identity))
                  throw new PoolError("pool_manual_target_changed", 409);
                if (frozenTarget && !poolSelection) throw new PoolError("pool_execution_target_unavailable", 409);
                poolInput = { body: outgoing, headers: new Headers(headers), verifiedSource };
                if (poolSelection) {
                  selectedGuard = bindSelectedGuard(poolSelection);
                  headers = poolSelection.headers; event.accountRouting = poolSelection.route;
                  if (poolSelection.body !== outgoing) {
                    body = JSON.stringify(poolSelection.body);
                    headers.delete("content-encoding");
                  }
                }
              }
            }
            // Unchanged requests retain their exact original bytes and encoding.
            if (routed.routed || options.reportOnly) {
              body = JSON.stringify(poolSelection?.body ?? routed.body);
              headers.delete("content-encoding");
            }
          }
        }
        // Native tool routes and uninspected continuations of an already-bound
        // managed turn must retain its frozen target, never fall back to A.
        if (interactive && !event && !metadataRequest && options.executionTargetRelay) {
          const identity = codexRequestIdentity(sourceHeaders);
          try { frozenTarget = await options.executionTargetRelay.resolve({ threadId: identity.threadId, turnId: identity.turnId, body: null, identityConflict: identity.conflict || identity.fork.status === "invalid" }); }
          catch (error) { throw new SubscriptionRequestError(error instanceof PoolError ? error.code : "execution-target-unavailable"); }
          if (frozenTarget) {
            options.manualAccountRouting?.assertCompatible({ threadId: identity.threadId, target: frozenTarget.lease.target });
            if (!nativeToolRequest) throw new SubscriptionRequestError("execution-target-request-unverified");
            accountPool = options.resolveAccountPool?.();
            if (!accountPool || !identity.threadId) throw new SubscriptionRequestError("execution-target-unavailable");
            options.executionTargetRelay.assertToolReady(frozenTarget);
            await accountPool.assertTargetContinuationAsync({ threadId: identity.threadId, account: frozenTarget.account.id, identity: frozenTarget.account.identity, sourceIdentity: frozenTarget.lease.source.identity }, request.signal);
            headers.set("authorization", `Bearer ${frozenTarget.account.accessToken}`);
            headers.set("chatgpt-account-id", frozenTarget.account.upstreamAccount);
            selectedGuard = frozenTarget.guard; guardModel = frozenTarget.lease.model;
          }
        }
        if (interactive && !frozenTarget && !event && !metadataRequest && options.manualAccountRouting) {
          const identity = codexRequestIdentity(sourceHeaders);
          manualTarget = options.manualAccountRouting.native({ threadId: identity.threadId, turnId: identity.turnId,
            identityConflict: identity.conflict || identity.fork.status === "invalid" });
          if (manualTarget) {
            if (!nativeToolRequest) throw new PoolError("pool_manual_request_unverified", 409);
            // An already-admitted source turn keeps its original credentials,
            // bytes and guard. A later choice cannot redirect its native tools.
            if (!manualTarget.sourceContinuation) {
              if (headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
                throw new PoolError("pool_manual_request_unverified", 409);
              const inspected = await inspectNativeBody(request, MAX_BODY_BYTES);
              if (!inspected.bytes) { if (inspected.body instanceof ReadableStream) await inspected.body.cancel().catch(() => {}); throw new PoolError("pool_manual_payload_unverified", 409); }
              try {
                const decoded = await decodeRequestBody(inspected.bytes, encoding, MAX_BODY_BYTES, request.signal);
                if (!manualNativeToolPayload(JSON.parse(new TextDecoder().decode(decoded)))) throw new Error("unverified");
              } catch { throw new PoolError("pool_manual_payload_unverified", 409); }
              body = inspected.bytes;
              headers.set("authorization", `Bearer ${manualTarget.account.accessToken}`);
              headers.set("chatgpt-account-id", manualTarget.account.upstreamAccount);
              selectedGuard = options.poolSubscriptionGuard?.(manualTarget.account.id, manualTarget.account.identity);
              if (!selectedGuard) throw new PoolError("pool_manual_quota_unavailable", 409);
            }
            guardModel = manualTarget.choice.model;
          }
        }
        if (interactive && !poolSelection && !frozenTarget && !manualTarget && options.sourceHistoryGuard) {
          const source = options.subscriptionGuard!.checkIdentity({ headers: sourceHeaders });
          if (source.account && source.sourceIdentity) try {
            await options.sourceHistoryGuard({ account: source.account, identity: source.sourceIdentity, headers: sourceHeaders, signal: request.signal });
          } catch (error) {
            if (error instanceof PoolError) throw new SubscriptionRequestError(error.code);
            request.signal.throwIfAborted();
          }
        }
        if (options.subscriptionGuard && (interactive || request.method !== "POST")) {
          const guard = interactive ? checkRequestGuard() : options.subscriptionGuard.checkIdentity({ headers });
          if (!guard.ready) throw new SubscriptionRequestError(guard.reason);
        }
      } catch (error) {
        activeRequests--;
        if (poolSelection && event) await accountPool!.rollbackUnsentAsync(event.requestId).catch(() => {});
        if (request.signal.aborted) {
          if (poolSelection && event) void accountPool!.finishAsync(event.requestId, "cancelled").catch(() => {});
          if (event) record({ ...event, phase: "cancelled", status: 0, errorCode: "client_disconnected", failureOrigin: "client",
            at: new Date().toISOString(), durationMs: Math.round(performance.now() - started), retryCount: 0 });
          return new Response(null, { status: 499 });
        }
        if (error instanceof SubscriptionRequestError) {
          if (poolSelection && event) void accountPool!.finishAsync(event.requestId, "failed").catch(() => {});
          if (event) record({ ...event, phase: "failed", status: 400, errorCode: subscriptionError(error.reason).code, failureOrigin: "relay",
            at: new Date().toISOString(), durationMs: Math.round(performance.now() - started), retryCount: 0 });
          return rejectGuard(error.reason);
        }
        if (selectingAccount || error instanceof PoolError) {
          const code = error instanceof PoolError ? error.code : "pool_request_rejected";
          const status = error instanceof PoolError ? error.status : 503;
          rejectedRequests++;
          if (event) record({ ...event, phase: "failed", status, errorCode: code, failureOrigin: "relay", at: new Date().toISOString(),
            durationMs: Math.round(performance.now() - started), retryCount: 0 });
          void accountPool?.rejectAsync(code, event ? { requestId: event.requestId, threadId: event.threadId, status } : undefined).catch(() => {});
          const responseHeaders = new Headers();
          if (error instanceof PoolError && error.retryAfterSeconds != null)
            responseHeaders.set("retry-after", String(error.retryAfterSeconds));
          return Response.json({ error: { message: error instanceof PoolError ? poolErrorMessage(error) : "QuotaPie account routing is temporarily unavailable. No request was sent to the provider.",
            type: "quotapie_account_pool", code } }, { status, headers: responseHeaders });
        }
        return new Response("Invalid or unsupported request body", { status: 400 });
      }
      let status = 0, finished = false, receivedResponse = false, upstreamAttempted = false;
      let retryCount = 0;
      let transportCode: string | undefined;
      let observer: ResponseCompletionObserver | undefined;
      let responseRequestIds: UpstreamRequestIds | undefined;
      let upstreamBodyPresent: boolean | undefined;
      let upstreamContentLength: number | null | undefined;
      let upstreamBytes = 0, relayQueuedBytes = 0;
      const cancellation = new AbortController();
      let guardTimer: ReturnType<typeof setInterval> | undefined;
      let guardFailure: string | undefined;
      let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
      const sendGuardFailure = () => {
        if (!guardFailure || !downstream) return;
        try {
          // A quota stop is visible to Codex even after SSE headers were sent.
          if (expectsSse) downstream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.failed",
            response: { status: "failed", error: subscriptionError(guardFailure) } })}\n\n`));
          else downstream.error(new Error(subscriptionError(guardFailure).code));
          if (expectsSse) downstream.close();
        } catch { /* The client may already have disconnected. */ }
        downstream = undefined;
      };
      if (event?.routed && event.kind === "compaction") attemptedCompactions++;
      const emit = (phase: CompactionRequestEvent["phase"], errorCode?: string) => {
        if (!event) return;
        const serverError = observer?.serverError;
        const requestIds = { ...responseRequestIds, ...observer?.requestIds };
        const update: CompactionRequestEvent = { ...event, phase, status, at: new Date().toISOString(),
          durationMs: Math.round(performance.now() - started), retryCount,
          ...(transportCode ? { transportCode } : {}), ...(errorCode ? { errorCode, failureOrigin: failureOrigin(errorCode) } : {}),
          ...(Object.keys(requestIds).length ? { upstreamRequestIds: requestIds } : {}), ...(serverError ? { serverError } : {}),
          ...(upstreamBodyPresent === undefined ? {} : { upstreamBodyPresent, upstreamContentLength,
            upstreamBytes, relayQueuedBytes }),
          responseModel: observer?.responseModel ?? null, usage: observer?.usage ?? null };
        record(update);
      };
      const finish = (phase: "completed" | "failed" | "cancelled" | "unverified", errorCode?: string) => {
        if (finished) return;
        finished = true;
        recordNative(status, guardFailure ? "relay" : phase === "cancelled" ? "client" : receivedResponse ? "provider" : "relay",
          guardFailure ?? errorCode ?? (receivedResponse ? "provider-response" : phase));
        activeRequests--;
        clearInterval(guardTimer);
        request.signal.removeEventListener("abort", onAbort);
        if (event?.routed && event.kind === "response" && ["failed", "unverified"].includes(phase)) savingsRouter.failed(event.threadId);
        if (event?.routed && event.kind === "compaction") {
          if (phase === "completed") compactions++;
          if (phase === "failed") failedCompactions++;
          if (phase === "cancelled") cancelledCompactions++;
          if (phase === "unverified") unverifiedCompactions++;
        }
        if (frozenTarget && event) options.executionTargetRelay?.finishRequest(frozenTarget, event.requestId, phase, status, errorCode);
        if (event?.kind === "response") options.manualAccountRouting?.finish(event.threadId, event.requestId, event.turnId, phase, status);
        emit(phase, errorCode);
        if (poolSelection && event) {
          const requestId = event.requestId;
          if (!upstreamAttempted) void accountPool!.rollbackUnsentAsync(requestId)
            .then(() => accountPool!.finishAsync(requestId, phase)).catch(() => {});
          else void accountPool!.finishAsync(requestId, phase).catch(() => {});
        }
      };
      const clientClosed = () => {
        // Codex closes its SSE reader immediately after response.completed;
        // waiting for TCP EOF would misreport every successful native response.
        if (status >= 400) { finish("failed", "upstream_http_error"); return; }
        const terminal = status >= 200 && status < 300 ? observer?.terminal() : null;
        finish(terminal?.phase ?? "cancelled", terminal?.errorCode ?? (terminal ? undefined : "client_disconnected"));
      };
      const onAbort = () => { cancellation.abort(); clientClosed(); };
      const checkSubscription = () => {
        if (finished || guardFailure || !options.subscriptionGuard) return;
        if (receivedResponse && status >= 400) return;
        const check = interactive ? checkRequestGuard() : metadataRequest ? options.subscriptionGuard.checkIdentity()
          : options.subscriptionGuard.check({ model: guardModel });
        if (check.ready) return;
        // A terminal provider result already delivered to the client is final.
        const terminal = observer?.terminal();
        if (terminal) { finish(terminal.phase, terminal.errorCode); return; }
        guardFailure = check.reason; guardAbortedRequests++;
        abortedByReason[check.reason] = (abortedByReason[check.reason] ?? 0) + 1;
        finish("failed", subscriptionError(check.reason).code);
        cancellation.abort();
        void upstreamReader?.cancel().catch(() => {});
        sendGuardFailure();
      };
      emit("started");
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      if (options.subscriptionGuard && !finished) {
        checkSubscription();
        if (!finished) guardTimer = setInterval(checkSubscription, options.subscriptionGuard.intervalMs);
      }
      try {
        if (guardFailure) return Response.json({ error: subscriptionError(guardFailure) }, { status: 400 });
        if (finished || cancellation.signal.aborted) return new Response(null, { status: 499 });
        // Cooldowns are routing evidence and must be durable before failover.
        // Success status is telemetry: enqueue it without delaying any bytes.
        const recordPoolResponse = async (response: Response): Promise<boolean> => {
          if (!poolSelection || !event) return true;
          const write = accountPool!.responseAsync(event.requestId, poolSelection.identity,
            response.status, response.headers.get("retry-after"), poolSelection.credentialDigest);
          if (![401, 403, 429].includes(response.status)) { void write.catch(() => {}); return true; }
          try { await write; return true; } catch { return false; }
        };
        // The transport may retry a connection failure before any response.
        // Recheck the request's protection before each attempt. Metadata uses
        // only identity checks; it never depends on inference allowance.
        const guardedFetch: typeof upstreamFetch = async (target, init) => {
          checkSubscription();
          cancellation.signal.throwIfAborted();
          if (frozenTarget && event) {
            const fingerprint = createHash("sha256").update(path).update(body instanceof Uint8Array ? body : String(body)).digest("hex");
            options.executionTargetRelay?.beginRequest(frozenTarget, event.requestId, fingerprint);
          }
          if (manualTarget && event?.kind === "response") options.manualAccountRouting?.begin(manualTarget, event.requestId, event.turnId);
          else if (event?.kind === "response" && verifiedSource) {
            try { options.manualAccountRouting?.observe({ threadId: event.threadId, turnId: event.turnId, requestId: event.requestId,
              model: event.to, sourceIdentity: verifiedSource.identity,
              ...(poolSelection ? { target: { account: poolSelection.route.account, identity: poolSelection.identity } } : {}),
              sourceContinuation: !poolSelection && !frozenTarget }); } catch { /* Observation cannot interrupt an unchanged source request. */ }
          }
          upstreamAttempted = true;
          return upstreamFetch(target, init);
        };
        const target = `${UPSTREAM}${path}${url.search}`;
        const init: RequestInit = { method: request.method, headers, body, redirect: "manual", signal: cancellation.signal };
        // Streaming uploads and unknown native mutations must not be replayed.
        let response = interactive && (frozenTarget || manualTarget || !event || body instanceof ReadableStream)
          ? await guardedFetch(target, init)
          : await fetchCodexUpstream(guardedFetch, target, init, code => { retryCount++; transportCode = code; });
        receivedResponse = true;
        status = response.status;
        if (frozenTarget) options.executionTargetRelay?.recordResponse(frozenTarget, event?.requestId ?? nativeRequestId, status);
        responseRequestIds = upstreamRequestIds(response.headers);
        // A web-search service throttle is not evidence that model quota was
        // exhausted. Forward its error without poisoning later model requests.
        if (!metadataRequest && !searchRequest) (selectedGuard ?? options.subscriptionGuard)?.observeResponse?.(status);
        const cooldownRecorded = await recordPoolResponse(response);
        // A rejected HTTP request has produced no model output. Retry once with
        // complete portable history; never retry a 200 stream or partial output.
        if (!frozenTarget && !manualTarget && (!options.subscriptionGuard || interactive && poolSelection) && status === 429 && cooldownRecorded && poolSelection && poolInput && event && !finished && !cancellation.signal.aborted) {
          let replacement: ReturnType<AccountPool["select"]> = null;
          const nextId = randomUUID();
          try {
            if (await accountPool!.canRecoverAsync(poolSelection.route.account, event.to, poolInput.body, cancellation.signal))
              replacement = await accountPool!.selectAsync({ threadId: event.threadId, requestId: nextId,
                body: poolInput.body, model: event.to, headers: poolInput.headers, verifiedSource: poolInput.verifiedSource }, cancellation.signal);
          } catch { /* Preserve the original 429 when safe recovery is unavailable. */ }
          if (finished || cancellation.signal.aborted) {
            if (replacement) await accountPool!.rollbackUnsentAsync(nextId).catch(() => {});
            await response.body?.cancel();
            return new Response(null, { status: 499 });
          }
          let replacementGuard: SubscriptionGuard | undefined;
          if (replacement?.route.reason === "recovered") try { replacementGuard = bindSelectedGuard(replacement); }
          catch { await accountPool!.rollbackUnsentAsync(nextId).catch(() => {}); replacement = null; }
          if (replacement?.route.reason === "recovered") {
            emit("failed", "account_rate_limited");
            void accountPool!.finishAsync(event.requestId, "failed").catch(() => {});
            await response.body?.cancel();
            if (finished || cancellation.signal.aborted) {
              await accountPool!.rollbackUnsentAsync(nextId).catch(() => {});
              return new Response(null, { status: 499 });
            }
            poolSelection = replacement; headers = replacement.headers; selectedGuard = replacementGuard; upstreamAttempted = false;
            headers.delete("content-encoding"); body = JSON.stringify(replacement.body);
            event = { ...event, requestId: nextId, accountRouting: replacement.route };
            retryCount++; status = 0; receivedResponse = false; responseRequestIds = undefined; emit("started");
            response = await fetchCodexUpstream(guardedFetch, `${UPSTREAM}${path}${url.search}`, {
              method: request.method, headers, body, redirect: "manual", signal: cancellation.signal,
            }, code => { retryCount++; transportCode = code; });
            receivedResponse = true;
            status = response.status;
            responseRequestIds = upstreamRequestIds(response.headers);
            (selectedGuard ?? options.subscriptionGuard)?.observeResponse?.(status);
            await recordPoolResponse(response);
          }
        }
        if (finished) { await response.body?.cancel(); return guardFailure
          ? Response.json({ error: subscriptionError(guardFailure) }, { status: 400 }) : new Response(null, { status: 499 }); }
        if (!interactive && [301, 302, 303, 307, 308].includes(status)) {
          await response.body?.cancel(); finish("failed", "upstream_redirect");
          return new Response("Unexpected Codex upstream redirect", { status: 502 });
        }
        if (event) requests++;
        upstreamBodyPresent = response.body != null;
        const length = response.headers.get("content-length");
        const parsedLength = length != null && /^\d+$/.test(length) ? Number(length) : null;
        upstreamContentLength = Number.isSafeInteger(parsedLength) ? parsedLength : null;
        emit("response_headers");
        const responseHeaders = transportHeaders(response.headers);
        responseHeaders.delete("content-encoding");
        if (interactive && [301, 302, 303, 307, 308].includes(status) && responseHeaders.has("location")) {
          const destination = new URL(responseHeaders.get("location")!, target);
          if (destination.origin !== "https://chatgpt.com" || !destination.pathname.startsWith("/backend-api/codex/")) {
            await response.body?.cancel(); finish("failed", "upstream_redirect");
            return new Response("Codex redirect leaves the source endpoint", { status: 502 });
          }
          responseHeaders.set("location", prefix + destination.pathname.slice("/backend-api/codex".length) + destination.search);
        }
        // Responses Lite can omit Content-Type. Only a known Responses route
        // supplies a fallback; untyped HTTP errors may be plain text.
        const responseRoute = ["/responses", "/responses/compact"].includes(path);
        const contentType = (response.headers.get("content-type") || (response.ok && responseRoute
          ? expectsSse ? "text/event-stream" : "application/json" : "")).toLowerCase();
        const mediaType = contentType.split(";", 1)[0]!.trim();
        const jsonType = mediaType === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
        observer = new ResponseCompletionObserver(jsonType ? "application/json" : contentType, event?.kind === "compaction", status);
        const ownershipFormat = mediaType === "text/event-stream" ? "sse"
          : responseRoute && jsonType ? "json" : null;
        const provenance = (entry: OwnershipProvenance) => {
          options.onProvenance?.({ requestId: event?.requestId ?? nativeRequestId, ...entry });
        };
        const responseIdentity = { ...requestIdentity(request.headers), sessionId: codexRequestIdentity(request.headers).sessionId };
        const ownership = ownershipFormat ? interactive
          ? new NativeResponseOwnershipGuard(responseIdentity, provenance, ownershipFormat)
          : new ResponseOwnershipGuard(responseIdentity, provenance, undefined, ownershipFormat) : undefined;
        const reader = response.body?.getReader();
        upstreamReader = reader;
        if (!reader) {
          const result = observer.finish();
          finish(response.ok ? result.phase : "failed", response.ok ? result.errorCode : "upstream_http_error");
          return new Response(null, { status, headers: responseHeaders });
        }
        let prefetchedOutput: Uint8Array[] = [];
        if (ownershipFormat === "json") {
          // Inspect JSON before sending headers while it fits the bound. Native
          // bodies exceeding it switch to streaming, preserving original bytes;
          // managed execution retains strict bounded inspection.
          let ended = false;
          try {
            while (true) {
              const next = await reader.read();
              if (finished) { await reader.cancel(); return new Response(null, { status: 499 }); }
              if (next.done) {
                ownership!.finish(bytes => prefetchedOutput.push(bytes)); ended = true; break;
              }
              upstreamBytes += next.value.byteLength;
              ownership!.push(next.value, bytes => prefetchedOutput.push(bytes));
              if (ownership instanceof NativeResponseOwnershipGuard && ownership.passthrough) break;
            }
            if (ended) {
              const output = Buffer.concat(prefetchedOutput);
              observer.push(output); relayQueuedBytes += output.byteLength;
              const result = observer.finish();
              finish(response.ok ? result.phase : "failed", response.ok ? result.errorCode : "upstream_http_error");
              return new Response(new Uint8Array(output), { status, headers: responseHeaders });
            }
          } catch (error) {
            if (!(error instanceof ResponseOwnershipError)) throw error;
            finish("failed", error.code);
            cancellation.abort();
            void reader.cancel().catch(() => {});
            return Response.json({ error: { type: "quotapie_response_ownership", code: error.code,
              message: "QuotaPie blocked an invalid or foreign response before delivery." } }, { status: 502 });
          }
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { downstream = controller; sendGuardFailure(); },
          async pull(controller) {
            try {
              if (prefetchedOutput.length) {
                for (const bytes of prefetchedOutput) {
                  observer!.push(bytes); controller.enqueue(bytes); relayQueuedBytes += bytes.byteLength;
                }
                prefetchedOutput = [];
                return;
              }
              // A fragmented event can require several upstream reads before
              // producing a downstream chunk. Keep satisfying this pull until
              // a checked frame is available (Bun need not re-pull on silence).
              while (true) {
                if (guardFailure) { sendGuardFailure(); return; }
                const next = await reader.read();
                if (guardFailure) { sendGuardFailure(); return; }
                let delivered = false;
                const deliver = (bytes: Uint8Array) => {
                  delivered = true;
                  observer!.push(bytes);
                  controller.enqueue(bytes);
                  relayQueuedBytes += bytes.byteLength;
                };
                if (next.done) {
                  ownership?.finish(deliver);
                  const result = observer!.finish();
                  finish(response.ok ? result.phase : "failed", response.ok ? result.errorCode : "upstream_http_error");
                  controller.close();
                  return;
                } else {
                  upstreamBytes += next.value.byteLength;
                  if (ownership) ownership.push(next.value, deliver);
                  else deliver(next.value);
                  // A native client may start its next tool request as soon as
                  // it reads response.completed, before closing this reader.
                  // Check the entire current chunk for ownership conflicts first,
                  // then end this frozen request at its verified terminal frame.
                  if (frozenTarget && response.ok && ownershipFormat === "sse" &&
                      !(ownership instanceof NativeResponseOwnershipGuard && ownership.passthrough) &&
                      observer!.terminal()?.phase === "completed") {
                    finish("completed"); controller.close();
                    void reader.cancel().catch(() => {});
                    return;
                  }
                  if (delivered) return;
                }
              }
            } catch (error) {
              if (guardFailure) { sendGuardFailure(); return; }
              if (error instanceof ResponseOwnershipError) {
                // Ownership failure overrides even a prior completion. Stop this
                // reader only; never retry a stream that may have produced tools.
                finish("failed", error.code);
                cancellation.abort();
                void reader.cancel().catch(() => {});
                // HTTP headers may already be sent. Emit a content-free protocol
                // error rather than relying on a TCP close the client can miss.
                const failure = new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.failed",
                  response: { status: "failed", error: { type: "quotapie_response_ownership", code: error.code,
                    message: "QuotaPie blocked an invalid or foreign response event before delivery." } } })}\n\n`);
                controller.enqueue(failure);
                relayQueuedBytes += failure.byteLength;
                controller.close();
                return;
              }
              transportCode = transportFailure(error).transportCode;
              // A protocol terminal event is authoritative even if the socket
              // closes with an error afterward, just as with client cancellation.
              // Never replace an already forwarded provider result with a relay error.
              const terminal = response.ok ? observer!.terminal() : null;
              if (!cancellation.signal.aborted && terminal) {
                finish(terminal.phase, terminal.errorCode);
                controller.close();
                return;
              }
              if (cancellation.signal.aborted) clientClosed();
              else finish("failed", response.ok ? "upstream_stream_interrupted" : "upstream_http_error");
              controller.error(new Error("Codex upstream stream interrupted"));
            }
          },
          async cancel() {
            cancellation.abort(); clientClosed();
            await reader.cancel().catch(() => {});
          },
        });
        return new Response(stream, { status, headers: responseHeaders });
      } catch (error) {
        if (guardFailure) return Response.json({ error: subscriptionError(guardFailure) }, { status: 400 });
        if (cancellation.signal.aborted) {
          clientClosed();
          return new Response(null, { status: 499 });
        }
        if (error instanceof PoolError) {
          finish("failed",error.code);
          return Response.json({error:{type:"quotapie_execution_target",code:error.code,message:"QuotaPie stopped a repeated or unconfirmed native recovery request."}},{status:error.status});
        }
        const failure = transportFailure(error);
        transportCode = failure.transportCode;
        const code = receivedResponse ? "relay_response_error" : failure.errorCode;
        finish("failed", code);
        return new Response(`QuotaPie relay: ${code}`, { status: 502 });
      }
    },
  };
}

export function startCompactionProxy(options: CompactionProxyOptions = {}) {
  const handler = createCompactionHandler(options);
  const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? 0,
    idleTimeout: 0, maxRequestBodySize: options.executionMode === "interactive" ? Infinity : MAX_BODY_BYTES, fetch: handler.fetch });
  return {
    baseUrl: `http://127.0.0.1:${server.port}${handler.prefix}`,
    stop: () => server.stop(true),
  };
}

export function compactionCodexArgs(baseUrl: string, args: string[]): string[] {
  const overrides: string[] = [], forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { forwarded.push(...args.slice(i)); break; }
    const override = arg === "-c" || arg === "--config" ? args[++i]
      : arg.startsWith("--config=") ? arg.slice(9) : arg.startsWith("-c") && arg !== "-c" ? arg.slice(2) : undefined;
    const key = override?.split("=", 1)[0]?.replace(/["'\s]/g, "");
    if (key && /(?:^|\.)(?:model_provider|model_providers|openai_base_url)(?:\.|$)/.test(key))
      throw new Error("QuotaPie controls the subscription-protected provider endpoint; provider overrides are not supported.");
    if (override !== undefined) overrides.push("-c", override);
    else {
      if (arg === "-c" || arg === "--config") throw new Error("Missing Codex configuration value");
      forwarded.push(arg);
    }
  }
  // The installed CLI's exec-local -c vector replaces root-level overrides.
  // Keep every override in one scope so a later effort option cannot silently
  // remove this invocation's provider, endpoint or retry controls.
  const provider = `model_providers.quotapie_compaction={name="OpenAI",base_url=${JSON.stringify(baseUrl)},wire_api="responses",requires_openai_auth=true,supports_websockets=false}`;
  return [...overrides, "-c", 'model_provider="quotapie_compaction"', "-c", provider,
    "-c", `openai_base_url=${JSON.stringify(baseUrl)}`, ...forwarded];
}

export async function runCompactionCodex(args: string[], defaultCommand: string): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: quotapie codex [--codex-bin PATH] [--compact-from MODEL] [--compact-model MODEL] [--compact-effort low] -- [Codex arguments]");
    console.log("Default: preserve the native model. Use --compact-model to enable compaction routing. Requires an existing ChatGPT login. Experimental; applies only to this launched process.");
    return 0;
  }
  const separator = args.indexOf("--");
  const wrapperArgs = separator < 0 ? args : args.slice(0, separator);
  const codexArgs = separator < 0 ? [] : args.slice(separator + 1);
  const route: CompactionRoute = interactiveRelayPolicy().route;
  let command = defaultCommand;
  for (let i = 0; i < wrapperArgs.length; i += 2) {
    const option = wrapperArgs[i];
    const value = wrapperArgs[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    switch (option) {
      case "--compact-from": route.from = value; break;
      case "--compact-model": route.to = value; break;
      case "--compact-effort": if (value !== "low") throw new Error("Only Low compaction effort has been validated"); route.effort = value; break;
      case "--codex-bin": command = value; break;
      default: throw new Error("Usage: quotapie codex [--codex-bin PATH] [--compact-from MODEL] [--compact-model MODEL] [--compact-effort low] -- [Codex arguments]");
    }
  }
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const config = () => loadConfig();
  const sourceAccount = config().accounts.codex.find(profile => {
    try { return profile.enabled && realpathSync(codexProfileRoot(profile)) === realpathSync(codexHome); }
    catch { return false; }
  })?.id;
  const diagnostics = createRelayDiagnostics(line => console.error(line));
  const proxy = startCompactionProxy({
    route,
    executionMode: "interactive",
    sourceHistoryGuard: createSourceHistoryGuard({ forkParent: thread => readCodexForkParent(codexHome, thread) }),
    sourceHistoryPolicy: "authenticated-source",
    savingsModelSupported: createSavingsModelSupport(join(codexHome, "models_cache.json")),
    subscriptionGuard: createSubscriptionGuard({ codexHome, sourceAccount, config, quotaObservationMode: "advisory", executionMode: "interactive" }),
    onNativeRequest: diagnostics.onNativeRequest,
    onProvenance: diagnostics.onProvenance,
    onRequest: diagnostics.onRequest,
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const interrupt = () => child?.kill("SIGINT");
  const terminate = () => child?.kill("SIGTERM");
  try {
    child = Bun.spawn([command, ...compactionCodexArgs(proxy.baseUrl, codexArgs)], {
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    return await child.exited;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    proxy.stop();
  }
}
