import { createHash, randomUUID } from "node:crypto";
import { DotStore, type DotPolicy, type DotEvent, type Subscription } from "./store";
import { eligible } from "./policy";
import type { ResumeGate } from "../resume-gate";
import { CallbackEndpointError, callbackURL, signingKey, verifyCallback, signedPost, postWebhook, type WebhookPost } from "./webhook";

type GateReader = (policy: DotPolicy) => Promise<ResumeGate>;
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" };
const instructions = "Only resume explicitly enabled targets. On a quota event, inspect the exact existing task first; do not start an active/completed task. Call claim_continuation immediately before a single native follow-up to its threadId. A claim never starts work. Do not substitute accounts, create tasks, use CLI resume, or send a second follow-up after an uncertain result. Record the observed result with finish_continuation. Stop on failure, expiry or disabled policy.";

export class DotBridge {
  constructor(readonly store: DotStore, readonly readGate: GateReader,
    readonly post: WebhookPost = postWebhook, readonly now = Date.now) {}

  private subscriptionID(name: string, targetId: string, url: string) {
    // This transport is a single authenticated tunnel principal.
    return createHash("sha256").update(JSON.stringify([name, targetId, url])).digest("hex");
  }
  private async snapshot(targetId: string, persist = true) {
    const state = this.store.target(targetId);
    const gate = await this.readGate(state.policy);
    const now = this.now();
    return this.store.db.transaction(() => {
      const latest = this.store.target(targetId);
      // Never advance the consumption baseline using stale/untrusted data.
      if (gate.schemaVersion === 1 && gate.profileKey === latest.policy.profileKey && gate.accountKey === latest.policy.accountKey &&
          gate.provider === "codex" && gate.account === latest.policy.account &&
          Array.isArray(gate.windows) && gate.windows.length && gate.windows.every(w =>
            Number.isFinite(w.observedAtMs) && w.observedAtMs <= now && now - w.observedAtMs <= 120000 &&
            Number.isFinite(w.remainingPercent) && w.remainingPercent! >= 0 && w.remainingPercent! <= 100)) {
        const delta = Math.max(0, ...gate.windows.map(w => {
          const old = latest.last?.find(v => v.bucket === w.bucket && v.resetsAtMs === w.resetsAtMs);
          return old && w.observedAtMs >= old.observedAtMs ? Math.max(0, old.remainingPercent! - w.remainingPercent!) : 0;
        }));
        latest.spent += delta;
        if (!latest.last || gate.windows.every(w => w.observedAtMs >= (latest.last!.find(v => v.bucket === w.bucket)?.observedAtMs ?? 0)))
          latest.last = gate.windows;
        if (persist) this.store.save(latest);
      }
      return { state: latest, gate, ready: eligible(latest, gate, now) };
    }).immediate();
  }
  async status(targetId: string) {
    try {
      const { state, gate, ready } = await this.snapshot(targetId, false);
      return { targetId, threadId: state.policy.threadId, enabled: state.policy.enabled, ready,
        reason: ready ? "ready" : gate.ready ? "policy-hold" : gate.reason,
        turnsUsed: state.turns, maxTurns: state.policy.maxTurns,
        observedUsagePercent: state.spent, maxUsagePercent: state.policy.maxUsagePercent,
        expiresAtMs: state.policy.expiresAtMs, eventId: state.event?.eventId ?? null,
        claimed: state.claimed != null, outcome: state.outcome };
    } catch { return { targetId, ready: false, reason: "collector-or-target-unavailable" }; }
  }
  async claim(targetId: string, eventId: string) {
    const { state, gate, ready } = await this.snapshot(targetId);
    if (!ready) return { granted: false, reason: "policy-or-quota-hold" };
    const hasSubscription = () => this.store.subscriptions().some(s => s.targetId === targetId && s.expiresAtMs > this.now());
    if (!hasSubscription()) return { granted: false, reason: "subscription-inactive" };
    // Serialize work on this quota account; a different target cannot start a
    // concurrent automatic turn while a prior result remains unresolved.
    if (this.store.targets().some(t => t.policy.account === state.policy.account && t.claimed))
      return { granted: false, reason: "account-busy" };
    const subscribed = new Set(this.store.subscriptions().filter(s => s.expiresAtMs > this.now()).map(s => s.targetId));
    for (const other of this.store.targets().filter(t => subscribed.has(t.policy.id) && t.policy.enabled && t.policy.account === state.policy.account &&
        t.policy.id !== targetId && t.policy.priority > state.policy.priority)) {
      const higher = await this.status(other.policy.id);
      if (higher.ready) return { granted: false, reason: "higher-priority-work" };
    }
    return this.store.db.transaction(() => {
      const current = this.store.target(targetId), now = this.now();
      if (!hasSubscription() || !eligible(current, gate, now) || current.event?.eventId !== eventId ||
          this.store.targets().some(t => t.policy.account === current.policy.account && t.claimed))
        return { granted: false, reason: "expired-or-already-claimed" };
      current.claimed = randomUUID(); current.turns++; current.outcome = null;
      this.store.save(current);
      return { granted: true, claimId: current.claimed, threadId: current.policy.threadId,
        continuation: current.policy.continuation, startBeforeMs: Math.min(now + 60000, current.policy.expiresAtMs),
        maxFollowups: 1, exactConsumptionCap: false };
    }).immediate();
  }
  finish(targetId: string, claimId: string, outcome: string) {
    if (!["completed", "quota-blocked", "failed"].includes(outcome)) throw new Error("invalid-outcome");
    return this.store.db.transaction(() => {
      const state = this.store.target(targetId);
      if (!state.claimed || state.claimed !== claimId) throw new Error("claim-mismatch");
      state.outcome = outcome as typeof state.outcome; state.claimed = null; state.event = null;
      // Only a witnessed quota block may re-arm, within the original limits.
      if (outcome !== "quota-blocked" || state.turns >= state.policy.maxTurns) state.policy.enabled = false;
      this.store.save(state);
      return { recorded: true, enabled: state.policy.enabled, observation: outcome };
    }).immediate();
  }
  async tick() {
    const now = this.now();
    for (const sub of this.store.subscriptions()) if (sub.expiresAtMs <= now) this.store.unsubscribe(sub.id);
    for (const current of this.store.targets()) {
      const subs = this.store.subscriptions().filter(s => s.targetId === current.policy.id);
      if (!subs.length || !current.policy.enabled || current.claimed) continue;
      let snapshot;
      try { snapshot = await this.snapshot(current.policy.id); } catch { continue; }
      if (!snapshot.ready) {
        this.store.db.transaction(() => {
          const state = this.store.target(current.policy.id);
          if (!state.claimed) { state.event = null; this.store.save(state); }
        }).immediate();
        continue;
      }
      const event = this.store.db.transaction(() => {
        const state = this.store.target(current.policy.id);
        if (!eligible(state, snapshot.gate, this.now())) return null;
        if (!state.event) {
          state.event = { eventId: randomUUID(), name: state.policy.trigger, timestamp: new Date(this.now()).toISOString(),
            data: { targetId: state.policy.id, threadId: state.policy.threadId }, cursor: null };
          this.store.save(state);
        }
        return state.event;
      }).immediate();
      if (!event) continue;
      for (const sub of subs) await this.deliver(sub, event);
    }
  }
  private async deliver(sub: Subscription, event: DotEvent) {
    const now = this.now();
    const claimed = this.store.db.transaction(() => {
      this.store.db.query("INSERT OR IGNORE INTO deliveries(subscription_id,event_id) VALUES (?,?)").run(sub.id, event.eventId);
      const row = this.store.db.query<{ attempts: number; state: string; next_at: number }, [string, string]>(
        "SELECT attempts,state,next_at FROM deliveries WHERE subscription_id=? AND event_id=?").get(sub.id, event.eventId)!;
      if (row.state !== "pending" || row.next_at > now || row.attempts >= 3) return null;
      this.store.db.query("UPDATE deliveries SET attempts=attempts+1,next_at=? WHERE subscription_id=? AND event_id=?")
        .run(now + 30000 * 2 ** row.attempts, sub.id, event.eventId);
      return true;
    }).immediate();
    if (!claimed) return;
    const current = this.store.target(sub.targetId);
    if (!current.policy.enabled || current.claimed || current.event?.eventId !== event.eventId) return;
    let status = 0;
    try { status = (await signedPost(this.post, sub, event.eventId, JSON.stringify(event), now)).status; } catch { /* bounded retry */ }
    if (status === 410) { this.store.unsubscribe(sub.id); return; }
    if ((status >= 200 && status < 300) || status === 413 || (status >= 400 && status < 500 && ![408, 429].includes(status))) {
      this.store.db.query("UPDATE deliveries SET state=? WHERE subscription_id=? AND event_id=?")
        .run(status < 300 ? "received" : "failed", sub.id, event.eventId);
    }
  }

  async method(method: string, p: any = {}) {
    if (["server/discover", "events/list"].includes(method)) this.store.observe(method, this.now());
    if (method === "server/discover") return { resultType: "complete", supportedVersions: ["2026-07-28"],
      serverInfo: { name: "quotapie", version: "0.1.0" }, capabilities: { tools: {}, events: {} }, instructions };
    if (method === "initialize") return { protocolVersion: "2025-11-25",
      serverInfo: { name: "quotapie", version: "0.1.0" }, capabilities: { tools: {} }, instructions };
    if (method === "ping") return {};
    if (method === "tools/list") return { tools: [
      { name: "continuation_status", title: "Check an approved continuation",
        description: "Read current quota and limits for an explicitly configured target.",
        inputSchema: object({ targetId: str }), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
      { name: "claim_continuation", title: "Claim one continuation",
        description: "After checking the original task is idle and unfinished, reserve one follow-up. Never starts a task. A failed or repeated claim grants nothing.",
        inputSchema: object({ targetId: str, eventId: str }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "finish_continuation", title: "Record the observed continuation result",
        description: "Record only a witnessed native task result. completed means the approved objective is finished; failed stops automatic continuation.",
        inputSchema: object({ targetId: str, claimId: str, outcome: { enum: ["completed", "quota-blocked", "failed"] } }),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    ] };
    if (method === "tools/call") {
      const a = p.arguments ?? {};
      if (typeof a.targetId !== "string") throw new Error("invalid-target");
      let result;
      if (p.name === "continuation_status") result = await this.status(a.targetId);
      else if (p.name === "claim_continuation" && typeof a.eventId === "string") result = await this.claim(a.targetId, a.eventId);
      else if (p.name === "finish_continuation" && typeof a.claimId === "string") result = this.finish(a.targetId, a.claimId, a.outcome);
      else throw new Error("invalid-tool");
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    }
    if (method === "events/list") return { events: ["quota.ready", "quota.reset_approaching"].map(name => ({
      name, description: name === "quota.ready" ? "An approved existing task has fresh quota above its reserve." :
        "An approved existing task has usable quota near its selected reset.",
      delivery: ["webhook"], inputSchema: object({ targetId: str }),
      payloadSchema: object({ targetId: str, threadId: str }),
    })) };
    if (method === "events/subscribe" || method === "events/unsubscribe") {
      const a = p.arguments, d = p.delivery;
      if (!a || typeof a.targetId !== "string" || Object.keys(a).length !== 1 ||
          !d || d.mode !== "webhook" || typeof d.url !== "string") throw new Error("invalid-subscription");
      const state = this.store.target(a.targetId);
      if (p.name !== state.policy.trigger) throw new Error("event-not-allowed");
      const url = callbackURL(d.url).href, id = this.subscriptionID(p.name, a.targetId, url);
      if (method === "events/unsubscribe") { this.store.unsubscribe(id); return {}; }
      if (typeof d.secret !== "string") throw new Error("invalid-signing-key");
      signingKey(d.secret);
      const now = this.now(), ttl = p.ttlMs ?? 86400000;
      if (!Number.isFinite(ttl) || ttl < 1000) throw new Error("invalid-subscription-ttl");
      const expiresAtMs = Math.min(now + Math.min(ttl, 86400000), state.policy.expiresAtMs);
      if (expiresAtMs <= now) throw new Error("policy-expired");
      const sub: Subscription = { id, targetId: a.targetId, name: p.name, url, secret: d.secret, expiresAtMs };
      // Verify before persistence or application data delivery.
      await verifyCallback(this.post, sub, now);
      this.store.subscribe(sub);
      return { id, refreshBefore: new Date(expiresAtMs).toISOString(), cursor: null, truncated: false };
    }
    throw new Error("method-not-found");
  }
  async rpc(input: any) {
    const id = input?.id ?? null;
    if (!input || input.jsonrpc !== "2.0" || typeof input.method !== "string")
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
    if (input.id === undefined) return null;
    try { return { jsonrpc: "2.0", id, result: await this.method(input.method, input.params) }; }
    catch (error) {
      if (error instanceof CallbackEndpointError) return { jsonrpc: "2.0", id,
        error: { code: -32015, message: "CallbackEndpointError", data: { reason: error.reason } } };
      const known = error instanceof Error && /^[a-z-]{3,80}$/.test(error.message) ? error.message : "request-failed";
      return { jsonrpc: "2.0", id, error: { code: known.startsWith("callback") ? -32015 : known === "method-not-found" ? -32601 : -32602, message: known } };
    }
  }
}
