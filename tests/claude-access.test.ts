import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessSummary, readClaudeAccess, saveClaudeAccess } from "../src/claude-access";

test("access summary keeps selected identity fields without credentials or arbitrary bootstrap data", () => {
  expect(accessSummary({organizationName:"Team",role:"member",email:"a@example.com",sessionKey:"secret",memberships:["private"],prompt:"private"}))
    .toEqual({organizationName:"Team",role:"member",email:"a@example.com"});
  expect(accessSummary({organizationName:"bad\u001b[31m",role:23})).toEqual({});
});

test("inspection results are isolated by account and organization identity and preserve original check times", () => {
  const root=mkdtempSync(join(tmpdir(),"qp-access-")), identity="a".repeat(64);
  try {
    saveClaudeAccess({identity,observedAtMs:200,organizationName:"Team",checks:[{id:"projects",result:"empty",source:"app",observedAtMs:100,count:0,detail:"Example project only"}]},root);
    expect(readClaudeAccess(identity,root)?.checks[0]).toMatchObject({source:"app",observedAtMs:100,count:0,detail:"Example project only"});
    expect(readClaudeAccess("b".repeat(64),root)).toBeUndefined();
    expect(()=>saveClaudeAccess({identity:"../escape",observedAtMs:200,checks:[]},root)).toThrow();
    writeFileSync(join(root,"claude-access",identity+".json"),JSON.stringify({schemaVersion:1,identity,observedAtMs:200,checks:[{id:"unknown",result:"available",source:"api",observedAtMs:100}]}));
    expect(readClaudeAccess(identity,root)).toBeUndefined();
  } finally {rmSync(root,{recursive:true,force:true});}
});
