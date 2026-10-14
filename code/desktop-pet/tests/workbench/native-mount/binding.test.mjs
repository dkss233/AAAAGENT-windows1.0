import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { createNativeExecutionBinding } from '../../../workbench/native-mount/execution-binding.mjs';
import { createNativeExecutionGate } from '../../../workbench/native-mount/execution-gate.mjs';
import { openDailyExecutionGate } from '../../../workbench/native-mount/daily-execution.mjs';

function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'aaa-original-binding-')));
  const path=join(root,'data/desktop-pet/t3-home/userdata/state.sqlite'),codexHome=join(root,'.codex'),nativePath=join(codexHome,'state_5.sqlite');
  mkdirSync(join(path,'..'),{recursive:true});mkdirSync(codexHome);
  const config=join(root,'artifacts/W0-I/model-evaluation/trial/user-trial/config.json');
  mkdirSync(join(config,'..'),{recursive:true});writeFileSync(config,JSON.stringify({sourceRevision:'a'.repeat(40)}));
  const db=new Database(path),native=new Database(nativePath);
  db.exec(`CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT);
    CREATE TABLE projection_threads(thread_id TEXT,project_id TEXT,worktree_path TEXT,archived_at TEXT,deleted_at TEXT,model_selection_json TEXT);
    CREATE TABLE provider_session_runtime(thread_id TEXT,provider_name TEXT,provider_instance_id TEXT,resume_cursor_json TEXT);
    CREATE TABLE projection_thread_sessions(thread_id TEXT,active_turn_id TEXT);
    CREATE TABLE projection_turns(thread_id TEXT);
    CREATE TABLE projection_pending_approvals(request_id TEXT,thread_id TEXT,turn_id TEXT,status TEXT,decision TEXT);
    CREATE TABLE projection_thread_activities(thread_id TEXT,turn_id TEXT,kind TEXT,payload_json TEXT,sequence INTEGER,created_at TEXT,activity_id TEXT);
    CREATE TABLE orchestration_command_receipts(command_id TEXT);
    CREATE TABLE orchestration_events(aggregate_kind TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT);
    INSERT INTO projection_projects VALUES('project-1','/controlled/workspace',NULL)`);
  native.exec('CREATE TABLE threads(id TEXT,cwd TEXT,originator TEXT,archived INTEGER)');
  const readonly=new Database(path,{readonly:true,fileMustExist:true}),readonlyNative=new Database(nativePath,{readonly:true,fileMustExist:true});
  let admission=null, shared=null;
  const binding=createNativeExecutionBinding({environmentId:'environment-1',database:readonly,codexDatabase:readonlyNative,readAdmission:()=>admission,readSharedCodexConnection:()=>shared});
  t.after(()=>{for(const d of [readonly,readonlyNative,db,native])d.close();rmSync(root,{recursive:true,force:true});});
  function add(id,originator,provider='codex',nativeId='native-'+id) {
    db.prepare('INSERT INTO projection_threads VALUES(?,?,NULL,NULL,NULL,?)').run(id,'project-1',JSON.stringify({instanceId:provider,model:'controlled-model'}));
    if(originator===null)return;
    db.prepare('INSERT INTO provider_session_runtime VALUES(?,?,?,?)').run(id,provider,provider,JSON.stringify(provider==='codex'?{threadId:nativeId}:{sessionId:nativeId}));
    if(provider==='codex')native.prepare('INSERT INTO threads VALUES(?,?,?,0)').run(nativeId,'/controlled/workspace',originator);
  }
  return {root,codexHome,db,native,binding,add,setAdmission:value=>{admission=value;},setShared:value=>{shared=value;}};
}
const provider={providerInstanceId:'codex',send:true,continue:true,modelSelection:true,runtimeModes:['approval-required'],
  attachments:{file:true,image:true,maxBytes:1024},interrupt:true,approval:true,userInput:true};
const turn=(threadId,commandId='command-'+threadId)=>({type:'thread.turn.start',commandId,threadId,
  runtimeMode:'approval-required',message:{role:'user',text:'controlled',attachments:[]}});
const request=payload=>({id:'rpc-'+payload.commandId,payload});

test('exact native provenance controls UI and backend even when the provider supports continuation',async t=>{
  const f=fixture(t);f.add('app','Codex Desktop');f.add('own','t3code_desktop');f.add('unknown','');f.add('draft',null);
  f.db.prepare('INSERT INTO projection_turns VALUES(?)').run('draft');
  const before=f.db.prepare('SELECT total_changes() AS n').get().n;
  const gate=createNativeExecutionGate({environmentId:'environment-1',providers:[provider],...f.binding});
  const app=await gate.targetCapability('app');assert.equal(app.source,'codex-app');assert.equal(app.readonly,true);
  assert.deepEqual(app.commandTypes,[]);assert.equal((await gate.reserve(request(turn('app')))).kind,'deny');
  assert.equal((await gate.targetCapability('unknown')).readonly,true);
  assert.equal((await gate.targetCapability('draft')).readonly,true);
  const own=await gate.targetCapability('own');assert.equal(own.source,'t3');assert.equal(own.readonly,false);
  assert.equal((await gate.reserve(request(turn('own')))).kind,'forward');
  f.native.prepare('UPDATE threads SET cwd=? WHERE id=?').run('/foreign','native-own');
  assert.equal((await gate.targetCapability('own')).readonly,true);
  assert.equal((await gate.reserve(request(turn('own','second')))).kind,'deny');
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before,'binding reads never mutate original projections');
});

test('a verified shared owner permits the exact original App SID without changing provenance, and loss closes new commands',async t=>{
  const f=fixture(t); f.add('app','Codex Desktop'); f.add('unknown','foreign-client');
  const gate=createNativeExecutionGate({environmentId:'environment-1',providers:[provider],...f.binding});
  assert.equal((await gate.targetCapability('app')).readonly,true);
  f.setShared({codexHome:f.codexHome,serverPid:102,originalAppPid:101});
  const scope=f.binding.getTarget('app');
  assert.equal(scope.source,'codex-app'); assert.equal(scope.nativeSessionId,'native-app');
  assert.equal(scope.executionOwner,'shared-codex'); assert.equal(scope.readonly,false);
  const target=await gate.targetCapability('app');
  assert.equal(target.source,'codex-app'); assert.equal(target.readonly,false); assert.equal(target.reason,null);
  assert.ok(target.commandTypes.includes('thread.turn.start'));
  assert.equal((await gate.reserve(request(turn('app')))).kind,'forward');
  assert.equal((await gate.targetCapability('unknown')).readonly,true);
  f.setShared(null);
  assert.equal((await gate.reserve(request(turn('app','after-shared-disconnect')))).kind,'deny');
  f.setShared({serverPid:102,originalAppPid:101});
  f.db.prepare('UPDATE projection_threads SET archived_at=? WHERE thread_id=?').run('2026-10-05T00:00:00Z','app');
  assert.equal((await gate.targetCapability('app')).readonly,true);
});

test('new threads require a real existing project and DSH resumes retain the exact original binding',t=>{
  const f=fixture(t);
  const bootstrap={createThread:{projectId:'project-1',modelSelection:{instanceId:'codex',model:'controlled-model'},worktreePath:null}};
  assert.equal(f.binding.prepareCommand({...turn('new'),bootstrap}).newThread,true);
  assert.equal(f.binding.prepareCommand({...turn('new'),bootstrap:{createThread:{...bootstrap.createThread,projectId:'missing'}}}),null);
  assert.equal(f.binding.prepareCommand({...turn('new'),bootstrap:{createThread:{...bootstrap.createThread,worktreePath:'/private'}}}),null);
  const sid='t3_'+createHash('sha256').update(JSON.stringify(['environment-1','dsh-own'])).digest('hex').slice(0,40);
  f.add('dsh-own','dsh','dsh',sid);assert.equal(f.binding.getTarget('dsh-own').readonly,false);
  f.db.prepare('UPDATE provider_session_runtime SET resume_cursor_json=? WHERE thread_id=?').run(JSON.stringify({sessionId:'t3_foreign'}),'dsh-own');
  assert.equal(f.binding.getTarget('dsh-own').readonly,true);assert.equal(f.binding.getTarget('dsh-own').nativeSessionId,'t3_foreign');
  assert.equal(f.binding.prepareCommand({...turn('dsh-own'),bootstrap}),null,'existing thread cannot be replaced through bootstrap');
});

test('interrupts, approvals and answers bind the original current turn and unresolved request',t=>{
  const f=fixture(t);f.add('own','t3code_desktop');f.db.prepare('INSERT INTO projection_thread_sessions VALUES(?,?)').run('own','turn-current');
  assert.equal(f.binding.prepareCommand({type:'thread.turn.interrupt',threadId:'own',turnId:'turn-old'}),null);
  assert.equal(f.binding.prepareCommand({type:'thread.turn.interrupt',threadId:'own',turnId:'turn-current'}).threadId,'own');
  f.db.prepare('INSERT INTO projection_pending_approvals VALUES(?,?,?,?,?)').run('approval','own','turn-current','pending',null);
  const approval={type:'thread.approval.respond',threadId:'own',requestId:'approval'};
  assert.equal(f.binding.prepareCommand(approval).threadId,'own');
  f.db.prepare('UPDATE projection_pending_approvals SET decision=?').run('accept');
  assert.equal(f.binding.prepareCommand(approval),null,'a submitted choice waits for original native resolution');
  f.db.prepare('UPDATE projection_pending_approvals SET decision=NULL').run();
  f.db.prepare('UPDATE projection_pending_approvals SET status=?').run('resolved');assert.equal(f.binding.prepareCommand(approval),null);
  const insert=f.db.prepare('INSERT INTO projection_thread_activities VALUES(?,?,?,?,?,?,?)');
  insert.run('own','turn-current','user-input.requested',JSON.stringify({requestId:'question'}),1,'2026-10-03T00:00:00Z','activity-1');
  const answer={type:'thread.user-input.respond',threadId:'own',requestId:'question'};
  assert.equal(f.binding.prepareCommand(answer).threadId,'own');
  insert.run('own','turn-current','user-input.resolved',JSON.stringify({requestId:'question'}),2,'2026-10-03T00:00:01Z','activity-2');
  assert.equal(f.binding.prepareCommand(answer),null);
});

test('DSH continued questions bind the original native call and are not reanswered after durable submission', t => {
  const f=fixture(t),threadId='dsh-own';
  const sid='t3_'+createHash('sha256').update(JSON.stringify(['environment-1',threadId])).digest('hex').slice(0,40);
  f.add(threadId,'dsh','dsh',sid);
  const requestId='dsh:'+sid+':question:call-1';
  f.db.prepare('INSERT INTO projection_thread_activities VALUES(?,?,?,?,?,?,?)').run(threadId,'old-turn',
    'user-input.requested',JSON.stringify({requestId}),1,'2026-10-03T00:00:00Z','question-activity');
  const answer={type:'thread.user-input.respond',threadId,requestId};
  assert.equal(f.binding.prepareCommand(answer).threadId,threadId);
  assert.equal(f.binding.prepareCommand({...answer,requestId:'dsh:foreign:question:call-1'}),null);
  f.db.prepare('INSERT INTO orchestration_events VALUES(?,?,?,?)').run('thread',threadId,
    'thread.user-input-response-requested',JSON.stringify({requestId}));
  assert.equal(f.binding.prepareCommand(answer),null);
});

test('daily wiring reads current original identities and retains admission across restart without an execution queue',async t=>{
  const f=fixture(t);f.add('own','t3code_desktop');
  let environmentId='environment-1';const client={async environmentDescriptor(){return {environmentId};},
    async providerModels(){return {providers:[{instanceId:'codex',enabled:true,installed:true,status:'ready',authStatus:'authenticated',
      models:[{id:'controlled-model',reasoningEfforts:[{id:'low'}]}]}]};}};
  const options={projectRoot:f.root,codexHome:f.codexHome,client,providers:[provider]};
  let daily=await openDailyExecutionGate(options);
  const before=f.db.prepare('SELECT total_changes() AS n').get().n;
  try {
    assert.equal((await daily.gate.targetCapability('own')).readonly,false);
    assert.equal((await daily.gate.reserve(request({...turn('own','invalid-model'),modelSelection:{instanceId:'codex',model:'missing'}}))).kind,'deny');
    assert.equal((await daily.gate.reserve(request({...turn('own','invalid-effort'),modelSelection:{instanceId:'codex',model:'controlled-model',options:[{id:'reasoningEffort',value:'invalid'}]}}))).kind,'deny');
    assert.equal((await daily.gate.reserve(request(turn('own')))).kind,'forward');
    daily.close();daily=await openDailyExecutionGate(options);
    assert.equal((await daily.gate.reserve(request(turn('own')))).kind,'deny');
    const journal=JSON.parse(readFileSync(join(f.root,'data/desktop-pet/native-web-admission.json'),'utf8'));
    assert.equal(journal.commands['command-own'].status,'submitted');
    assert.equal(JSON.stringify(journal).includes('controlled'),false);
    environmentId='foreign';await assert.rejects(daily.gate.targetCapability('own'));
    assert.equal((await daily.gate.reserve(request(turn('own','next')))).kind,'deny');
    assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
  } finally {daily.close();}
});

test('daily DSH admission uses exact original binding/catalog and rejects unsupported modes, stop and dismiss', async t => {
  const f=fixture(t),threadId='dsh-daily';
  const sid='t3_'+createHash('sha256').update(JSON.stringify(['environment-1',threadId])).digest('hex').slice(0,40);
  f.add(threadId,'dsh','dsh',sid);
  const client={async environmentDescriptor(){return {environmentId:'environment-1'};},
    async providerModels(instanceId){assert.equal(instanceId,'dsh');return {providers:[{instanceId:'dsh',
      enabled:true,installed:true,status:'ready',authStatus:'authenticated',
      models:[{id:'controlled-model',reasoningEfforts:[{id:'low'}]}]}]};}};
  const daily=await openDailyExecutionGate({projectRoot:f.root,codexHome:f.codexHome,client});
  try {
    const capability=await daily.gate.targetCapability(threadId);
    assert.equal(capability.nativeSessionId,sid);
    const advertised=daily.gate.capability().providers.find(p=>p.providerInstanceId==='dsh');
    assert.ok(advertised.runtimeModes.includes('approval-required'),'the real composer must receive the supported supervised mode');
    const message=key=>({...turn(threadId,key),runtimeMode:'auto-accept-edits',
      modelSelection:{instanceId:'dsh',model:'controlled-model',options:[{id:'reasoningEffort',value:'low'}]}});
    assert.equal((await daily.gate.reserve(request({...message('strict'),runtimeMode:'approval-required'}))).kind,'forward');
    daily.gate.receive('strict',{_tag:'Success',value:{sequence:1}});
    assert.equal((await daily.gate.reserve(request({...message('unsupported'),runtimeMode:'unsupported-mode'}))).kind,'deny');
    assert.equal((await daily.gate.reserve(request({...message('auto'),runtimeMode:'auto'}))).kind,'deny');
    for(const type of ['thread.turn.interrupt','thread.session.stop','thread.user-input.dismiss'])
      assert.equal((await daily.gate.reserve(request({type,threadId,commandId:type.replaceAll('.','-'),turnId:'turn-current',requestId:'question'}))).kind,'deny');
    assert.equal((await daily.gate.reserve(request({...message('foreign-model'),modelSelection:{instanceId:'dsh',model:'missing'}}))).kind,'deny');
    assert.equal((await daily.gate.reserve(request(message('dsh-valid')))).kind,'forward');
    f.db.prepare('UPDATE provider_session_runtime SET resume_cursor_json=? WHERE thread_id=?').run(JSON.stringify({sessionId:'t3_foreign'}),threadId);
    assert.equal((await daily.gate.reserve(request(message('dsh-foreign')))).kind,'deny');
  } finally {daily.close();}
});


test('an inherited desktop label requires exact original web bootstrap, admission and fresh native input provenance', t=>{
  const f=fixture(t);f.add('new-web','Codex Desktop');
  f.native.exec('ALTER TABLE threads ADD COLUMN created_at_ms INTEGER;ALTER TABLE threads ADD COLUMN first_user_message TEXT');
  f.db.exec(`ALTER TABLE orchestration_events ADD COLUMN sequence INTEGER;
    ALTER TABLE orchestration_events ADD COLUMN command_id TEXT;ALTER TABLE orchestration_events ADD COLUMN occurred_at TEXT;
    ALTER TABLE orchestration_events ADD COLUMN actor_kind TEXT;
    ALTER TABLE orchestration_command_receipts ADD COLUMN aggregate_kind TEXT;
    ALTER TABLE orchestration_command_receipts ADD COLUMN aggregate_id TEXT;
    ALTER TABLE orchestration_command_receipts ADD COLUMN status TEXT;ALTER TABLE orchestration_command_receipts ADD COLUMN result_sequence INTEGER`);
  const at='2026-10-04T06:11:29.231Z',fresh=Date.parse(at)+1000,commandId='accepted-first';
  f.native.prepare('UPDATE threads SET created_at_ms=?,first_user_message=?').run(fresh,'original\n\n[Attached image "x" is saved at: /owned/x]');
  const insert=f.db.prepare('INSERT INTO orchestration_events VALUES(?,?,?,?,?,?,?,?)');
  insert.run('thread','new-web','thread.created',JSON.stringify({threadId:'new-web',projectId:'project-1',modelSelection:{instanceId:'codex'}}),1,'server:bootstrap-thread-create:original',at,'server');
  insert.run('thread','new-web','thread.message-sent',JSON.stringify({messageId:'m1',role:'user',text:'original'}),2,'bootstrap-message',at,'server');
  insert.run('thread','new-web','thread.turn-start-requested',JSON.stringify({messageId:'m1',modelSelection:{instanceId:'codex'}}),3,commandId,at,'client');
  insert.run('thread','new-web','thread.session-set',JSON.stringify({session:{status:'running'}}),4,'native-running',new Date(fresh+100).toISOString(),'provider');
  f.db.prepare('INSERT INTO orchestration_command_receipts VALUES(?,?,?,?,?)').run(commandId,'thread','new-web','accepted',3);
  const admission={version:1,environmentId:'environment-1',commands:{[commandId]:{threadId:'new-web',projectId:'project-1',status:'accepted',hash:'1'.repeat(64),sequence:3}}};
  assert.equal(f.binding.getTarget('new-web').readonly,true,'literal alone is readonly');f.setAdmission(admission);
  assert.equal(f.binding.getTarget('new-web').readonly,false);assert.equal(f.binding.getTarget('new-web').source,'t3');
  for (const delta of [{environmentId:'foreign'},{commands:{}}]) {f.setAdmission({...admission,...delta});assert.equal(f.binding.getTarget('new-web').readonly,true);}f.setAdmission(admission);
  for(const createdAt of [fresh-2000,fresh+500]) {f.native.prepare('UPDATE threads SET created_at_ms=?').run(createdAt);assert.equal(f.binding.getTarget('new-web').readonly,true,'imported/preexisting or unmatched native creation stays readonly');}
  f.native.prepare('UPDATE threads SET created_at_ms=?,first_user_message=?').run(fresh,'foreign original');assert.equal(f.binding.getTarget('new-web').readonly,true);
  f.native.prepare('UPDATE threads SET first_user_message=?,cwd=?').run('original','/foreign');assert.equal(f.binding.getTarget('new-web').readonly,true);
});
