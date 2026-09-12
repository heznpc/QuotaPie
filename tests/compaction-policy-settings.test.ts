import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactionPolicySettings } from "../src/compaction-policy-settings";
import { startDashboard } from "../src/server";
import { QuotaPieService } from "../src/service";
import { QuotaDatabase } from "../src/db";
import { DEFAULT_CONFIG } from "../src/config";

test("authenticated model selection updates supported generations, preserves credentials and reports older routes separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "quotapie-policy-"));
  const paths = [join(root,"releases/123/settings.json"), join(root,"settings.json"), join(root,"releases/122/settings.json")];
  await mkdir(join(root,"releases/123"),{recursive:true});
  await mkdir(join(root,"releases/122"),{recursive:true});
  const original = paths.map((_,i) => ({port:45000+i,token:String(i+1).repeat(48),route:{from:"gpt-6-astra",to:"gpt-5.6-sol",effort:"low"},unrelated:"keep"}));
  for (let i=0;i<paths.length;i++) await writeFile(paths[i]!,JSON.stringify(original[i]));
  await writeFile(join(root,"current.json"),JSON.stringify({settings_path:paths[0],retired_settings:paths.slice(1)}));
  const fetcher = (async (url: string | URL | Request) => {
    const i=Number(new URL(String(url)).port)-45000;
    const settings=JSON.parse(await readFile(paths[i]!,"utf8"));
    return Response.json({service:"quotapie-compaction",schemaVersion:i===1?1:2,route:settings.route});
  }) as typeof fetch;
  try {
    const settings=new CompactionPolicySettings(root,fetcher);
    await expect(settings.configure("gpt-5.3-codex-spark")).rejects.toThrow("invalid_model");
    expect((await settings.configure("gpt-5.6-luna"))?.applied).toBe(2);
    const status=await settings.status();
    expect(status?.generations).toBe(3);
    expect(status?.model).toBe("gpt-5.6-luna");
    for(let i=0;i<paths.length;i++) {
      const actual=JSON.parse(await readFile(paths[i]!,"utf8"));
      expect(actual.token).toBe(original[i]!.token);
      expect(actual.unrelated).toBe("keep");
      expect(actual.route.to).toBe(i===1?"gpt-5.6-sol":"gpt-5.6-luna");
    }
    expect(JSON.stringify(status)).not.toContain(original[0]!.token);
    const config=structuredClone(DEFAULT_CONFIG); config.dashboard.port=0;
    const service=new QuotaPieService(config,new QuotaDatabase(":memory:"));
    const server=startDashboard(service,config,{compactionRoot:root});
    const base=`http://127.0.0.1:${server.port}`;
    try {
      expect((await fetch(base+"/api/compaction/policy")).status).toBe(405);
      expect((await fetch(base+"/api/compaction/policy",{method:"POST",body:'{"model":"gpt-5.6-sol"}'})).status).toBe(403);
      const payload=await (await fetch(base+"/api/status")).json() as any;
      expect((await fetch(base+"/api/compaction/policy",{method:"POST",headers:{origin:"https://example.com","x-quotapie-action-token":payload.actionToken},body:'{"model":"gpt-5.6-sol"}'})).status).toBe(403);
      expect((await fetch(base+"/api/compaction/policy",{method:"POST",headers:{"x-quotapie-action-token":payload.actionToken},body:'{"model":"unsupported"}'})).status).toBe(409);
    } finally { server.stop(true); await service.close(); }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("settings outside the installed relay root cannot be changed",async()=>{
  const root=await mkdtemp(join(tmpdir(),"quotapie-policy-path-"));
  try {
    await writeFile(join(root,"current.json"),JSON.stringify({settings_path:"/tmp/unrelated-settings.json"}));
    const settings=new CompactionPolicySettings(root);
    expect(await settings.status()).toBeNull();
    await expect(settings.configure("gpt-5.6-luna")).rejects.toThrow("policy_update_failed");
  } finally { await rm(root,{recursive:true,force:true}); }
});
