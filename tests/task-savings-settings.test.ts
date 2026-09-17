import {expect,test} from "bun:test";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {TaskSavingsSettings} from "../src/task-savings-settings";
import {DEFAULT_TASK_SAVINGS} from "../src/task-savings";

test("savings policy is independent, acknowledges compatible relays, and undo persists without exposing secrets",async()=>{
 const root=await mkdtemp(join(tmpdir(),'quotapie-savings-settings-'));
 const paths:string[]=[];
 try {
  for(const gen of ['1','2']) {
   const dir=join(root,'releases',gen);await mkdir(dir,{recursive:true});const path=join(dir,'settings.json');paths.push(path);
   await writeFile(path,JSON.stringify({port:45000+Number(gen),token:'ab'.repeat(24),route:{from:'gpt-6-astra',to:'gpt-5.6-sol',effort:'low'}}));
  }
  await writeFile(join(root,'current.json'),JSON.stringify({settings_path:paths[1],profile_settings:{"/profile/two":paths[0]},retired_settings:[]}));
  const fetcher=(async(url:any)=>{
   const old=String(url).includes('45001');const settings=JSON.parse(await readFile(old?paths[0]!:paths[1]!,'utf8'));
   return Response.json({service:'quotapie-compaction',schemaVersion:old?2:3,savingsModelSupported:true,taskSavings:settings.taskSavings??DEFAULT_TASK_SAVINGS});
  }) as typeof fetch;
  const store=new TaskSavingsSettings(root,fetcher);
  const status=await store.configure({enabled:true});
  expect(status).toMatchObject({enabled:true,compatible:1,applied:1,generations:2});
  expect(JSON.stringify(status)).not.toContain('abab');
  const current=JSON.parse(await readFile(paths[1]!,'utf8'));
  expect(current.route.to).toBe('gpt-5.6-sol');
  expect(JSON.parse(await readFile(paths[0]!,'utf8')).taskSavings).toBeUndefined();
  const id='11111111-1111-4111-8111-111111111111';
  expect((await store.configure({bypassThread:id}))?.bypassThreads).toEqual([id]);
  expect((await store.configure({enabled:false}))?.enabled).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("unsupported or malformed policy cannot silently enable savings",async()=>{
 const root=await mkdtemp(join(tmpdir(),'quotapie-savings-missing-'));
 try {
  const store=new TaskSavingsSettings(root);
  await expect(store.configure({enabled:'true'})).rejects.toThrow();
  await expect(store.configure({bypassThread:'../../settings'})).rejects.toThrow();
  expect(await store.status()).toBeNull();
 }finally{await rm(root,{recursive:true,force:true});}
});
