import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolAccount } from "../src/account-pool";
import { quotaResumeContinuationAccount } from "../src/quota-resume/continuation-account";
import { configuredNativeTargetEndpoint } from "../src/work/native-target-lease";

test("native target reads the effective root TOML setting after unrelated root preferences", () => {
  const endpoint="http://127.0.0.1:12345/token/backend-api/codex";
  const block=`# BEGIN QuotaPie compaction relay\nopenai_base_url = "${endpoint}"\n# END QuotaPie compaction relay\n`;
  expect(configuredNativeTargetEndpoint(`model_reasoning_effort = "high"\n\n${block}[projects]\n`)).toBe(endpoint);
  expect(configuredNativeTargetEndpoint(`[nested]\n${block}`)).toBeNull();
  expect(configuredNativeTargetEndpoint(`notes = '''\n${block}'''\n`)).toBeNull();
  expect(configuredNativeTargetEndpoint(block+block)).toBeNull();
});

test("continuation keeps verified history account and refuses stale identities or unreadable history", () => {
  const root=mkdtempSync(join(tmpdir(),"quota-history-")), path=join(root,"pool.sqlite3");
  const accounts=[{id:"a",identity:"source"},{id:"b",identity:"target"}] as PoolAccount[];
  try {
    expect(quotaResumeContinuationAccount("a","thread",accounts,path)).toBe("a");
    const db=new Database(path);
    db.run("CREATE TABLE bindings(source TEXT,thread TEXT,account TEXT,identity TEXT,source_identity TEXT)");
    db.run("INSERT INTO bindings VALUES('a','thread','b','target','source')"); db.close();
    expect(quotaResumeContinuationAccount("a","thread",accounts,path)).toBe("b");
    expect(quotaResumeContinuationAccount("a","other",accounts,path)).toBe("a");
    expect(()=>quotaResumeContinuationAccount("a","thread",[{id:"a",identity:"changed"},accounts[1]!] as PoolAccount[],path)).toThrow("history-account-changed");
    expect(()=>quotaResumeContinuationAccount("a","thread",[accounts[0]!],path)).toThrow("history-account-changed");
    writeFileSync(join(root,"broken"),"not sqlite");
    expect(()=>quotaResumeContinuationAccount("a","thread",accounts,join(root,"broken"))).toThrow("history-unavailable");
  } finally { rmSync(root,{recursive:true,force:true}); }
});
