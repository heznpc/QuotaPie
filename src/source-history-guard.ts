import { Database } from "bun:sqlite";
import { poolDatabasePath, PoolError } from "./account-pool";
import { codexRequestIdentity } from "./codex-request-identity";
import type { CodexForkParentResult } from "./account-pool-lineage";

/** Optional historical evidence, separate from mandatory source authentication.
 * Read-only: a broken/locked/absent routing DB must not strand native requests.
 * Only an actual binding to another login can veto the authenticated source.
 * Old replay filters and missing ancestry never authorize an account switch.
 */
export function createSourceHistoryGuard(options: {
  path?: string;
  forkParent: (id: string) => Promise<CodexForkParentResult>;
}) {
  return async (input: { account: string; identity: string; headers: Headers; signal?: AbortSignal }) => {
    const claim = codexRequestIdentity(input.headers);
    const queue = claim.threadId ? [claim.threadId] : [];
    if (claim.fork.status === "claimed") queue.push(claim.fork.parentId);
    if (!queue.length) return "unbound" as const;
    let db: Database | undefined;
    let matched = false, unavailable = false;
    try {
      db = new Database(options.path ?? poolDatabasePath(), { readonly: true, strict: true });
      db.run("PRAGMA busy_timeout=0");
      const seen = new Set<string>();
      while (queue.length && seen.size < 32) {
        input.signal?.throwIfAborted();
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const binding = db.query<{ account: string; identity: string; source_identity: string }, [string, string]>(
          "SELECT account,identity,source_identity FROM bindings WHERE source=? AND thread=?").get(input.account, id);
        if (binding) {
          if (binding.account !== input.account || binding.identity !== input.identity || binding.source_identity !== input.identity)
            throw new PoolError("pool_source_continuation_mismatch", 409);
          matched = true;
        }
        try {
          const lineage = await options.forkParent(id);
          if (lineage.status === "known" && lineage.parentId) queue.push(lineage.parentId);
          if (lineage.status !== "known") unavailable = true;
        } catch { unavailable = true; }
      }
      input.signal?.throwIfAborted();
      return unavailable || queue.length ? "unavailable" as const : matched ? "verified" as const : "unbound" as const;
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof PoolError) throw error;
      return "unavailable" as const;
    } finally { db?.close(); }
  };
}

export type SourceHistoryGuard = ReturnType<typeof createSourceHistoryGuard>;
