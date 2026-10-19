import {afterEach,expect,test} from "bun:test";
import {QuotaStorage} from "../src/storage/database";
import {QuotaRecoveryStore} from "../src/quota-resume/recovery";
import type {WindowAnalysis} from "../src/types";
import type {WorkBaseline} from "../src/work/types";

const databases:QuotaStorage[]=[];
afterEach(()=>{for(const db of databases.splice(0)) db.close();});
const failedAt=2_000, bucket="codex:primary";
const baseline=(remainingPercent=80,resetAtMs=10_000):Record<string,WorkBaseline>=>({
  [bucket]:{remainingPercent,epoch:String(resetAtMs),atMs:1_000,observationId:"dispatch-reading"},
});
function window(patch:Partial<WindowAnalysis>={}):WindowAnalysis {
  return {provider:"codex",account:"plus",bucket,quality:"authoritative",freshness:"fresh",
    remainingPercent:80,resetsAtMs:10_000,observedAtMs:3_000,...patch} as WindowAnalysis;
}
function fixture(){const db=new QuotaStorage(":memory:");databases.push(db);return {db,store:new QuotaRecoveryStore(db)};}

test("new timestamps and repeated healthy percentages cannot retry a failed automatic turn",()=>{
  const f=fixture();
  expect(f.store.recovered("child",failedAt,baseline(),[window()],3_000)).toBe(false);
  expect(f.store.recovered("child",failedAt,baseline(),[window({observedAtMs:4_000})],4_000)).toBe(false);
  const restarted=new QuotaRecoveryStore(f.db);
  expect(restarted.recovered("child",failedAt,baseline(),[window({observedAtMs:5_000})],5_000)).toBe(false);
});

test("a post-failure minimum survives restart and a later genuine capacity increase unlocks only that incident",()=>{
  const f=fixture();
  expect(f.store.recovered("child",failedAt,baseline(),[window({remainingPercent:0})],3_000)).toBe(false);
  const restarted=new QuotaRecoveryStore(f.db);
  expect(restarted.recovered("child",failedAt,baseline(),[window({observedAtMs:4_000,remainingPercent:0})],4_000)).toBe(false);
  expect(restarted.recovered("child",failedAt,baseline(),[window({observedAtMs:5_000,remainingPercent:10})],5_000)).toBe(true);
  // Recovery is latched, while normal admission independently checks all fresh
  // percentages/permissions every time. A later failed turn gets a new key.
  expect(new QuotaRecoveryStore(f.db).recovered("child",failedAt,baseline(),[],6_000)).toBe(true);
  expect(restarted.recovered("next-child",failedAt,baseline(),[window({observedAtMs:6_000,remainingPercent:10})],6_000)).toBe(false);
});

test("an actual post-boundary reset may restore a fully available window without a percentage increase",()=>{
  const f=fixture();
  expect(f.store.recovered("child",failedAt,baseline(100),[window({remainingPercent:100})],3_000)).toBe(false);
  expect(f.store.recovered("child",failedAt,baseline(100),[window({remainingPercent:100,observedAtMs:10_000,resetsAtMs:100_000})],10_000)).toBe(true);
});

test("a reset or capacity increase during the failed turn cannot authorize immediate retry afterward",()=>{
  const f=fixture();
  // The old reset already passed while the automatic turn was still running.
  expect(f.store.recovered("old-reset",failedAt,baseline(10,1_500),[
    window({remainingPercent:100,resetsAtMs:100_000})],3_000)).toBe(false);
  expect(f.store.recovered("old-reset",failedAt,baseline(10,1_500),[
    window({remainingPercent:100,resetsAtMs:100_000,observedAtMs:4_000})],4_000)).toBe(false);
  // A larger percentage alone has no timing proof relative to the failure.
  expect(f.store.recovered("old-increase",failedAt,baseline(10),[window()],3_000)).toBe(false);
  expect(f.store.recovered("old-increase",failedAt,baseline(10),[window({observedAtMs:4_000})],4_000)).toBe(false);
  expect(f.store.recovered("old-increase",failedAt,baseline(10),[window({remainingPercent:90,observedAtMs:5_000})],5_000)).toBe(true);
});

test("clock expiry, jitter and a pre-boundary correction cannot stand in for an observed reset",()=>{
  const f=fixture();
  expect(f.store.recovered("jitter",failedAt,baseline(),[window({resetsAtMs:11_000})],3_000)).toBe(false);
  expect(f.store.recovered("clock-only",failedAt,baseline(),[window({observedAtMs:11_000})],11_000)).toBe(false);
  const corrected=window({observedAtMs:9_000,resetsAtMs:100_000});
  expect(f.store.recovered("corrected",failedAt,baseline(),[corrected],9_000)).toBe(false);
  // Re-reading the same measurement after the old boundary is not a new reset.
  expect(f.store.recovered("corrected",failedAt,baseline(),[corrected],11_000)).toBe(false);
  expect(f.store.recovered("corrected",failedAt,baseline(),[window({observedAtMs:11_000,resetsAtMs:100_000})],11_000)).toBe(false);
  expect(f.store.recovered("corrected",failedAt,baseline(),[window({observedAtMs:100_000,resetsAtMs:200_000})],100_000)).toBe(true);
});

test("later prediction corrections replace an already seeded boundary while retaining its capacity minimum",()=>{
  const f=fixture();
  for(const id of ["corrected","minimum"]) {
    expect(f.store.recovered(id,failedAt,baseline(),[window({remainingPercent:10})],3_000)).toBe(false);
    expect(f.store.recovered(id,failedAt,baseline(),[
      window({remainingPercent:10,observedAtMs:4_000,resetsAtMs:100_000})],4_000)).toBe(false);
  }
  const restarted=new QuotaRecoveryStore(f.db);
  expect(restarted.recovered("corrected",failedAt,baseline(),[
    window({remainingPercent:10,observedAtMs:11_000,resetsAtMs:100_000})],11_000)).toBe(false);
  expect(restarted.recovered("corrected",failedAt,baseline(),[
    window({remainingPercent:10,observedAtMs:100_000,resetsAtMs:200_000})],100_000)).toBe(true);
  expect(restarted.recovered("minimum",failedAt,baseline(),[
    window({remainingPercent:20,observedAtMs:5_000,resetsAtMs:100_000})],5_000)).toBe(true);
});

test("an explicit denied-to-allowed transition counts as new capacity and survives restart",()=>{
  const f=fixture();
  expect(f.store.recovered("child",failedAt,baseline(100),[window({remainingPercent:100,metadata:{ordinaryUsageAllowed:false}})],3_000)).toBe(false);
  expect(new QuotaRecoveryStore(f.db).recovered("child",failedAt,baseline(100),[
    window({remainingPercent:100,observedAtMs:4_000,metadata:{ordinaryUsageAllowed:true}})],4_000)).toBe(true);
});

test("a newly reported quota starts with a checkpoint rather than treating its first positive value as recovery",()=>{
  const f=fixture();
  expect(f.store.recovered("child",failedAt,{},[window({remainingPercent:100})],3_000)).toBe(false);
  expect(f.store.recovered("child",failedAt,{},[window({remainingPercent:100,observedAtMs:4_000})],4_000)).toBe(false);
  expect(f.store.recovered("child",failedAt,{},[window({remainingPercent:0,observedAtMs:5_000})],5_000)).toBe(false);
  expect(f.store.recovered("child",failedAt,{},[window({remainingPercent:100,observedAtMs:6_000})],6_000)).toBe(true);
});

test("older low measurements cannot manufacture recovery from an unchanged newer measurement",()=>{
  const f=fixture();
  expect(f.store.recovered("child",failedAt,baseline(),[window({observedAtMs:4_000})],4_000)).toBe(false);
  expect(f.store.recovered("child",failedAt,baseline(),[window({remainingPercent:0,observedAtMs:3_000})],4_000)).toBe(false);
  expect(new QuotaRecoveryStore(f.db).recovered("child",failedAt,baseline(),[window({observedAtMs:4_000})],4_000)).toBe(false);
  expect(f.store.recovered("child",failedAt,baseline(),[window({observedAtMs:5_000})],5_000)).toBe(false);
});

test("stale, future, non-authoritative and malformed samples cannot create recovery evidence",()=>{
  for(const patch of [{quality:"estimated"},{freshness:"stale"},{freshness:"reset_due"},
    {observedAtMs:failedAt},{observedAtMs:4_000},{observedAtMs:NaN},{resetsAtMs:NaN},{resetsAtMs:null},
    {remainingPercent:NaN},{remainingPercent:null},{remainingPercent:-1},{remainingPercent:101}] as Partial<WindowAnalysis>[]) {
    const f=fixture();
    expect(f.store.recovered("child",failedAt,baseline(0),[window({remainingPercent:80,...patch})],3_000)).toBe(false);
    // Invalid low values must not poison the next valid measurement either.
    expect(f.store.recovered("next",failedAt,baseline(),[window({...patch})],3_000)).toBe(false);
    expect(f.store.recovered("next",failedAt,baseline(),[window({observedAtMs:4_000})],4_000)).toBe(false);
  }
  const f=fixture();
  expect(f.store.recovered("child",NaN,baseline(0),[window()],3_000)).toBe(false);
  expect(f.store.recovered("child",failedAt,baseline(0),[window()],NaN)).toBe(false);
  expect(f.store.recovered("child",4_000,baseline(0),[window()],3_000)).toBe(false);
});

test("unusable dispatch baselines require a new checkpoint instead of granting the first sample",()=>{
  for(const patch of [{remainingPercent:-1},{remainingPercent:NaN},{atMs:NaN},{atMs:2_500},{epoch:"unknown"}]) {
    const f=fixture(), before=baseline(0);
    Object.assign(before[bucket]!,patch);
    expect(f.store.recovered("child",failedAt,before,[window()],3_000)).toBe(false);
    expect(f.store.recovered("child",failedAt,before,[window({observedAtMs:4_000})],4_000)).toBe(false);
  }
});
