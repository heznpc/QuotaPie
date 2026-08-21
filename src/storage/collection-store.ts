import type { CollectionErrorCategory, CollectionSourceStateRow, Provider } from "../types";
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
  ): void {
    this.storage.db
      .query(`
        INSERT INTO collection_source_state(
          provider, account, source, last_attempt_ms, last_success_ms, last_error, last_error_category
        )
        VALUES (?1, ?2, ?3, ?4, CASE WHEN ?5 IS NULL THEN ?4 ELSE NULL END, ?5, ?6)
        ON CONFLICT(provider, account, source) DO UPDATE SET
          last_attempt_ms = ?4,
          last_success_ms = CASE WHEN ?5 IS NULL THEN ?4 ELSE collection_source_state.last_success_ms END,
          last_error = ?5,
          last_error_category = ?6
      `)
      .run(provider, account, source, atMs, error, category);
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
      }, []>(`
        SELECT provider, account, source, last_attempt_ms, last_success_ms, last_error, last_error_category
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
      }));
  }
}
