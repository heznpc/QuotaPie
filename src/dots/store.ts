import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ResumeGate } from "../resume-gate";

export interface DotPolicy {
  id: string;
  threadId: string;
  account: string;
  profileKey: string;
  accountKey: string;
  continuation: string;
  executionMode?: "native" | "profile-managed";
  enabled: boolean;
  trigger: "quota.ready" | "quota.reset_approaching";
  resetBucket?: string;
  resetWithinMinutes: number;
  requiredBucket?: string;
  reservePercent: number;
  maxTurns: number;
  maxUsagePercent: number;
  expiresAtMs: number;
  priority: number;
}
export interface DotEvent {
  eventId: string;
  name: DotPolicy["trigger"];
  timestamp: string;
  data: { targetId: string; threadId: string };
  cursor: null;
}
export interface Subscription {
  id: string; targetId: string; name: DotPolicy["trigger"];
  url: string; secret: string; expiresAtMs: number;
}
export interface TargetState {
  policy: DotPolicy;
  turns: number;
  spent: number;
  last: ResumeGate["windows"] | null;
  event: DotEvent | null;
  claimed: string | null;
  claimExpiresAtMs?: number;
  dispatchedClaim?: string;
  outcome: "completed" | "quota-blocked" | "failed" | null;
}

/** One private store per explicitly configured personal tunnel. It never stores
 * provider credentials or conversation bodies. SQLite serializes competing claims. */
export class DotStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS connection_observations (method TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        subscription_id TEXT NOT NULL, event_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY(subscription_id, event_id));
    `);
  }
  targets(): TargetState[] {
    return this.db.query<{ state: string }, []>("SELECT state FROM targets ORDER BY id").all().map(r => JSON.parse(r.state));
  }
  observe(method: string, atMs: number) {
    this.db.query("INSERT INTO connection_observations(method,at_ms) VALUES (?,?) ON CONFLICT(method) DO UPDATE SET at_ms=excluded.at_ms")
      .run(method, atMs);
  }
  observed(method: string): number | null {
    return this.db.query<{ at_ms: number }, [string]>("SELECT at_ms FROM connection_observations WHERE method=?").get(method)?.at_ms ?? null;
  }
  target(id: string): TargetState {
    const row = this.db.query<{ state: string }, [string]>("SELECT state FROM targets WHERE id=?").get(id);
    if (!row) throw new Error("target-not-found");
    return JSON.parse(row.state);
  }
  save(state: TargetState) {
    this.db.query("UPDATE targets SET state=? WHERE id=?").run(JSON.stringify(state), state.policy.id);
  }
  create(policy: DotPolicy) {
    const state: TargetState = { policy: { ...policy, enabled: false }, turns: 0, spent: 0,
      last: null, event: null, claimed: null, outcome: null };
    this.db.query("INSERT INTO targets(id,state) VALUES (?,?)").run(policy.id, JSON.stringify(state));
  }
  setEnabled(id: string, enabled: boolean) {
    return this.db.transaction(() => {
      const state = this.target(id);
      if (enabled && (state.claimed || state.turns >= state.policy.maxTurns || state.spent >= state.policy.maxUsagePercent))
        throw new Error("target-needs-review");
      state.policy.enabled = enabled;
      if (!enabled && !state.claimed) state.event = null;
      this.save(state);
      return state;
    }).immediate();
  }
  subscriptions(): Subscription[] {
    return this.db.query<{ value: string }, []>("SELECT value FROM subscriptions").all().map(r => JSON.parse(r.value));
  }
  subscribe(sub: Subscription) {
    if (!this.subscriptions().some(s => s.id === sub.id) && this.subscriptions().length >= 32)
      throw new Error("subscription-limit");
    this.db.query("INSERT INTO subscriptions(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
      .run(sub.id, JSON.stringify(sub));
  }
  unsubscribe(id: string) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM subscriptions WHERE id=?").run(id);
      this.db.query("DELETE FROM deliveries WHERE subscription_id=?").run(id);
    }).immediate();
  }
  close() { this.db.close(); }
}
