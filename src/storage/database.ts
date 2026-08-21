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
  transaction<T>(work: () => T): T {
    if (this.depth > 0) return work();
    this.db.run("BEGIN IMMEDIATE");
    this.depth += 1;
    try {
      const value = work();
      this.db.run("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.run("ROLLBACK");
      } catch {
        // Preserve the original SQLite error.
      }
      throw error;
    } finally {
      this.depth -= 1;
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
