import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { poolDatabasePath, type PoolAccount } from "../account-pool";

/** Session storage ownership is not the account that last executed its history.
 * Resolve the durable route before spending the single automatic continuation. */
export function quotaResumeContinuationAccount(source: string, thread: string, accounts: PoolAccount[], path = poolDatabasePath()): string {
  if (!existsSync(path)) return source;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, strict: true });
    db.run("PRAGMA busy_timeout=100");
    const row = db.query<{account:string;identity:string;source_identity:string}, [string,string]>(
      "SELECT account,identity,source_identity FROM bindings WHERE source=? AND thread=?").get(source, thread);
    if (!row) return source;
    if (accounts.find(a => a.id === source)?.identity !== row.source_identity ||
        accounts.find(a => a.id === row.account)?.identity !== row.identity)
      throw new Error("quota-resume-history-account-changed");
    return row.account;
  } catch (error) {
    if (error instanceof Error && error.message === "quota-resume-history-account-changed") throw error;
    throw new Error("quota-resume-history-unavailable");
  } finally { db?.close(); }
}
