import {test,expect} from "bun:test";
import {normalizeOfficialThreads} from "../src/official-thread-usage";
import {OfficialUsageAPI} from "../src/official-usage";
import {DEFAULT_CONFIG} from "../src/config";
const candidates=[{threadId:"a",title:"QuotaPie",createdAtMs:1000,descendantIds:["b"]}];
test("official conversation allowance equivalent stays lifetime, null never zero",()=>{const r=normalizeOfficialThreads({data_as_of:"2026-10-19T00:00Z",threads:[{thread_id:"a",data_status:"available",weekly_limit_percent:27.37,five_hour_limit_percent:null,groups:[{model:"astra",reasoning_effort:"xhigh",weekly_limit_percent:27.37,five_hour_limit_percent:null}]}]},candidates);expect(r.threads[0]!.scope).toBe("lifetime");expect(r.threads[0]!.weeklyLimitPercent).toBe(27.37);expect(r.threads[0]!.fiveHourLimitPercent).toBeNull();expect(r.threads[0]!.descendantCount).toBe(1);});
test("reject foreign and duplicate official IDs, negative metrics; unavailable is unknown",()=>{for(const rows of [[{thread_id:"foreign"}],[{thread_id:"a"},{thread_id:"a"}],[{thread_id:"a",data_status:"available",weekly_limit_percent:-1,groups:[]}]])expect(()=>normalizeOfficialThreads({threads:rows},candidates)).toThrow();expect(normalizeOfficialThreads({threads:[]},candidates).threads[0]!.weeklyLimitPercent).toBeNull();});
test("read-only query submits disjoint metadata groups with account credentials",async()=>{let body:any;const api=new OfficialUsageAPI(DEFAULT_CONFIG,(async(url:any,init:any)=>{if(String(url).includes("query_v2")){expect(init.method).toBe("POST");expect(init.headers["chatgpt-account-id"]).toBe("account");body=JSON.parse(init.body);return Response.json({threads:[],data_as_of:null});}return Response.json(String(url).includes("daily-")?{units:"percent",data:[]}:{periods:[]});}) as typeof fetch,()=>[{id:"default",label:"Main",identity:"one",accessToken:"secret",upstreamAccount:"account",tokenExpiresAt:Date.now()+10000,models:[],remaining:null,validUntil:0}],undefined,()=>candidates);const r=await api.read({startDate:"2026-10-15",endDate:"2026-10-19",account:null});expect(body).toEqual({threads:[{thread_id:"a",created_at:"1970-01-01T00:00:01.000Z",descendant_thread_ids:["b"]}]});expect(JSON.stringify(r)).not.toContain("secret");expect(r.accounts[0]!.threads[0]!.dataStatus).toBe("unavailable");});

test("candidate roots are disjoint, account scoped and bounded",async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{Database}=await import("bun:sqlite"),{readOfficialThreadCandidates}=await import("../src/official-thread-usage");
 const root=mkdtempSync(join(tmpdir(),"official-threads-"));
 try{
  writeFileSync(join(root,"auth.json"),JSON.stringify({tokens:{account_id:"mine"}}));
  const db=new Database(join(root,"state_5.sqlite"));db.exec("CREATE TABLE threads(id TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,creator_account_id TEXT);CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT);");
  const add=db.query("INSERT INTO threads VALUES(?,?,1,?,?)");
  add.run("parent","parent",100,"mine");add.run("child","child",101,"mine");add.run("foreign","foreign",105,"other");add.run("mixed","mixed",110,"mine");add.run("foreign-child","foreign",109,"other");
  db.exec("INSERT INTO thread_spawn_edges VALUES('parent','child'),('mixed','foreign-child');");
  for(let i=0;i<25;i++)add.run("r"+i,"root",i,null);db.close();
  const rows=readOfficialThreadCandidates({id:"a",label:"a",enabled:true,codexHome:root});
  expect(()=>readOfficialThreadCandidates({id:"a",label:"a",enabled:true,codexHome:root},"different")).toThrow();expect(rows).toHaveLength(20);expect(rows[0]!.threadId).toBe("parent");expect(rows[0]!.descendantIds).toEqual(["child"]);expect(rows.some(r=>["foreign","child","mixed"].includes(r.threadId))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
