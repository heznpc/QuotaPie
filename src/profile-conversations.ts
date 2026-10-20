import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDirectory, type AppConfig } from "./config";
import { poolAccounts, readPoolPolicy, type PoolAccount, type PoolPolicy } from "./account-pool";
import { codexSessionLocation, type CodexSessionLocation, type SessionLocationOptions } from "./session-location";
import { CodexAppServerClient, type CodexThreadListParams, type CodexThreadListPage } from "./providers/codex-appserver";
import { observeHostQueueReceipt, wakeAcceptedHostQueue, type HostQueueClient, type HostQueueReceipt } from "./quota-resume/host-queue";
import { wakeHostQueuedThread } from "./quota-resume/host-wake";
import { inspectNativeTargetOwner } from "./work/native-target-lease";
import type { WorkPolicy } from "./work/types";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ACCOUNT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type State = "preparing" | "sending" | "queued" | "running" | "completed" | "failed" | "uncertain";
export class ProfileConversationError extends Error {
  constructor(readonly code: string, readonly status = 409, readonly accepted?: false) { super(code); }
}
interface Client extends HostQueueClient {
  listThreads(params?: CodexThreadListParams): Promise<CodexThreadListPage>;
  readLatestTurn: NonNullable<HostQueueClient["readLatestTurn"]>;
  close(): Promise<void>;
}
interface Binding {
  account: string; ownerAccount: string; credentialRoot: string; sessionRoot: string;
  consolidated: boolean; manifestSHA256?: string; consentIdentity: string; ownerIdentity: string;
}
interface Row {
  id: string; account: string; thread_id: string; text_hash: string; binding: string;
  state: State; reason: string | null; receipt: string | null; prior_turn: string | null; creator_pid: number;
  native_owner: string | null; pool_hash: string | null;
}
interface Options {
  databasePath?: string; sessionLocation?: SessionLocationOptions;
  client?: (location: CodexSessionLocation) => Client;
  accounts?: () => PoolAccount[]; pool?: () => PoolPolicy;
  owner?: (account: string, threadId: string) => Promise<{ pid: number; startedAtMs: number }>;
  wake?: typeof wakeHostQueuedThread; now?: () => number;
}
export interface ProfileMessageReply {
  submissionId: string; threadId: string;
  state: "queued" | "running" | "completed" | "failed" | "uncertain"; reason?: string;
}

/** User-authored queue input only. This does not create goals, change accounts,
 * choose a quota target, start a desktop process, or retry an inference. */
export class ProfileConversations {
  private readonly path: string;
  private closed = false;
  private readonly clients = new Map<string, Client>();
  private readonly observing = new Map<string, Promise<ProfileMessageReply>>();
  constructor(private readonly config: AppConfig, private readonly options: Options = {}) {
    this.path = options.databasePath ?? join(dataDirectory(), "profile-messages.sqlite3");
  }
  async close() { this.closed = true; await Promise.allSettled([...this.clients.values()].map(client => client.close())); this.clients.clear(); }
  private error(code: string): never { throw new ProfileConversationError(code); }
  private location(account: string, threadId?: string) {
    if (this.closed || !ACCOUNT.test(account) || threadId !== undefined && !UUID.test(threadId)) this.error("profile_message_invalid");
    try { const value = codexSessionLocation(this.config, account, threadId, this.options.sessionLocation);
      if (value) return value;
    } catch { /* Never fall back to a retired root. */ }
    return this.error("profile_session_unavailable");
  }
  private accounts() { return (this.options.accounts ?? (() => poolAccounts(this.config)))(); }
  private binding(account: string, threadId?: string): { location: CodexSessionLocation; value: Binding } {
    const location = this.location(account, threadId), accounts = this.accounts();
    const consent = accounts.find(a => a.id === account), owner = accounts.find(a => a.id === location.ownerAccount);
    if (!consent || !owner) this.error("profile_identity_unavailable");
    return { location, value: { account, ownerAccount: location.ownerAccount, credentialRoot: location.credentialRoot,
      sessionRoot: location.sessionRoot, consolidated: location.consolidated, manifestSHA256: location.manifestSHA256,
      consentIdentity: consent.identity, ownerIdentity: owner.identity } };
  }
  private same(bound: Binding, threadId?: string) {
    try { return JSON.stringify(this.binding(bound.account, threadId).value) === JSON.stringify(bound); } catch { return false; }
  }
  private client(location: CodexSessionLocation): Client {
    const existing = this.clients.get(location.sessionRoot);
    if (existing) return existing;
    if (this.options.client) { const client = this.options.client(location); this.clients.set(location.sessionRoot, client); return client; }
    const client = new CodexAppServerClient(this.config.collection.codexCommand, location.ownerAccount, 8000, location.sessionRoot);
    const wrapped: Client = { listThreads: params => client.listVerifiedThreads(params), readLatestTurn: id => client.readLatestTurn(id),
      listThreadQueue: (id, params) => client.listThreadQueue(id, params),
      addThreadQueue: (id, clientId, text, check) => client.addThreadQueue(id, clientId, text, check),
      deleteThreadQueue: (id, queueId) => client.deleteThreadQueue(id, queueId),
      readTurnForClientMessage: (id, clientId, after) => client.readTurnForClientMessage(id, clientId, after),
      readTurn: (id, turnId) => client.readTurn(id, turnId), close: () => client.close() };
    this.clients.set(location.sessionRoot, wrapped); return wrapped;
  }
  private async owner(account: string, threadId: string) {
    try { return await (this.options.owner ?? ((account, nativeSessionId) => inspectNativeTargetOwner(this.config,
      { account, nativeSessionId } as WorkPolicy)))(account, threadId); }
    catch { return this.error("profile_host_unavailable"); }
  }
  private poolReady(bound: Binding): string {
    const pool = (this.options.pool ?? readPoolPolicy)(), now = (this.options.now ?? Date.now)(), accounts = this.accounts();
    if (!pool.enabled || !pool.accounts.includes(bound.account) || !pool.accounts.includes(bound.ownerAccount))
      this.error("profile_pool_not_enabled");
    if (!accounts.some(a => pool.accounts.includes(a.id) && a.tokenExpiresAt > now + 30_000 && a.models.length > 0 &&
      a.remaining !== null && a.remaining > (pool.reservePercent?.[a.id] ?? 0) && a.validUntil > now))
      this.error("profile_pool_quota_unavailable");
    return hash(JSON.stringify(pool));
  }
  private db<T>(run: (db: Database) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (existsSync(this.path)) {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o022)
        this.error("profile_receipt_unavailable");
    }
    const db = new Database(this.path, { create: true, strict: true });
    try {
      chmodSync(this.path, 0o600); db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL");
      db.exec(`CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,account TEXT NOT NULL,thread_id TEXT NOT NULL,
        text_hash TEXT NOT NULL,binding TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,receipt TEXT,prior_turn TEXT,creator_pid INTEGER NOT NULL,
        native_owner TEXT,pool_hash TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS one_pending_message ON messages(thread_id,json_extract(binding,'$.sessionRoot'))
        WHERE state IN ('preparing','sending','queued','running','uncertain')`);
      return run(db);
    } finally { db.close(); }
  }
  private read(id: string): Row | null { return this.db(db => db.query<Row, [string]>("SELECT * FROM messages WHERE id=?").get(id)); }
  private update(id: string, state: State, reason: string | null, receipt?: HostQueueReceipt, claimWake = false) {
    this.db(db => db.transaction(() => {
      const prior = db.query<Row, [string]>("SELECT * FROM messages WHERE id=?").get(id);
      if (!prior || ["completed", "failed"].includes(prior.state)) {
        if (claimWake) this.error("profile_wake_superseded");
        return;
      }
      const before = prior.receipt ? JSON.parse(prior.receipt) as HostQueueReceipt : null;
      if (claimWake && (!before || before.turnId || receipt?.hostWakeAttemptCount !== (before.hostWakeAttemptCount ?? 0) + 1))
        this.error("profile_wake_superseded");
      if (before && receipt && (before.turnId && receipt.turnId && before.turnId !== receipt.turnId ||
        before.queuedSubmissionId && receipt.queuedSubmissionId && before.queuedSubmissionId !== receipt.queuedSubmissionId))
        this.error("profile_receipt_conflict");
      const merged = receipt ? { ...before, ...receipt, ...(before?.turnId ? { turnId: before.turnId } : {}) } : before;
      if (before && merged && ((before.hostWakeAttemptCount ?? 0) > (receipt?.hostWakeAttemptCount ?? 0) ||
        !claimWake && before.hostWakeAttemptCount === receipt?.hostWakeAttemptCount && before.hostWakeStatus && !receipt?.hostWakeStatus)) {
        merged.hostWakeAttemptCount = before.hostWakeAttemptCount;
        merged.hostWakeRequestedAtMs = before.hostWakeRequestedAtMs;
        merged.hostWakeStatus = before.hostWakeStatus;
        merged.hostWakeReason = before.hostWakeReason;
      }
      // A wake acknowledgement is never allowed to erase observed execution.
      if (["queued", "sending"].includes(state) && prior.state === "running") state = "running";
      db.query("UPDATE messages SET state=?,reason=?,receipt=? WHERE id=?")
        .run(state, reason, merged ? JSON.stringify(merged) : null, id);
    })());
  }
  private reply(row: Row): ProfileMessageReply {
    return { submissionId: row.id, threadId: row.thread_id,
      state: row.state === "preparing" || row.state === "sending" ? "uncertain" : row.state,
      ...(row.reason ? { reason: row.reason } : {}) };
  }
  private async requireUnarchived(client: Client, threadId: string) {
    // thread/read does not expose archive state. The official list filter is
    // checked at submission time, independently of a potentially stale UI page.
    const cursors = new Set<string>(), deadline = Date.now() + 8000;
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 100 && Date.now() < deadline; pageIndex++) {
      const page = await client.listThreads({ cursor, limit: 100, archived: false, useStateDbOnly: true,
        sourceKinds: ["cli", "vscode", "exec", "appServer"], modelProviders: [] });
      if (page.data.some(thread => thread.id === threadId)) return;
      if (!page.nextCursor || cursors.has(page.nextCursor)) break;
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    this.error("profile_thread_unavailable");
  }
  private async wake(row: Row, receipt: HostQueueReceipt, client: Client) {
    if (!row.native_owner || !row.pool_hash || receipt.turnId) return;
    const bound = JSON.parse(row.binding) as Binding;
    const authorized = () => {
      const current = this.read(row.id);
      return Boolean(current && !["completed", "failed", "running"].includes(current.state) &&
        !JSON.parse(current.receipt ?? "{}").turnId && this.same(bound, row.thread_id));
    };
    await wakeAcceptedHostQueue(receipt, { config: this.config, account: row.account, client,
      stillAuthorized: authorized, wakeHost: this.options.wake, now: this.options.now,
      beforeWake: async () => {
        if (JSON.stringify(await this.owner(row.account, row.thread_id)) !== row.native_owner || this.poolReady(bound) !== row.pool_hash)
          this.error("profile_identity_changed");
        await this.requireUnarchived(client, row.thread_id);
        const latest = await client.readLatestTurn(row.thread_id);
        if (latest?.status === "inProgress" || (latest?.turnId ?? null) !== row.prior_turn) this.error("profile_thread_active");
      },
      onReceipt: next => this.update(row.id, "queued", next.hostWakeStatus === "unavailable"
        ? next.hostWakeReason ?? "profile_host_unavailable" : null, next, next.hostWakeStatus === undefined),
    });
  }
  async catalogue(account: string, cursor?: string | null) {
    if (cursor != null && (typeof cursor !== "string" || cursor.length > 4096)) this.error("profile_cursor_invalid");
    const { location, value } = this.binding(account), client = this.client(location);
    {
      const page = await client.listThreads({ cursor, limit: 64, sortKey: "updated_at", sortDirection: "desc", archived: false,
        sourceKinds: ["cli", "vscode", "exec", "appServer"], modelProviders: [], useStateDbOnly: true });
      if (!this.same(value)) this.error("profile_identity_changed");
      return { account, sessionOwner: location.ownerAccount, consolidated: location.consolidated,
        conversations: page.data.filter(t => UUID.test(t.id) && (!location.threadIds || location.threadIds.has(t.id))).map(t => ({
          id: t.id, title: t.name?.slice(0, 1000) ?? null, active: null, updatedAt: t.updatedAtMs ?? null })), nextCursor: page.nextCursor };
    }
  }
  async submit(input: unknown): Promise<ProfileMessageReply> {
    const v = input as any;
    if (!v || typeof v !== "object" || Object.keys(v).some(k => !["account", "threadId", "submissionId", "text"].includes(k)) ||
      typeof v.account !== "string" || !ACCOUNT.test(v.account) || typeof v.threadId !== "string" || !UUID.test(v.threadId) ||
      typeof v.submissionId !== "string" || !UUID.test(v.submissionId) || typeof v.text !== "string" || !v.text.trim() ||
      Buffer.byteLength(v.text, "utf8") > 32_768 || v.text.includes("\u0000")) throw new ProfileConversationError("profile_message_invalid", 400, false);
    const existing = this.read(v.submissionId);
    if (existing) {
      if (existing.account !== v.account || existing.thread_id !== v.threadId || existing.text_hash !== hash(v.text))
        this.error("profile_submission_conflict");
      return this.receipt(v.account, v.submissionId);
    }
    let resolved: ReturnType<ProfileConversations["binding"]>;
    try { resolved = this.binding(v.account, v.threadId); }
    catch (error) { throw new ProfileConversationError(error instanceof ProfileConversationError ? error.code : "profile_session_unavailable", 409, false); }
    const { location, value: bound } = resolved;
    const inserted = this.db(db => db.query(`INSERT OR IGNORE INTO messages
      (id,account,thread_id,text_hash,binding,state,reason,creator_pid) VALUES (?,?,?,?,?,'preparing','profile_message_verifying',?)`)
      .run(v.submissionId, v.account, v.threadId, hash(v.text), JSON.stringify(bound), process.pid).changes);
    if (!inserted) {
      const prior = this.read(v.submissionId);
      if (prior && prior.account === v.account && prior.thread_id === v.threadId && prior.text_hash === hash(v.text))
        return this.receipt(v.account, v.submissionId);
      throw new ProfileConversationError("profile_message_pending", 409, false);
    }
    const client = this.client(location);
    let intent = false;
    try {
      const policy = this.poolReady(bound);
      await this.requireUnarchived(client, v.threadId);
      const owner = await this.owner(v.account, v.threadId);
      const latest = await client.readLatestTurn(v.threadId);
      if (latest?.status === "inProgress") this.error("profile_thread_active");
      const queue = await client.listThreadQueue(v.threadId, { limit: 2 });
      if (queue.data.length || queue.nextCursor !== null) this.error("profile_queue_occupied");
      const again = await this.owner(v.account, v.threadId);
      if (JSON.stringify(owner) !== JSON.stringify(again) || !this.same(bound, v.threadId) || this.poolReady(bound) !== policy)
        this.error("profile_identity_changed");
      const finalTurn = await client.readLatestTurn(v.threadId);
      const finalQueue = await client.listThreadQueue(v.threadId, { limit: 2 });
      if (finalTurn?.status === "inProgress" || finalTurn?.turnId !== latest?.turnId) this.error("profile_thread_active");
      if (finalQueue.data.length || finalQueue.nextCursor !== null) this.error("profile_queue_occupied");
      const receipt: HostQueueReceipt = { threadId: v.threadId, clientUserMessageId: v.submissionId, sentAtMs: (this.options.now ?? Date.now)() };
      const queued = await client.addThreadQueue(v.threadId, v.submissionId, v.text, () => {
        if (!this.same(bound, v.threadId) || this.poolReady(bound) !== policy) this.error("profile_identity_changed");
        const changed = this.db(db => db.query("UPDATE messages SET state='sending',reason='profile_delivery_unconfirmed',receipt=?,prior_turn=?,native_owner=?,pool_hash=? WHERE id=? AND state='preparing'")
          .run(JSON.stringify(receipt), latest?.turnId ?? null, JSON.stringify(owner), policy, v.submissionId).changes);
        if (changed !== 1) this.error("profile_submission_conflict");
        intent = true;
      });
      receipt.queuedSubmissionId = queued.id;
      this.update(v.submissionId, "queued", null, receipt);
      await this.wake(this.read(v.submissionId)!, receipt, client);
      return this.reply(this.read(v.submissionId)!);
    } catch (error) {
      this.update(v.submissionId, intent ? "uncertain" : "failed", intent ? "profile_delivery_unconfirmed" :
        error instanceof ProfileConversationError ? error.code : "profile_submission_unavailable");
      return this.reply(this.read(v.submissionId)!);
    }
  }
  async receipt(account: string, submissionId: string): Promise<ProfileMessageReply> {
    const key = account + ":" + submissionId, existing = this.observing.get(key);
    if (existing) return existing;
    const pending = this.observeReceipt(account, submissionId);
    this.observing.set(key, pending);
    try { return await pending; } finally { this.observing.delete(key); }
  }
  private async observeReceipt(account: string, submissionId: string): Promise<ProfileMessageReply> {
    if (!ACCOUNT.test(account) || !UUID.test(submissionId)) this.error("profile_message_invalid");
    const row = this.read(submissionId);
    if (!row || row.account !== account) throw new ProfileConversationError("profile_receipt_not_found", 404);
    if (["completed", "failed"].includes(row.state)) return this.reply(row);
    if (row.state === "preparing") {
      try { process.kill(row.creator_pid, 0); }
      catch (error: any) { if (error?.code === "ESRCH") this.update(row.id, "failed", "profile_submission_not_accepted"); }
      return this.reply(this.read(row.id)!);
    }
    const bound = JSON.parse(row.binding) as Binding;
    if (!this.same(bound, row.thread_id)) return { ...this.reply(row), state: "uncertain", reason: "profile_identity_changed" };
    const client = this.client(this.location(account, row.thread_id));
    try {
      const receipt = JSON.parse(row.receipt!) as HostQueueReceipt;
      const result = await observeHostQueueReceipt(receipt, { client, afterTurnId: row.prior_turn ?? undefined,
        onReceipt: next => { if (!this.same(bound, row.thread_id)) this.error("profile_identity_changed");
          this.update(row.id, row.state, row.reason, next); } });
      if (!this.same(bound, row.thread_id)) this.error("profile_identity_changed");
      if (result) this.update(row.id, result.status === "turn-finished" ? "completed" : "failed", result.reason ?? null, receipt);
      else if (receipt.turnId) this.update(row.id, "running", null, receipt);
      else {
        const queue = await client.listThreadQueue(row.thread_id, { limit: 100 });
        const exact = queue.data.filter(q => q.clientUserMessageId === row.id && (!receipt.queuedSubmissionId || q.id === receipt.queuedSubmissionId));
        this.update(row.id, exact.length === 1 ? "queued" : "uncertain", exact.length === 1 ? row.reason : "profile_delivery_unconfirmed", receipt);
        if (exact.length === 1) await this.wake(this.read(row.id)!, receipt, client);
      }
      return this.reply(this.read(row.id)!);
    } catch {
      const current = this.read(row.id)!;
      return ["completed", "failed"].includes(current.state) ? this.reply(current)
        : { ...this.reply(current), state: "uncertain", reason: "profile_receipt_unavailable" };
    }
  }
}
