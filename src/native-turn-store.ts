import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Metadata only. Credentials and request/response bodies never enter this store. */
export interface StoredNativeTurn {
  choice: string;
  requestId: string;
  completed: boolean;
  sourceContinuation: boolean;
  inheritedFromThreadId: string | null;
}

/** Additive migration of the manual routing registry; old preferences remain intact. */
export class NativeTurnStore {
  constructor(private path: string, private source: string) {}

  private open(write: boolean): Database | null {
    if (!write && !existsSync(this.path)) return null;
    if (write) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new Database(this.path, write ? { create: true, strict: true } : { readonly: true, strict: true });
    try {
      db.run("PRAGMA busy_timeout=100");
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 1) throw new Error("unsupported_native_turn_schema");
      if (write && version === 0) {
        db.transaction(() => {
          db.run("CREATE TABLE IF NOT EXISTS manual_targets (source TEXT NOT NULL,thread TEXT NOT NULL,payload TEXT NOT NULL,selected_ms INTEGER NOT NULL,PRIMARY KEY(source,thread))");
          db.run(`CREATE TABLE IF NOT EXISTS native_turn_bindings (
            source TEXT NOT NULL, thread TEXT NOT NULL, turn TEXT NOT NULL, request TEXT NOT NULL,
            choice TEXT NOT NULL, completed INTEGER NOT NULL CHECK(completed IN (0,1)),
            source_continuation INTEGER NOT NULL CHECK(source_continuation IN (0,1)), inherited_thread TEXT,
            PRIMARY KEY(source,thread,turn))`);
          db.run("PRAGMA user_version=1");
        }).immediate();
        chmodSync(this.path, 0o600);
      }
      if (!write && version === 0) { db.close(); return null; }
      return db;
    } catch (error) { db.close(); throw error; }
  }

  read(thread: string, turn: string): StoredNativeTurn | null {
    const db = this.open(false);
    if (!db) return null;
    try {
      const row = db.query<{ choice: string; request: string; completed: number; source_continuation: number; inherited_thread: string | null }, [string,string,string]>(
        "SELECT choice,request,completed,source_continuation,inherited_thread FROM native_turn_bindings WHERE source=? AND thread=? AND turn=?")
        .get(this.source, thread, turn);
      return row ? { choice: row.choice, requestId: row.request, completed: row.completed === 1,
        sourceContinuation: row.source_continuation === 1, inheritedFromThreadId: row.inherited_thread } : null;
    } finally { db.close(); }
  }

  begin(thread: string, turn: string, value: Omit<StoredNativeTurn, "completed">) {
    const db = this.open(true)!;
    try {
      db.query(`INSERT INTO native_turn_bindings VALUES(?,?,?,?,?,0,?,?)
        ON CONFLICT(source,thread,turn) DO UPDATE SET request=excluded.request,choice=excluded.choice,
        completed=0,source_continuation=excluded.source_continuation,inherited_thread=excluded.inherited_thread`)
        .run(this.source, thread, turn, value.requestId, value.choice, Number(value.sourceContinuation), value.inheritedFromThreadId);
    } finally { db.close(); }
  }

  finish(thread: string, turn: string, requestId: string, completed: boolean) {
    if (!existsSync(this.path)) return;
    const db = this.open(true)!;
    try {
      // A late completion from an older request cannot validate a newer turn binding.
      db.query("UPDATE native_turn_bindings SET completed=? WHERE source=? AND thread=? AND turn=? AND request=?")
        .run(Number(completed), this.source, thread, turn, requestId);
    } finally { db.close(); }
  }
}
