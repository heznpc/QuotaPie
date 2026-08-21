import { describe, expect, test } from "bun:test";
import { QuotaStorage } from "../src/storage/database";
import { AlertStore } from "../src/storage/alert-store";
import { CollectionStore } from "../src/storage/collection-store";
import { ClaudeSessionStore } from "../src/storage/claude-session-store";
import { selectClaudeConsensus } from "../src/domain/claude-consensus";
import type { ClaudeSessionState } from "../src/domain/claude-consensus";
import type { QuotaEvent } from "../src/types";

function storage(): QuotaStorage {
  return new QuotaStorage(":memory:");
}

function event(overrides: Partial<QuotaEvent> = {}): QuotaEvent {
  return {
    provider: "codex",
    account: "default",
    bucket: "codex:primary:10080",
    kind: "external_relief",
    severity: "info",
    occurredAtMs: 1_000,
    confidence: "high",
    summary: "relief",
    details: {},
    ...overrides,
  };
}

describe("one connection, one transaction owner", () => {
  test("a failure part-way through a unit of work leaves no half-state behind", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    const collection = new CollectionStore(store);

    expect(() =>
      store.transaction(() => {
        collection.recordAttempt("codex", "default", "codex-appserver", 1_000, null, null);
        alerts.setState("codex:default:weekly:pace", 1_000, true);
        // The danger of splitting stores is exactly this: the first write
        // committing while the second does not.
        throw new Error("second write failed");
      })
    ).toThrow("second write failed");

    expect(collection.sourceStates()).toEqual([]);
    expect(alerts.state("codex:default:weekly:pace")).toBeNull();
  });

  test("a nested call joins the transaction in flight instead of opening a second one", () => {
    const store = storage();
    const collection = new CollectionStore(store);
    expect(() =>
      store.transaction(() => {
        collection.recordAttempt("codex", "default", "codex-appserver", 1_000, null, null);
        store.transaction(() => {
          collection.recordAttempt("claude", "default", "claude-oauth", 2_000, null, null);
        });
        throw new Error("outer failed");
      })
    ).toThrow("outer failed");
    // Both writes belonged to the outer unit, so both are gone.
    expect(collection.sourceStates()).toEqual([]);
  });

  test("a completed unit of work is durable across a reopen", () => {
    const store = storage();
    const collection = new CollectionStore(store);
    store.transaction(() => {
      collection.recordAttempt("codex", "default", "codex-appserver", 1_000, null, null);
    });
    expect(collection.sourceStates()).toHaveLength(1);
  });
});

describe("alert claims stay atomic inside their own store", () => {
  test("completing a claim moves both the lease and the delivery record together", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    const claim = alerts.claim("k", 1_000, 60_000)!;
    expect(claim).not.toBeNull();
    expect(alerts.completeClaim("k", claim.token, 2_000)).toBeTrue();
    // A second completion with the same token is not a second delivery.
    expect(alerts.completeClaim("k", claim.token, 3_000)).toBeFalse();
  });

  test("a stale token cannot complete a claim another holder has taken", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    const first = alerts.claim("k", 1_000, 0, 10)!;
    // The first holder died mid-delivery; its lease expires and another takes over.
    const second = alerts.claim("k", 5_000, 0, 10)!;
    expect(second.token).not.toBe(first.token);
    expect(alerts.completeClaim("k", first.token, 6_000)).toBeFalse();
    expect(alerts.completeClaim("k", second.token, 6_000)).toBeTrue();
  });

  test("channel deliveries are remembered per key so a retry does not repeat them", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    expect(alerts.deliveredChannels("d1")).toEqual([]);
    alerts.markChannelDelivered("d1", "macos-notification", 1_000);
    expect(alerts.deliveredChannels("d1")).toEqual(["macos-notification"]);
    expect(alerts.deliveredChannels("d2")).toEqual([]);
  });

  test("only alertable kinds are handed to the planner", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    store.db.query(`
      INSERT INTO events(fingerprint, provider, account, bucket, kind, severity,
                         occurred_at_ms, confidence, summary, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("f1", "codex", "default", "b", "external_relief", "info", 1_000, "high", "s", "{}");
    store.db.query(`
      INSERT INTO events(fingerprint, provider, account, bucket, kind, severity,
                         occurred_at_ms, confidence, summary, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("f2", "codex", "default", "b", "first_observation", "info", 1_000, "high", "s", "{}");
    expect(alerts.pendingEvents().map((item) => item.kind)).toEqual(["external_relief"]);
    expect(event().kind).toBe("external_relief");
  });
});

describe("claude consensus is a decision, not a query", () => {
  function row(overrides: Partial<ClaudeSessionState> = {}): ClaudeSessionState {
    return {
      account: "default",
      session_hash: "a",
      bucket: "five_hour",
      label: "Claude 5h",
      window_seconds: 18_000,
      used_percent: 10,
      resets_at_ms: 100_000,
      observed_at_ms: 1_000,
      value_changed_at_ms: 1_000,
      ...overrides,
    };
  }
  const bucket = [{ account: "default", bucket: "five_hour" }];

  test("an idle session cannot roll a usage figure backwards", () => {
    const result = selectClaudeConsensus([
      row({ session_hash: "old", used_percent: 12, observed_at_ms: 500 }),
      row({ session_hash: "new", used_percent: 40, observed_at_ms: 1_000 }),
    ], bucket, 900_000, 1_000);
    expect(result[0]!.usedPercent).toBe(40);
  });

  test("the reset clock follows whichever session saw it change most recently", () => {
    const result = selectClaudeConsensus([
      row({ session_hash: "old", resets_at_ms: 100_000, value_changed_at_ms: 500 }),
      // A rebase to an earlier reset is still legitimate.
      row({ session_hash: "new", resets_at_ms: 60_000, value_changed_at_ms: 2_000, observed_at_ms: 2_000 }),
    ], bucket, 900_000, 2_000);
    expect(result[0]!.resetsAtMs).toBe(60_000);
  });

  test("sessions outside the TTL are ignored", () => {
    const result = selectClaudeConsensus([
      row({ session_hash: "stale", used_percent: 99, observed_at_ms: 0 }),
      row({ session_hash: "live", used_percent: 20, observed_at_ms: 1_000_000 }),
    ], bucket, 900_000, 1_000_000);
    expect(result[0]!.usedPercent).toBe(20);
    expect(result[0]!.metadata!.activeSessions).toBe(1);
  });

  test("accounts never pool with one another", () => {
    const result = selectClaudeConsensus([
      row({ account: "default", used_percent: 10 }),
      row({ account: "work", used_percent: 90, session_hash: "b" }),
    ], [{ account: "default", bucket: "five_hour" }], 900_000, 1_000);
    expect(result).toHaveLength(1);
    expect(result[0]!.account).toBe("default");
    expect(result[0]!.usedPercent).toBe(10);
  });

  test("a window nobody reported yields nothing rather than an empty guess", () => {
    expect(selectClaudeConsensus([], bucket, 900_000, 1_000)).toEqual([]);
  });

  test("the store round-trips rows the decision then reads", () => {
    const store = storage();
    const sessions = new ClaudeSessionStore(store);
    sessions.upsertSessionRows([{
      provider: "claude",
      account: "default",
      bucket: "five_hour",
      label: "Claude 5h",
      windowSeconds: 18_000,
      usedPercent: 33,
      resetsAtMs: 100_000,
      observedAtMs: 1_000,
      source: "claude-statusline",
      quality: "authoritative",
      metadata: { sessionHash: "abc" },
    }]);
    const rows = sessions.activeSessionRowsSince(0);
    expect(rows).toHaveLength(1);
    expect(selectClaudeConsensus(rows, bucket, 900_000, 1_000)[0]!.usedPercent).toBe(33);
  });
});
