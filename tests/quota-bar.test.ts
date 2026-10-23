import { expect, test } from "bun:test";
import { accountQuotaBar, quotaBar, runQuotaBar, type BarAccount } from "../src/quota-bar";
import { DEFAULT_CONFIG } from "../src/config";

test("quota bars shrink with remaining allowance and never invent an unknown value",()=>{
  expect(quotaBar(100,4)).toBe("[━━━━] 100%");
  expect(quotaBar(25,4)).toBe("[━···] 25%");
  expect(quotaBar(95)).toBe("[━━━━━━━━━·] 95%");
  expect(quotaBar(0,4)).toBe("[····] 0%");
  expect(quotaBar(NaN,4)).toBe("[····] —");
});

test("CLI renders only the selected Team account and keeps a visible fallback on service failure", async () => {
  let fail = false;
  const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=> fail ? new Response("unavailable", {status:503}) : Response.json({accounts:[
    {provider:"claude",account:"old",accountLabel:"Old account",enabled:true,collection:{health:"recent-success"},windows:[]},
    {provider:"claude",account:"team",accountLabel:"Desktop",enabled:true,plan:{kind:"team"},claudeAccess:{organizationName:"Example"},collection:{health:"recent-success"},windows:[
      {bucket:"five_hour",label:"Claude 5h",freshness:"fresh",remainingPercent:95,resetsAtMs:Date.now()+60_000}]}
  ]})});
  try {
    const config=structuredClone(DEFAULT_CONFIG);config.dashboard.port=server.port!;config.profile.locale="ko";
    const output:string[]=[];
    expect(await runQuotaBar(config,["--account","team"],line=>output.push(line))).toBe(0);
    expect(output[0]).toContain("Example Team");expect(output[0]).toContain("95%");expect(output[0]).toContain("잔여");
    expect(output[0]).not.toContain("Old account");
    fail=true;
    expect(await runQuotaBar(config,["--account","team"],line=>output.push(line))).toBe(0);
    expect(output[1]).toContain("사용량 확인 불가");expect(output[1]).not.toContain("95%");
  } finally { server.stop(true); }
});
test("team statusline includes model quota and hides expired or failed observations",()=>{
  const account:BarAccount={provider:"claude",account:"team",accountLabel:"Desktop",enabled:true,plan:{kind:"team"},claudeAccess:{organizationName:"Example"},
    collection:{health:"recent-success"},windows:[{bucket:"five_hour",label:"Claude 5h",freshness:"fresh",remainingPercent:95,resetsAtMs:200},
      {bucket:"seven_day_fable",label:"Claude Fable weekly",freshness:"fresh",remainingPercent:85,resetsAtMs:300}]};
  expect(accountQuotaBar(account,100)).toContain("Example Team");
  expect(accountQuotaBar(account,100)).toContain("Fable 7d");
  expect(accountQuotaBar(account,100)).toContain("95%");
  expect(accountQuotaBar(account,250)).not.toContain("95%");
  expect(accountQuotaBar({...account,collection:{health:"stale-success"}},100)).not.toMatch(/\d+%/);
  expect(accountQuotaBar({...account,accountLabel:"\u001b[31mattack\n",claudeAccess:undefined},100)).not.toContain("\u001b");
});
