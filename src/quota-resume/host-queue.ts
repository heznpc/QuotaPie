import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexProfileRoot, type AppConfig } from "../config";
import { CodexAppServerClient, type CodexThreadTurnSummary } from "../providers/codex-appserver";
import type { WorkPolicy, WorkResult } from "../work/types";
import { readQuotaResumeEvidence } from "./evidence";
import { metadataPath } from "../dots/thread-reader";

export interface HostQueueReceipt {
  threadId: string;
  clientUserMessageId: string;
  sentAtMs: number;
  queuedSubmissionId?: string;
  turnId?: string;
}

export interface HostQueueClient {
  listThreadQueue(threadId: string, params?: { cursor?: string | null; limit?: number }): Promise<{
    data: Array<{ id: string; clientUserMessageId: string }>; nextCursor: string | null;
  }>;
  addThreadQueue(threadId: string, clientUserMessageId: string, text: string, beforeWrite?: () => void): Promise<{ id: string; clientUserMessageId: string }>;
  deleteThreadQueue(threadId: string, queuedSubmissionId: string): Promise<boolean>;
  readTurnForClientMessage(threadId: string, clientUserMessageId: string, afterTurnId?: string): Promise<CodexThreadTurnSummary | null>;
  readTurn?(threadId: string, turnId: string): Promise<CodexThreadTurnSummary | null>;
  readLatestTurn?(threadId: string): Promise<CodexThreadTurnSummary | null>;
}

interface ReceiptOptions {
  client: HostQueueClient;
  onReceipt(receipt: HostQueueReceipt): void | Promise<void>;
  afterTurnId?: string;
}

export interface HostQueueOptions {
  stillAuthorized(): boolean;
  /** Account, quota, and host-goal checks immediately before the durable intent. */
  beforeEnqueue(): Promise<void>;
  onReceipt(receipt: HostQueueReceipt): void | Promise<void>;
  signal?: AbortSignal;
  client?: HostQueueClient;
  readEvidence?: typeof readQuotaResumeEvidence;
  hasNativeWriter?: () => boolean;
  evidenceStillCurrent?: () => boolean;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pollMs?: number;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const REMAINING_UNKNOWN = "남은 작업과 목표 완료 여부는 아직 확인하지 않았습니다.";

/** Stable across collector restarts; it is correlation, not provider deduplication. */
export function hostQueueClientMessageId(claimId: string): string {
  const bytes = createHash("sha256").update(`quotapie-host-quota-resume:${claimId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeReason(error: unknown, fallback: string): string {
  return error instanceof Error && /^[a-z][a-z0-9-]{2,99}$/.test(error.message) ? error.message : fallback;
}

/** One read-only reconciliation step. A queue miss never proves non-execution. */
export async function observeHostQueueReceipt(receipt: HostQueueReceipt, options: ReceiptOptions): Promise<WorkResult | null> {
  if (!UUID.test(receipt.threadId) || !UUID.test(receipt.clientUserMessageId) || !Number.isFinite(receipt.sentAtMs))
    throw new Error("host-queue-receipt-invalid");
  const turn = receipt.turnId !== undefined && options.client.readTurn
    ? await options.client.readTurn(receipt.threadId, receipt.turnId)
    : await options.client.readTurnForClientMessage(receipt.threadId, receipt.clientUserMessageId, options.afterTurnId);
  if (!turn) {
    if (receipt.queuedSubmissionId === undefined) {
      const queue = await options.client.listThreadQueue(receipt.threadId, { limit: 100 });
      const owned = queue.data.filter(item => item.clientUserMessageId === receipt.clientUserMessageId);
      if (owned.length > 1) throw new Error("host-queue-correlation-ambiguous");
      if (owned.length === 1) {
        const observed = { ...receipt, queuedSubmissionId: owned[0]!.id };
        await options.onReceipt(observed);
        receipt.queuedSubmissionId = observed.queuedSubmissionId;
      }
    }
    return null;
  }
  if (turn.threadId !== receipt.threadId || !UUID.test(turn.turnId) ||
      (receipt.turnId !== undefined && receipt.turnId !== turn.turnId) ||
      (turn.completedAtMs !== null && turn.completedAtMs + 1000 < receipt.sentAtMs))
    throw new Error("host-queue-turn-identity-changed");
  if (receipt.turnId !== turn.turnId) {
    const observed = { ...receipt, turnId: turn.turnId };
    await options.onReceipt(observed);
    receipt.turnId = turn.turnId;
  }
  if (turn.status === "inProgress") return null;
  if (turn.completedAtMs === null) return null;
  if (turn.status === "completed") return {
    status: "turn-finished", summary: "1회 재개 종료", remainingWork: REMAINING_UNKNOWN,
  };
  if (turn.status === "interrupted") return { status: "activity-paused", reason: "host-queue-turn-interrupted" };
  return turn.errorCode === "usageLimitExceeded"
    ? { status: "quota-blocked", reason: "host-queue-quota-blocked" }
    : { status: "failed", reason: "host-queue-turn-failed" };
}

async function pause(milliseconds: number, signal: AbortSignal | undefined, custom?: HostQueueOptions["sleep"]): Promise<void> {
  if (signal?.aborted) return;
  if (custom) { await custom(milliseconds); return; }
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

/** Cancel only our still-visible queued message. A host may already hold a copy,
 * so neither deleted:true nor an empty list is an execution-cancellation receipt. */
export async function removeOwnHostQueuedInput(receipt: HostQueueReceipt, options: ReceiptOptions): Promise<void> {
  try {
    const queue = await options.client.listThreadQueue(receipt.threadId, { limit: 100 });
    const owned = queue.data.filter(item => item.clientUserMessageId === receipt.clientUserMessageId);
    if (owned.length !== 1) return;
    const item = owned[0]!;
    if (receipt.queuedSubmissionId !== undefined && receipt.queuedSubmissionId !== item.id) return;
    if (receipt.queuedSubmissionId === undefined) {
      const observed = { ...receipt, queuedSubmissionId: item.id };
      await options.onReceipt(observed);
      receipt.queuedSubmissionId = item.id;
    }
    await options.client.deleteThreadQueue(receipt.threadId, item.id);
  } catch { /* Keep the durable execution fence; never retry enqueue. */ }
}

/** Writes one durable message through the official queue API. Only the existing
 * native host may consume it; this adapter never loads, starts, or stops a turn. */
export async function executeHostQueuedQuotaResume(
  request: { config: AppConfig; policy: WorkPolicy; claimId: string }, options: HostQueueOptions,
): Promise<WorkResult> {
  const { config, policy, claimId } = request;
  const now = options.now ?? Date.now, startedAt = now();
  const done = (result: WorkResult): WorkResult => ({ ...result, durationSeconds: Math.max(0, (now() - startedAt) / 1000) });
  if (policy.purpose !== "quota-resume" || policy.provider !== "codex" || policy.dispatchOwner !== "local" ||
      policy.trigger !== "quota-ready" || policy.maxTurns !== 1 || !policy.quotaResume || !UUID.test(policy.nativeSessionId) || !claimId)
    return done({ status: "failed", reason: "quota-resume-evidence-required" });
  const deadline = Math.min(policy.expiresAtMs, policy.workDeadline ?? Infinity,
    startedAt + Math.min(policy.maxDurationSeconds, policy.maxTotalDurationSeconds - policy.state.totalDurationSeconds) * 1000);
  if (!Number.isFinite(deadline) || deadline <= startedAt) return done({ status: "time-budget-ended", reason: "host-queue-time-budget-ended" });
  let root: string;
  try {
    const profile = config.accounts.codex.find(p => p.enabled && p.id === policy.account);
    if (!profile) throw new Error("profile-unavailable");
    root = realpathSync(codexProfileRoot(profile));
  } catch (error) { return done({ status: "failed", reason: safeReason(error, "profile-unavailable") }); }
  const ownedClient = options.client ? undefined : new CodexAppServerClient(config.collection.codexCommand, policy.account, 8_000, root);
  const client: HostQueueClient = options.client ?? ownedClient!;
  const hasNativeWriter = options.hasNativeWriter ?? (() => {
    try { return lstatSync(join(root, "thread-writer-locks", `${policy.nativeSessionId}.lock`)).isFile(); }
    catch { return false; }
  });
  const evidenceStillCurrent = options.evidenceStillCurrent ?? (() => {
    try {
      const path = metadataPath(root, policy.nativeSessionId), stat = statSync(path);
      return stat.isFile() && policy.quotaResume!.stamp === `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch { return false; }
  });
  const authorized = () => !options.signal?.aborted && options.stillAuthorized() && now() < deadline;
  const receipt: HostQueueReceipt = { threadId: policy.nativeSessionId, clientUserMessageId: hostQueueClientMessageId(claimId), sentAtMs: now() };
  const receiptOptions = { client, onReceipt: options.onReceipt, afterTurnId: policy.quotaResume.turnId };
  let sendAttempted = false;
  try {
    if (!authorized()) return done({ status: "activity-paused", reason: "host-queue-authorization-changed" });
    if (!hasNativeWriter()) return done({ status: "failed", reason: "native-writer-unavailable" });
    const initial = await client.listThreadQueue(receipt.threadId, { limit: 100 });
    if (initial.data.length || initial.nextCursor !== null)
      return done({ status: "activity-paused", reason: "host-queue-not-empty" });
    await options.beforeEnqueue();
    const queue = await client.listThreadQueue(receipt.threadId, { limit: 100 });
    if (queue.data.length || queue.nextCursor !== null)
      return done({ status: "activity-paused", reason: "host-queue-not-empty" });
    const evidence = await (options.readEvidence ?? readQuotaResumeEvidence)(config, policy.account, receipt.threadId, {
      allowNativeWriter: true, now,
      ...(client.readLatestTurn ? { readLatestTurn: (id: string) => client.readLatestTurn!(id) } : {}),
    });
    if (!evidence || evidence.threadId !== receipt.threadId || evidence.turnId !== policy.quotaResume.turnId ||
        evidence.stamp !== policy.quotaResume.stamp || evidence.cwd !== policy.cwd || (policy.model !== undefined && evidence.model !== policy.model))
      return done({ status: "activity-paused", reason: "quota-resume-evidence-changed" });
    // Evidence reads can wait on the provider. Re-read the host goal and
    // authorization afterward instead of relying on the earlier cached state.
    await options.beforeEnqueue();
    if (!authorized()) return done({ status: "activity-paused", reason: "host-queue-authorization-changed" });
    if (!hasNativeWriter()) return done({ status: "failed", reason: "native-writer-unavailable" });
    receipt.sentAtMs = now();
    await options.onReceipt({ ...receipt });
    if (!authorized() || !hasNativeWriter()) return done({ status: "activity-paused", reason: "host-queue-authorization-changed" });
    sendAttempted = true;
    const queued = await client.addThreadQueue(receipt.threadId, receipt.clientUserMessageId, policy.prompt, () => {
      if (!authorized() || !hasNativeWriter()) throw new Error("host-queue-authorization-changed");
      if (!evidenceStillCurrent()) throw new Error("quota-resume-evidence-changed");
    });
    if (!UUID.test(queued.id) || queued.clientUserMessageId !== receipt.clientUserMessageId)
      throw new Error("host-queue-receipt-invalid");
    receipt.queuedSubmissionId = queued.id;
    await options.onReceipt({ ...receipt });
    while (authorized()) {
      const result = await observeHostQueueReceipt(receipt, receiptOptions);
      if (result) return done(result);
      await pause(Math.max(1, Math.min(options.pollMs ?? 2_000, deadline - now())), options.signal, options.sleep);
    }
    await removeOwnHostQueuedInput(receipt, receiptOptions);
    // Deleting a queue row can race the owner's dispatch. Only correlated
    // terminal evidence can close the fence after acceptance or an abort.
    const observed = await observeHostQueueReceipt(receipt, receiptOptions).catch(() => null);
    return done(observed ?? { status: "uncertain", reason: now() >= deadline ? "host-queue-timeout" : "host-queue-authorization-changed" });
  } catch (error) {
    if (!sendAttempted) return done({ status: "failed", reason: safeReason(error, "host-queue-preflight-unavailable") });
    await removeOwnHostQueuedInput(receipt, receiptOptions);
    const observed = await observeHostQueueReceipt(receipt, receiptOptions).catch(() => null);
    return done(observed ?? { status: "uncertain", reason: safeReason(error, "host-queue-delivery-unconfirmed") });
  } finally { await ownedClient?.close(); }
}
