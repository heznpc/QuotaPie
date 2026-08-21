import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { dataDirectory } from "../config";
import { migrate } from "./migrations";

/// Owns the connection, the PRAGMAs, the schema, and the transaction boundary.
///
/// The stores are separate files, not separate connections. Splitting the
/// connection would leave BEGIN IMMEDIATE, the alert lease, and event delivery
/// each atomic on their own and unrelated to one another, which is precisely the
/// property they exist to provide. One connection, one transaction owner, many
/// collaborators sharing it.
export class QuotaStorage {
  readonly db: Database;
  private readonly storagePath: string;
  private depth = 0;
  private rollbackCause: unknown = null;

  constructor(path = resolve(dataDirectory(), "quotapie.sqlite3")) {
    this.storagePath = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 3000");
    migrate(this.db);
    this.secureFiles();
  }

  /// Nested calls join the transaction already in flight rather than starting a
  /// second one, so a store method that runs standalone is still atomic when it
  /// is called from inside a larger unit of work.
  ///
  /// Because a nested call is part of the outer unit and not a recoverable one
  /// of its own, a failure inside it makes the whole unit rollback-only. A
  /// caller that catches the inner error cannot go on to commit: the writes the
  /// nested call had already made are part of the same transaction, and letting
  /// them through would be exactly the half-state this abstraction exists to
  /// prevent. Recoverable sub-units would need SAVEPOINT, which is a different
  /// contract than the one stated here.
  transaction<T>(work: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return work();
      } catch (error) {
        this.rollbackCause ??= error;
        throw error;
      } finally {
        this.depth -= 1;
      }
    }

    this.db.run("BEGIN IMMEDIATE");
    this.depth = 1;
    this.rollbackCause = null;
    try {
      const value = work();
      if (this.rollbackCause != null) {
        const cause = this.rollbackCause;
        this.db.run("ROLLBACK");
        throw new Error("transaction aborted by a nested failure", { cause });
      }
      this.db.run("COMMIT");
      return value;
    } catch (error) {
      if (this.db.inTransaction) {
        try {
          this.db.run("ROLLBACK");
        } catch {
          // Preserve the original SQLite error.
        }
      }
      throw error;
    } finally {
      this.depth = 0;
      this.rollbackCause = null;
    }
  }

  secureFiles(): void {
    if (this.storagePath === ":memory:") return;
    chmodSync(dirname(this.storagePath), 0o700);
    for (const path of [
      this.storagePath,
      `${this.storagePath}-wal`,
      `${this.storagePath}-shm`,
      resolve(dirname(this.storagePath), "service.log"),
      resolve(dirname(this.storagePath), "service.error.log"),
    ]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  close(): void {
    this.db.close();
  }
}
