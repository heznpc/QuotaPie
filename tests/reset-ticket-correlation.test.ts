import { expect, test } from "bun:test";
import { correlateResetTicket, resetTicketFollowupDelay } from "../src/reset-ticket-correlation";
import type { QuotaObservation } from "../src/types";
const at = 1800000000000;
const base: QuotaObservation = { provider:"codex", account:"a", bucket:"weekly", label:"weekly",
  source:"appserver", quality:"authoritative", usedPercent:100, resetsAtMs:at+604800000,
  windowSeconds:604800, observedAtMs:at };
const waiting = correlateResetTicket(base, {...base,observedAtMs:at+1000},true,2,true,60000);
const after = {...base,usedPercent:0,resetsAtMs:base.resetsAtMs!+100000,observedAtMs:at+45000};
test("persisted snapshot carries correlation through intervening polls", () => {
  const restored = JSON.parse(JSON.stringify(waiting));
  const poll=correlateResetTicket(restored,{...base,observedAtMs:at+20000},false,2,true,60000);
  expect(correlateResetTicket(poll,after,false,2,true,60000).metadata?.resetTicketRecovery).toBe(true);
});
test("expiry, context, ticket count, source and scheduled reset never swallow unrelated recovery", () => {
  for (const [next,count,context] of [
    [{...after,observedAtMs:at+601001},2,true], [after,1,true], [after,2,false],
    [{...after,source:"other"},2,true], [{...after,account:"other"},2,true],
    [{...after,bucket:"other"},2,true], [{...after,observedAtMs:base.resetsAtMs!-1000},2,true],
  ] as const) expect(correlateResetTicket(waiting,next,false,count,context,60000).metadata?.resetTicketRecovery).toBe(false);
});

test("reset pass observation triggers only a bounded read followup", () => {
 expect(resetTicketFollowupDelay([waiting], at+1000)).toBe(2000);
 expect(resetTicketFollowupDelay([waiting], at+40000)).toBe(10000);
 expect(resetTicketFollowupDelay([waiting], at+92000)).toBeNull();
 expect(resetTicketFollowupDelay([after], at+45000)).toBeNull();
});
