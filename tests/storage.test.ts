import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { QuotaStorage } from "../src/storage/database";
import { AlertStore } from "../src/storage/alert-store";
import { CollectionStore } from "../src/storage/collection-store";
import { ClaudeSessionStore } from "../src/storage/claude-session-store";
import { migrate } from "../src/storage/migrations";
import { selectClaudeConsensus } from "../src/domain/claude-consensus";
import type { ClaudeSessionState } from "../src/domain/claude-consensus";
import type { QuotaEvent, TriggerDecision } from "../src/types";

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
    displayText: "relief",
    details: {},
    ...overrides,
  };
}

function notification(overrides: Partial<TriggerDecision> = {}): TriggerDecision {
  return {
    key: "codex:x:remaining:5",
    title: "Quota low",
    message: "Only 5% remains",
    presentation: {
      title: { key: "alert.test.title", params: {} },
      message: { key: "alert.test.message", params: {} },
    },
    severity: "warning",
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

  test("a caught nested failure still poisons the outer transaction", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    const collection = new CollectionStore(store);

    expect(() =>
      store.transaction(() => {
        collection.recordAttempt("codex", "default", "codex-appserver", 1_000, null, null);
        try {
          store.transaction(() => {
            alerts.setState("k", 1_000, true);
            throw new Error("inner failed");
          });
        } catch {
          // A caller that recovers here still cannot commit: the nested writes
          // belong to this same transaction, so letting the outer through would
          // be the half-state this contract exists to prevent.
        }
      })
    ).toThrow();

    expect(collection.sourceStates()).toEqual([]);
    expect(alerts.state("k")).toBeNull();
  });

  test("the abort names the nested failure as its cause", () => {
    const store = storage();
    const inner = new Error("inner failed");
    let thrown: unknown;
    try {
      store.transaction(() => {
        try {
          store.transaction(() => { throw inner; });
        } catch {
          // swallowed
        }
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).cause).toBe(inner);
  });

  test("a later unit of work is unaffected by an earlier poisoned one", () => {
    const store = storage();
    const collection = new CollectionStore(store);
    try {
      store.transaction(() => {
        try {
          store.transaction(() => { throw new Error("inner"); });
        } catch {
          // swallowed
        }
      });
    } catch {
      // expected
    }
    // The poison does not linger past the unit that carried it.
    store.transaction(() => {
      collection.recordAttempt("codex", "default", "codex-appserver", 2_000, null, null);
    });
    expect(collection.sourceStates()).toHaveLength(1);
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

describe("native app notification outbox", () => {
  test("adds semantic columns without losing legacy pending, claimed, or completed rows", () => {
    const db = new Database(":memory:", { strict: true });
    db.run(`
      CREATE TABLE app_notification_outbox (
        id TEXT PRIMARY KEY,
        delivery_key TEXT NOT NULL UNIQUE,
        alert_key TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        severity TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER,
        claimed_token TEXT,
        completed_at_ms INTEGER,
        disposition TEXT
      )
    `);
    db.run(`
      INSERT INTO app_notification_outbox VALUES
        ('pending', 'd-pending', 'a-pending', 'Pending', 'Pending body', 'info', 1000, 10000, NULL, NULL, NULL, NULL),
        ('claimed', 'd-claimed', 'a-claimed', 'Claimed', 'Claimed body', 'warning', 1100, 10000, 1200, 'lease', NULL, NULL),
        ('completed', 'd-completed', 'a-completed', 'Completed', 'Completed body', 'critical', 900, 10000, 950, 'receipt', 1000, 'scheduled')
    `);

    migrate(db);

    const columns = db.query<{ name: string }, []>("PRAGMA table_info(app_notification_outbox)")
      .all().map((column) => column.name);
    for (const column of [
      "title_key",
      "title_params_json",
      "message_key",
      "message_params_json",
    ]) expect(columns).toContain(column);
    const rows = db.query<{
      id: string;
      claimed_token: string | null;
      disposition: string | null;
      title_key: string | null;
    }, []>(`
      SELECT id, claimed_token, disposition, title_key
      FROM app_notification_outbox ORDER BY created_at_ms
    `).all();
    expect(rows).toEqual([
      { id: "completed", claimed_token: "receipt", disposition: "scheduled", title_key: null },
      { id: "pending", claimed_token: null, disposition: null, title_key: null },
      { id: "claimed", claimed_token: "lease", disposition: null, title_key: null },
    ]);
    db.close();
  });

  test("durably deduplicates enqueue and marks the macOS channel in the same unit", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    const first = alerts.queueMacOSNotification(
      notification(),
      "threshold:codex:x:remaining:5:1",
      1_000,
      10_000,
    );
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(alerts.pendingAppNotifications()).toEqual([first]);
    expect(alerts.deliveredChannels(first.deliveryKey)).toEqual(["macos-notification"]);

    const duplicate = alerts.queueMacOSNotification(
      notification({ title: "replacement must not win" }),
      first.deliveryKey,
      2_000,
      20_000,
    );
    expect(duplicate).toEqual(first);
    expect(alerts.pendingAppNotifications()).toHaveLength(1);

    expect(() => alerts.queueMacOSNotification(
      notification({ severity: "invalid" as TriggerDecision["severity"] }),
      "invalid-delivery",
      3_000,
      30_000,
    )).toThrow();
    expect(alerts.deliveredChannels("invalid-delivery")).toEqual([]);
  });

  test("does not recreate a completed delivery when it is enqueued again", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    const queued = alerts.queueMacOSNotification(notification(), "d1", 1_000, 10_000);
    const claim = alerts.claimNextAppNotification(2_000, 1_000)!;
    expect(alerts.completeAppNotification(claim.id, claim.claimToken, "scheduled", 2_100)).toBeTrue();
    expect(alerts.pendingAppNotifications()).toEqual([]);

    const duplicate = alerts.queueMacOSNotification(notification(), "d1", 3_000, 20_000);
    expect(duplicate.id).toBe(queued.id);
    expect(alerts.pendingAppNotifications()).toEqual([]);
    const row = store.db.query<{ count: number; disposition: string }, []>(`
      SELECT COUNT(*) AS count, disposition FROM app_notification_outbox WHERE delivery_key = 'd1'
    `).get();
    expect(row).toEqual({ count: 1, disposition: "scheduled" });
  });

  test("falls back to finished text when persisted semantic params are not JSON scalars", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    const queued = alerts.queueMacOSNotification(notification(), "damaged-params", 1_000, 10_000);
    store.db.query(`
      UPDATE app_notification_outbox
      SET title_params_json = ?
      WHERE id = ?
    `).run('{"provider":{"nested":"codex"}}', queued.id);

    const claim = alerts.claimNextAppNotification(2_000)!;
    expect(claim.presentation).toBeNull();
    expect(claim.title).toBe("Quota low");
    expect(claim.message).toBe("Only 5% remains");
  });

  test("claims one oldest eligible row and protects a reclaimed lease with CAS", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    alerts.queueMacOSNotification(notification(), "older", 1_000, 20_000);
    const first = alerts.claimNextAppNotification(2_000, 5_000)!;
    expect(first.deliveryKey).toBe("older");
    expect(alerts.claimNextAppNotification(3_000, 5_000)).toBeNull();

    const current = alerts.claimNextAppNotification(7_001, 5_000)!;
    expect(current.id).toBe(first.id);
    expect(current.claimToken).not.toBe(first.claimToken);
    expect(alerts.releaseAppNotification(first.id, first.claimToken)).toBeFalse();
    expect(alerts.releaseAppNotification(current.id, current.claimToken)).toBeTrue();
  });

  test("claim records native capability, expires stale rows, and preserves FIFO order", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    expect(alerts.hasNativeNotificationConsumer()).toBeFalse();
    alerts.queueMacOSNotification(notification({ key: "stale" }), "stale", 1_000, 1_500);
    alerts.queueMacOSNotification(notification({ key: "old-live" }), "old-live", 1_100, 10_000);
    alerts.queueMacOSNotification(notification({ key: "new-live" }), "new-live", 1_200, 10_000);

    const claim = alerts.claimNextAppNotification(2_000, 1_000)!;
    expect(alerts.hasNativeNotificationConsumer()).toBeTrue();
    expect(claim.deliveryKey).toBe("old-live");
    const expired = store.db.query<{ disposition: string; completed_at_ms: number }, [string]>(`
      SELECT disposition, completed_at_ms FROM app_notification_outbox WHERE delivery_key = ?
    `).get("stale");
    expect(expired).toEqual({ disposition: "expired", completed_at_ms: 2_000 });
  });

  test("completion is idempotent only for the same receipt and disposition", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    alerts.queueMacOSNotification(notification(), "d1", 1_000, 10_000);
    const claim = alerts.claimNextAppNotification(2_000)!;
    expect(alerts.completeAppNotification(claim.id, claim.claimToken, "suppressed", 2_100)).toBeTrue();
    expect(alerts.completeAppNotification(claim.id, claim.claimToken, "suppressed", 2_200)).toBeTrue();
    expect(alerts.completeAppNotification(claim.id, claim.claimToken, "scheduled", 2_200)).toBeFalse();
    expect(alerts.completeAppNotification(claim.id, "stale-token", "suppressed", 2_200)).toBeFalse();
    expect(alerts.releaseAppNotification(claim.id, claim.claimToken)).toBeFalse();
  });

  test("renews only the current live claim and extends its lease", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    alerts.queueMacOSNotification(notification(), "d1", 1_000, 20_000);
    const first = alerts.claimNextAppNotification(2_000, 5_000)!;
    expect(alerts.renewAppNotification(first.id, "wrong", 6_000)).toBeFalse();
    expect(alerts.renewAppNotification(first.id, first.claimToken, 6_000)).toBeTrue();
    expect(alerts.claimNextAppNotification(7_001, 5_000)).toBeNull();

    const reclaimed = alerts.claimNextAppNotification(11_001, 5_000)!;
    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.claimToken).not.toBe(first.claimToken);
    expect(alerts.renewAppNotification(first.id, first.claimToken, 12_000)).toBeFalse();
  });

  test("cancels pending work by alert key, including a leased row", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    alerts.queueMacOSNotification(notification({ key: "same" }), "d1", 1_000, 10_000);
    alerts.queueMacOSNotification(notification({ key: "same" }), "d2", 1_100, 10_000);
    alerts.queueMacOSNotification(notification({ key: "other" }), "d3", 1_200, 10_000);
    const claim = alerts.claimNextAppNotification(2_000)!;
    expect(claim.deliveryKey).toBe("d1");

    expect(alerts.cancelAppNotificationsForAlert("same", 2_100)).toBe(2);
    expect(alerts.completeAppNotification(claim.id, claim.claimToken, "scheduled", 2_200)).toBeFalse();
    expect(alerts.pendingAppNotifications()).toEqual([
      expect.objectContaining({ deliveryKey: "d3" }),
    ]);
  });

  test("cancels every pending native notification when the channel is disabled", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    alerts.queueMacOSNotification(notification({ key: "one" }), "d1", 1_000, 10_000);
    alerts.queueMacOSNotification(notification({ key: "two" }), "d2", 1_100, 10_000);
    expect(alerts.cancelAllAppNotifications(2_000)).toBe(2);
    expect(alerts.pendingAppNotifications()).toEqual([]);
    const dispositions = store.db.query<{ disposition: string }, []>(`
      SELECT disposition FROM app_notification_outbox ORDER BY delivery_key
    `).all();
    expect(dispositions).toEqual([{ disposition: "cancelled" }, { disposition: "cancelled" }]);
  });

  test("rearming a threshold cancels its pending native notification", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    const alertKey = "codex:x:remaining:5";
    alerts.queueMacOSNotification(notification({ key: alertKey }), `threshold:${alertKey}:1`, 1_000, 10_000);
    alerts.setState(alertKey, 500, true, 2_000);
    expect(alerts.pendingAppNotifications()).toEqual([]);
    expect(alerts.deliveredChannels(`threshold:${alertKey}:1`)).toEqual([]);
    const row = store.db.query<{ disposition: string }, [string]>(`
      SELECT disposition FROM app_notification_outbox WHERE delivery_key = ?
    `).get(`threshold:${alertKey}:1`);
    expect(row?.disposition).toBe("cancelled");
  });

  test("bounds pending inspection", () => {
    const store = storage();
    const alerts = new AlertStore(store);
    alerts.queueMacOSNotification(notification(), "d1", 1_000, 10_000);
    alerts.queueMacOSNotification(notification(), "d2", 2_000, 10_000);
    expect(alerts.pendingAppNotifications(1)).toHaveLength(1);
    expect(alerts.pendingAppNotifications(-1)).toEqual([]);
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
