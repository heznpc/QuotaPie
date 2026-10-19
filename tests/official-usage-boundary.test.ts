import { test, expect } from "bun:test";
import { QuotaDatabase } from "../src/db";
import { DEFAULT_CONFIG } from "../src/config";
import { officialUsageBoundary } from "../src/official-usage-boundary";

test("real weekly bucket identity selects the requested local Thursday, not later recovery or another account", () => {
  const database = new QuotaDatabase(":memory:");
  const config = structuredClone(DEFAULT_CONFIG);
  const now = Date.parse("2026-10-19T10:00:00Z");
  const boundary = Date.parse("2026-10-15T06:14:18.922Z");
  const query = {startDate:"2026-10-13",endDate:"2026-10-19",account:null,analysisDate:"2026-10-15",analysisTimeZone:"Asia/Seoul"};
  const insert = database.db.query(`INSERT INTO events(provider,account,bucket,kind,severity,occurred_at_ms,confidence,summary,details_json,fingerprint)
    VALUES('codex',?,?,'external_relief','info',?,'high','',?,hex(randomblob(16)))`);
  const details = JSON.stringify({usedPercentBefore:83,usedPercentAfter:0,previousQuality:"authoritative",nextQuality:"authoritative"});
  try {
    insert.run("default","codex:primary:10080",boundary,details);
    insert.run("default","codex:primary:300",boundary,details);
    insert.run("default","codex:primary:10080",Date.parse("2026-10-18T00:00:00Z"),details);
    expect(officialUsageBoundary(database.db,config,"default",query,now)).toEqual({atMs:boundary,kind:"external_relief"});
    expect(officialUsageBoundary(database.db,config,"other",query,now)).toBeNull();
    expect(officialUsageBoundary(database.db,config,"default",{...query,analysisDate:"2026-10-14"},now)).toBeNull();
    insert.run("default","codex:secondary:10080",boundary+1000,details);
    expect(officialUsageBoundary(database.db,config,"default",query,now)).toBeNull();
  } finally { database.close(); }
});
