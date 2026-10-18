import { Database } from "bun:sqlite";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";

export interface InstallAccount { provider: "codex" | "claude"; account: string }

/** A durable admission fence understood by already-running collectors. This
 * opens existing tables only: installation must not migrate the live database. */
export class InstallMaintenance {
  private readonly fences: Array<{ id: string; value: string }>;
  private readonly identity: string;
  private closed = false;
  private constructor(private readonly path: string, private readonly db: Database,
    installationId: string, private readonly accounts: InstallAccount[], expectedIdentity: string) {
    this.identity = this.fileIdentity();
    if (this.identity!==expectedIdentity) throw new Error("Installation database changed.");
    this.fences = accounts.map(account => {
      const id = `install:${installationId}:${createHash("sha256").update(JSON.stringify(account)).digest("hex")}`;
      return {id, value: JSON.stringify({...account, id, accountKey:`install:${installationId}`, reason:"installation-maintenance"})};
    });
  }
  static acquire(path: string, installationId: string, accounts: InstallAccount[]): InstallMaintenance | null {
    if (!existsSync(path)) return null;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(installationId) || accounts.some(a => !["codex","claude"].includes(a.provider)
      || typeof a.account !== "string" || !a.account.trim())) throw new Error("Invalid installation maintenance identity.");
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Installation database must be a regular file.");
    const identity=`${realpathSync(path)}:${info.dev}:${info.ino}`;
    const db = new Database(path, {create:false, strict:true});
    try {
      db.run("PRAGMA busy_timeout = 3000");
      const tables = new Set(db.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
      if (!["work_fences","work_policies","work_executions","jobs"].every(name=>tables.has(name))) {
        db.close(); return null; // Older services retain the original disabled-work guard.
      }
      const unique = [...new Map(accounts.map(a=>[JSON.stringify(a),a])).values()];
      const value = new InstallMaintenance(path,db,installationId,unique,identity);
      value.transaction(() => {
        value.assertIdle();
        if (db.query<{id:string},[]>("SELECT id FROM work_fences WHERE id LIKE 'install:%'").all().length)
          throw new Error("An earlier installation maintenance fence needs recovery.");
        for (const fence of value.fences)
          db.query("INSERT INTO work_fences(id,value) VALUES (?,?)").run(fence.id,fence.value);
      });
      return value;
    } catch(error) { db.close(); throw error; }
  }
  covers(provider: string, account: string): boolean {
    return this.accounts.some(a=>a.provider===provider && a.account===account);
  }
  private fileIdentity(): string {
    const info=lstatSync(this.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Installation database changed.");
    return `${realpathSync(this.path)}:${info.dev}:${info.ino}`;
  }
  private transaction<T>(body:()=>T): T {
    if (this.closed || this.fileIdentity()!==this.identity) throw new Error("Installation database changed.");
    this.db.run("BEGIN IMMEDIATE");
    try { const result=body(); this.db.run("COMMIT"); return result; }
    catch(error) { if(this.db.inTransaction)this.db.run("ROLLBACK"); throw error; }
  }
  private assertIdle(): void {
    // Full durable tables, not the HTTP endpoint's last 200 executions/100 jobs.
    for (const row of this.db.query<{value:string},[]>("SELECT value FROM work_executions").all()) {
      if (JSON.parse(row.value)?.status!=="finished") throw new Error("Managed work is enabled, pending, running or uncertain.");
    }
    for (const row of this.db.query<{value:string},[]>("SELECT value FROM work_policies").all()) {
      const policy=JSON.parse(row.value);
      if (typeof policy?.enabled!=="boolean" || policy.state?.activeExecutionId!==null)
        throw new Error("Managed work is enabled, pending, running or uncertain.");
      if (policy.enabled && !this.covers(policy.provider,policy.account))
        throw new Error("An enabled work account is outside installation maintenance.");
    }
    if (this.db.query<{state:string},[]>("SELECT state FROM jobs").all().some(j=>!["succeeded","failed","cancelled"].includes(j.state)))
      throw new Error("Managed work is enabled, pending, running or uncertain.");
  }
  assertHeldAndIdle(): void {
    this.transaction(() => {
      for (const fence of this.fences) {
        const row=this.db.query<{value:string},[string]>("SELECT value FROM work_fences WHERE id=?").get(fence.id);
        if(row?.value!==fence.value) throw new Error("Installation maintenance fence changed.");
      }
      this.assertIdle();
    });
  }
  release(): void {
    this.transaction(() => {
      for (const fence of this.fences) {
        const row=this.db.query<{value:string},[string]>("SELECT value FROM work_fences WHERE id=?").get(fence.id);
        if(row?.value!==fence.value) throw new Error("Installation maintenance fence changed.");
      }
      for (const fence of this.fences) this.db.query("DELETE FROM work_fences WHERE id=? AND value=?").run(fence.id,fence.value);
    });
    this.close();
  }
  /** Failed recovery leaves durable fences intact for explicit repair. */
  close(): void { if(!this.closed){this.closed=true;this.db.close();} }
}
