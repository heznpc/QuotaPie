import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {appendFileSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_CONFIG} from '../src/config';
import {readLocalBeforeSendEvidence,localRepairParentMatches} from '../src/quota-resume/local-repair';
import type {WorkExecution,WorkPolicy} from '../src/work/types';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});
const threadId='11111111-1111-4111-8111-111111111111',turnId='22222222-2222-4222-8222-222222222222';
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'local-repair-')));roots.push(root);mkdirSync(join(root,'sessions'));writeFileSync(join(root,'auth.json'),'{}');
 const at=Math.floor(Date.now()/1000)*1000-1373,path=join(root,'sessions','r.jsonl');
 const rec=(type:string,payload:any)=>({timestamp:new Date(at).toISOString(),type,payload});
 const rows=[rec('session_meta',{id:threadId}),rec('event_msg',{type:'task_started',turn_id:turnId}),rec('turn_context',{model:'gpt-6.1-sol'}),rec('response_item',{role:'user',content:[{type:'input_text',text:'[QuotaPie quota recovery:parent]\nPrivate prompt'}]}),rec('event_msg',{type:'task_complete',turn_id:turnId,error:{message:JSON.stringify({error:{type:'quotapie_subscription_guard',code:'subscription_pool_execution_target_conflict'}})}})];
 const save=()=>writeFileSync(path,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');save();
 const db=new Database(join(root,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT)');db.run('INSERT INTO threads VALUES (?,?)',[threadId,path]);db.close();
 const config=structuredClone(DEFAULT_CONFIG);config.accounts.codex=[{id:'plus',label:'Plus',enabled:true,codexHome:root}];
 const policy={id:'parent',nativeSessionId:threadId,account:'plus',cwd:root,model:'gpt-6.1-sol',prompt:'[QuotaPie quota recovery:parent]\nPrivate prompt',quotaResume:{turnId:'original',stamp:'original'}} as WorkPolicy;
 const execution={id:'execution',policySnapshot:policy,hostQueue:{threadId,turnId,clientUserMessageId:'client',queuedSubmissionId:'submission',sentAtMs:at-1000}} as WorkExecution;
 const turn={threadId,turnId,status:'failed' as const,errorCode:'other',completedAtMs:Math.floor(at/1000)*1000};
 const client={readLatestTurn:async()=>turn,readTurnForClientMessage:async(_t:string,c:string,after?:string)=>{expect(c).toBe('client');expect(after).toBe('original');return turn}};
 return {root,path,at,rows,save,config,execution,turn,client,read:()=>readLocalBeforeSendEvidence(config,execution,client)};
}
test('exact typed local failure joins stable original marker and official client receipt; precise raw timestamp is retained',async()=>{
 const f=fixture(),e=await f.read();expect(e).toMatchObject({kind:'local-before-send',threadId,turnId,failedAtMs:f.at,errorCode:'subscription_pool_execution_target_conflict'});expect(JSON.stringify(e)).not.toContain('Private');
});
test('generic error, quota failure, foreign marker and newer user input never become a local permit',async()=>{
 for(const mode of ['generic','quota','marker','user','latest','client','credentials','steering']){
  const f=fixture();
  if(mode==='generic')f.rows.at(-1)!.payload.error.message='subscription_pool_execution_target_conflict';
  if(mode==='quota')f.rows.at(-1)!.payload.error.message=JSON.stringify({error:{type:'quotapie_subscription_guard',code:'usageLimitExceeded'}});
  if(mode==='marker')f.rows[3]!.payload.content[0].text='[QuotaPie quota recovery:foreign]\nPrivate prompt';
  if(mode==='steering')f.rows.splice(4,0,{timestamp:new Date(f.at).toISOString(),type:'event_msg',payload:{type:'user_message',message:'New manual steering'}});
  if(mode==='user')f.rows.push({timestamp:new Date(f.at+1).toISOString(),type:'event_msg',payload:{type:'user_message',message:'New manual input'}});
  if(mode==='latest')f.client.readLatestTurn=async()=>({...f.turn,turnId:threadId});
  if(mode==='client')f.client.readTurnForClientMessage=async()=>({...f.turn,turnId:threadId});
  if(mode==='credentials')f.client.readLatestTurn=async()=>{writeFileSync(join(f.root,'auth.json'),'{"changed":true}');return f.turn};
  f.save();expect(await f.read()).toBeNull();
 }
});
test('parent automatic terminal disable is permitted but later user revision or second child is not',()=>{
 const f=fixture(),p=f.execution.policySnapshot;
 Object.assign(p,{purpose:'quota-resume',enabled:true,revision:4,state:{turns:0,activeExecutionId:null}});
 Object.assign(f.execution,{policyRevision:4,status:'finished',dispatchedAtMs:f.at-10,result:{status:'failed',reason:'host-turn-failed'},executionTarget:{account:'b'}});
 const current={...p,enabled:false,revision:5,state:{turns:1,activeExecutionId:null,status:'failed',lastResult:f.execution.result}} as WorkPolicy;
 expect(localRepairParentMatches(current,f.execution)).toBe(true);
 expect(localRepairParentMatches({...current,revision:6},f.execution)).toBe(false);
 expect(localRepairParentMatches({...current,enabled:true},f.execution)).toBe(false);
 expect(localRepairParentMatches({...current,quotaResume:{...current.quotaResume!,localBeforeSendRecovery:{permitId:'p',parentExecutionId:'e',sourceQuotaTurnId:'q'}}},f.execution)).toBe(false);
});
