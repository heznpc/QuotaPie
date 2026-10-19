import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {appendFileSync,chmodSync,mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_CONFIG} from '../src/config';
import {readLocalBeforeSendEvidence,localRepairParentMatches,readLocalDenialLogReceipt} from '../src/quota-resume/local-repair';
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
test('automatic terminal disable is permitted but later user revision or changed repair binding is not',()=>{
 const f=fixture(),p=f.execution.policySnapshot;
 Object.assign(p,{purpose:'quota-resume',enabled:true,revision:4,state:{turns:0,activeExecutionId:null}});
 Object.assign(f.execution,{policyRevision:4,status:'finished',dispatchedAtMs:f.at-10,result:{status:'failed',reason:'host-turn-failed'},executionTarget:{account:'b'}});
 const current={...p,enabled:false,revision:5,state:{turns:1,activeExecutionId:null,status:'failed',lastResult:f.execution.result}} as WorkPolicy;
 expect(localRepairParentMatches(current,f.execution)).toBe(true);
 expect(localRepairParentMatches({...current,revision:6},f.execution)).toBe(false);
 expect(localRepairParentMatches({...current,enabled:true},f.execution)).toBe(false);
 expect(localRepairParentMatches({...current,quotaResume:{...current.quotaResume!,localBeforeSendRecovery:{permitId:'p',parentExecutionId:'e',sourceQuotaTurnId:'q'}}},f.execution)).toBe(false);
 p.quotaResume!.localBeforeSendRecovery={permitId:'p',parentExecutionId:'e',sourceQuotaTurnId:'q'};
 expect(localRepairParentMatches({...current,quotaResume:p.quotaResume},f.execution)).toBe(true);
});
test('a repair attempt can prove only its own exact unavailable failure without reclassifying provider errors',async()=>{
 for(const code of ['subscription_pool_execution_target_unavailable','subscription_pool_execution_target_conflict','subscription_pool_target_quota_exhausted','subscription_execution-target-unavailable']){
  const f=fixture();f.execution.policySnapshot.quotaResume!.localBeforeSendRecovery={permitId:'p',parentExecutionId:'e',sourceQuotaTurnId:'quota-root'};
  f.rows.at(-1)!.payload.error.message=JSON.stringify({error:{type:'quotapie_subscription_guard',code}});f.save();
  const evidence=await f.read();
  if(code==='subscription_pool_execution_target_unavailable'||code==='subscription_pool_execution_target_conflict')expect(evidence?.errorCode).toBe(code);
  else expect(evidence).toBeNull();
 }
});
test('native failure may inherit a stable preceding model context, but missing or changed contexts never authorize repair',async()=>{
 for(const variant of ['inherited','missing','changed-prior','changed-current','restored-current']){
  const f=fixture(),context=f.rows.splice(2,1)[0]!;
  if(variant!=='missing'){
   if(variant==='changed-prior'||variant==='restored-current')context.payload.model='gpt-6-astra';
   f.rows.splice(1,0,context);
  }
  if(variant==='changed-current'||variant==='restored-current')f.rows.splice(3,0,{...context,payload:{model:variant==='changed-current'?'gpt-6-astra':'gpt-6.1-sol'}});
  f.save();const evidence=await f.read();
  if(variant==='inherited'||variant==='restored-current')expect(evidence?.model).toBe('gpt-6.1-sol');
  else expect(evidence).toBeNull();
 }
});
test('native compact wrapper retains exact typed local denial, while unstructured wrappers and provider codes stay rejected',async()=>{
 for(const variant of ['compact','other-prefix','double-prefix','suffix','quota']){
  const f=fixture(),context=f.rows.splice(2,1)[0]!;f.rows.splice(1,0,context);
  const code=variant==='quota'?'usage_limit_exceeded':'subscription_pool_execution_target_unavailable';
  const structured=JSON.stringify({error:{type:'quotapie_subscription_guard',code}});
  f.rows.at(-1)!.payload.error.message=(variant==='other-prefix'?'Some failure: ':'Error running remote compact task: ')+
    (variant==='double-prefix'?'Error running remote compact task: ':'')+structured+(variant==='suffix'?' trailing text':'');
  f.save();const evidence=await f.read();
  if(variant==='compact')expect(evidence).toMatchObject({model:'gpt-6.1-sol',errorCode:code});else expect(evidence).toBeNull();
 }
});


function logFixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'local-denial-log-')));roots.push(root);
 const prior=process.env.QUOTAPIE_HOME;process.env.QUOTAPIE_HOME=root;
 const directory=join(root,'relay-logs');mkdirSync(directory,{mode:0o700});
 const path=join(directory,'64866.jsonl'),at=Date.now()-1000;
 const row={kind:'native_request',method:'POST',routeFamily:'responses',status:400,origin:'relay',reason:'pool_execution_target_conflict',
   requestId:'871db8d9-c7dc-4100-86a4-18b424dbd582',at:new Date(at).toISOString()};
 const save=(suffix='',value:any=row)=>writeFileSync(path+suffix,JSON.stringify(value)+'\n',{mode:0o600});
 const read=()=>readLocalDenialLogReceipt('http://127.0.0.1:64866/token/backend-api/codex',at+4,at-1000,at+1000);
 return {root,directory,path,at,row,save,read,restore:()=>{if(prior===undefined)delete process.env.QUOTAPIE_HOME;else process.env.QUOTAPIE_HOME=prior}};
}
test('one stable exact denial survives either product log rotation after the live ring evicts it',async()=>{
 for(const suffix of ['','.1','.2']){const f=logFixture();try{
  f.save(suffix);expect(await f.read()).toEqual({requestId:f.row.requestId,at:f.row.at});
 }finally{f.restore()}}
});
test('unavailable log receipt must match the exact typed host rejection reason',async()=>{
 const f=logFixture();try{
  f.save('',{...f.row,reason:'pool_execution_target_unavailable'});
  expect(await f.read()).toBeNull();
  expect(await readLocalDenialLogReceipt('http://127.0.0.1:64866/token/backend-api/codex',f.at+4,f.at-1000,f.at+1000,'pool_execution_target_unavailable')).toEqual({requestId:f.row.requestId,at:f.row.at});
 }finally{f.restore()}
});
test('log receipt is bounded, unique, canonical, complete and never accepts a provider error or foreign endpoint',async()=>{
 for(const mode of ['duplicate','malformed','truncated','oversized','symlink','directory-symlink','writable','provider','future','old','bad-id','remote','port']){
  const f=logFixture();try{
   f.save();
   if(mode==='duplicate')f.save('.1',{...f.row,requestId:threadId});
   if(mode==='malformed')appendFileSync(f.path,'not-json\n');
   if(mode==='truncated')appendFileSync(f.path,'{');
   if(mode==='oversized')writeFileSync(f.path,' '.repeat(2*1024*1024+1));
   if(mode==='symlink'){renameSync(f.path,f.path+'.else');symlinkSync(f.path+'.else',f.path)}
   if(mode==='directory-symlink'){renameSync(f.directory,f.directory+'.else');symlinkSync(f.directory+'.else',f.directory)}
   if(mode==='writable')chmodSync(f.path,0o666);
   if(mode==='provider')f.save('',{...f.row,origin:'provider'});
   if(mode==='future')f.save('',{...f.row,at:new Date(f.at+5).toISOString()});
   if(mode==='old')f.save('',{...f.row,at:new Date(f.at-1001).toISOString()});
   if(mode==='bad-id')f.save('',{...f.row,requestId:'not-a-request'});
   const result=mode==='remote'||mode==='port'?await readLocalDenialLogReceipt(mode==='remote'?'https://example.com:64866/token':'http://127.0.0.1:64867/token',f.at+4,f.at-1000,f.at+1000):await f.read();
   expect(result).toBeNull();
  }finally{f.restore()}
 }
});
test('an append or rotation while logs are read fails closed and can be retried from a stable snapshot',async()=>{
 for(const mode of ['append','rotate']){const f=logFixture();try{
  writeFileSync(f.path,Array.from({length:256},()=>JSON.stringify({kind:'native_request',routeFamily:'models'})).join('\n')+'\n'+JSON.stringify(f.row)+'\n',{mode:0o600});
  const mutation=new Promise<void>(resolve=>setImmediate(()=>{if(mode==='append')appendFileSync(f.path,JSON.stringify({kind:'other'})+'\n');
    else {renameSync(f.path,f.path+'.1');writeFileSync(f.path,JSON.stringify({kind:'other'})+'\n',{mode:0o600})}resolve()}));
  expect(await f.read()).toBeNull();await mutation;expect(await f.read()).toEqual({requestId:f.row.requestId,at:f.row.at});
 }finally{f.restore()}}
});
