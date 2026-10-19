import { ACCOUNT_PLAN_KINDS, type AccountPlanKind, type CollectionErrorCategory, type CollectionSourceStateRow, type Provider } from "../types";
import type { QuotaStorage } from "./database";

/// Records what each collection source did, and nothing about what it means.
///
/// Which source is authoritative, and what an account's health therefore is,
/// are application policy and live in QuotaPieService.accountStates().
export class CollectionStore {
  constructor(private readonly storage: QuotaStorage) {}

  recordAttempt(
    provider: Provider,
    account: string,
    source: string,
    atMs: number,
    error: string | null,
    category: CollectionErrorCategory | null = null,
    accountPlan?: { kind: AccountPlanKind; identity: string },
  ): void {
    this.storage.db
      .query(`
        INSERT INTO collection_source_state(
          provider, account, source, last_attempt_ms, last_success_ms, last_error, last_error_category,
          account_plan_kind, account_plan_identity
        )
        VALUES (?1, ?2, ?3, ?4, CASE WHEN ?5 IS NULL THEN ?4 ELSE NULL END, ?5, ?6, ?7, ?8)
        ON CONFLICT(provider, account, source) DO UPDATE SET
          last_attempt_ms = ?4,
          last_success_ms = CASE WHEN ?5 IS NULL THEN ?4 ELSE collection_source_state.last_success_ms END,
          last_error = ?5,
          last_error_category = ?6,
          account_plan_kind = ?7,
          account_plan_identity = ?8
      `)
      .run(provider, account, source, atMs, error, category, accountPlan?.kind ?? null, accountPlan?.identity ?? null);
  }

  sourceStates(): CollectionSourceStateRow[] {
    return this.storage.db
      .query<{
        provider: Provider;
        account: string;
        source: string;
        last_attempt_ms: number | null;
        last_success_ms: number | null;
        last_error: string | null;
        last_error_category: CollectionErrorCategory | null;
        account_plan_kind: string | null;
        account_plan_identity: string | null;
      }, []>(`
        SELECT provider, account, source, last_attempt_ms, last_success_ms, last_error, last_error_category,
               account_plan_kind, account_plan_identity
        FROM collection_source_state
      `)
      .all()
      .map((row) => ({
        provider: row.provider,
        account: row.account,
        source: row.source,
        lastAttemptMs: row.last_attempt_ms,
        lastSuccessMs: row.last_success_ms,
        lastError: row.last_error,
        lastErrorCategory: row.last_error_category,
        ...(row.account_plan_kind && ACCOUNT_PLAN_KINDS.includes(row.account_plan_kind as AccountPlanKind) &&
          row.account_plan_identity && /^[0-9a-f]{64}$/.test(row.account_plan_identity) && row.last_attempt_ms != null
          ? { accountPlan: { kind: row.account_plan_kind as AccountPlanKind, identity: row.account_plan_identity,
              observedAtMs: row.last_attempt_ms } } : {}),
      }));
  }
}
