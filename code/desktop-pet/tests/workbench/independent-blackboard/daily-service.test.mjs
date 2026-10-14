import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDailyBoardService } from '../../../workbench/independent-blackboard/service.mjs';
import { readPrivateBoardJson } from '../../../workbench/independent-blackboard/registry.mjs';
import { createNativeExecutionGate } from '../../../workbench/native-mount/execution-gate.mjs';
const originalSchema=process.env.NATIVE_THREAD_TURN_SCHEMA_MODULE ? await import(process.env.NATIVE_THREAD_TURN_SCHEMA_MODULE) : null;
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../..');

export async function fixture(t, { grant=true, dispatchLimit=2, lost=false, clock=()=>Date.parse('2026-10-04T10:00:00Z') }={}) {
  const parent=resolve(root,'artifacts/W0-I/web-execution-56/independent-board-daily-01/fixtures');mkdirSync(parent,{recursive:true});
  const temp=mkdtempSync(resolve(parent,'daily-'));t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const scope={environmentId:'local-controlled',projectId:'original-project'};
  const participants=[{actorId:'c',threadId:'coordinator-original',providerInstanceId:'codex',role:'coordinator',title:'Coordinator'},
    {actorId:'a',threadId:'executor-original-a',providerInstanceId:'codex',role:'executor',title:'A'},
    {actorId:'b',threadId:'executor-original-b',providerInstanceId:'codex',role:'executor',title:'B'}];
  const model={instanceId:'codex',model:'controlled-local',options:{reasoningEffort:'high'}};
  const threads=new Map(participants.map((p,i)=>[p.threadId,{id:p.threadId,projectId:scope.projectId,deletedAt:null,archivedAt:null,
    modelSelection:structuredClone(model),runtimeMode:'approval-required',interactionMode:'default',branch:'codex/test-'+p.actorId,
    worktreePath:resolve(temp,'tree-'+p.actorId),nativeSessionObservation:{nativeId:'original-native-'+i},session:{status:'ready',activeTurnId:null}}]));
  const commands=[],receipts=new Map();let environment=scope.environmentId;
  const client={environmentDescriptor:async()=>({environmentId:environment}),shellSnapshot:async()=>({projects:[{id:scope.projectId,workspaceRoot:temp,deletedAt:null}],threads:[...threads.values()]}),
    threadSnapshot:async id=>({thread:structuredClone(threads.get(id))}),readReceipt:async id=>receipts.get(id)??null,
    dispatch:async cmd=>{originalSchema?.validate(cmd);commands.push(structuredClone(cmd));receipts.set(cmd.commandId,{commandId:cmd.commandId,aggregateKind:'thread',aggregateId:cmd.threadId,status:'accepted',resultSequence:12});if(lost)throw Error('controlled lost response');return{sequence:12};}};
  const target=id=>threads.has(id)?{...scope,threadId:id,providerInstanceId:'codex',nativeSessionId:threads.get(id).nativeSessionObservation.nativeId,source:'t3',readonly:false,newThread:false,modelSelection:threads.get(id).modelSelection}:null;
  const gate=createNativeExecutionGate({environmentId:scope.environmentId,file:resolve(temp,'admission.json'),
    providers:[{providerInstanceId:'codex',send:true,continue:true,modelSelection:true,runtimeModes:['approval-required'],attachments:{file:true,image:true,maxBytes:100},interrupt:true,approval:true,userInput:true}],
    getTarget:async id=>target(id),prepareCommand:async c=>target(c.threadId),findReceipt:async id=>receipts.get(id)});
  const service=createDailyBoardService({directory:resolve(temp,'boards'),client,gate,now:clock});
  const registration=await service.register({scope,participants,...(grant?{dispatchAuthorization:{authorizationId:'controlled-only',maxDispatches:dispatchLimit,expiresAt:'2026-10-04T11:00:00Z'}}:{})});
  const contexts=Object.fromEntries(registration.participants.map(p=>[p.actorId,readPrivateBoardJson(p.contextFile)]));
  let seq=0;
  const act=async(actorId,kind,body={},options={})=>{
    const request={scope,actorId,kind,body,operationId:options.operationId??'operation-'+(++seq),expectedRevision:options.expectedRevision??(await service.read(scope)).revision};
    return service.actor(request,contexts[actorId].capability);
  };
  const assign=async()=>{await act('c','read');await act('c','assign',{tasks:[{taskId:'task-a',ownerActorId:'a',title:'A',instructions:'实际原任务A'}, {taskId:'task-b',ownerActorId:'b',title:'B',instructions:'实际原任务B'}]});await act('c','read');};
  return{temp,scope,service,registration,contexts,threads,commands,receipts,act,assign,client,setEnvironment:x=>{environment=x;}};
}

test('registration preserves three original identities and separate worktrees, creates no native command and exposes no actor secrets',async t=>{
  const f=await fixture(t);const board=await f.service.read(f.scope);
  assert.deepEqual(board.participants.map(p=>p.threadId),['coordinator-original','executor-original-a','executor-original-b']);
  assert.deepEqual(board.participants.map(p=>p.nativeThreadId),['original-native-0','original-native-1','original-native-2']);
  assert.equal(f.commands.length,0);assert.equal(board.revision,0);
  for(const context of Object.values(f.contexts))assert.equal(JSON.stringify(f.registration).includes(context.capability),false);
});

test('actual transaction store enforces read, owner, report source and summary lifecycle, retaining original idempotent responses',async t=>{
  const f=await fixture(t);const first=await f.act('c','read',{}, {operationId:'first-read',expectedRevision:0});
  await f.act('c','assign',{tasks:[{taskId:'task-a',ownerActorId:'a',title:'A',instructions:'A原分工'},{taskId:'task-b',ownerActorId:'b',title:'B',instructions:'B原分工'}]});
  await assert.rejects(f.act('b','start',{taskId:'task-a'}),/board_store_rejected/);
  for(const actor of ['a','b']){await f.act(actor,'read');await f.act(actor,'start',{taskId:'task-'+actor});await f.act(actor,'report',{taskId:'task-'+actor,text:'原实际回报'+actor});}
  let board=await f.service.read(f.scope);await assert.rejects(f.act('c','summary',{text:'未读取报告',reportEventIds:board.tasks.map(x=>x.report.eventId)}),/board_store_rejected/);
  await f.act('c','read');board=await f.service.read(f.scope);await f.act('c','summary',{text:'按原报告汇总',reportEventIds:board.tasks.map(x=>x.report.eventId)});
  const closed=await f.service.read(f.scope);assert.equal(closed.status,'summarized');assert.equal(closed.relations.length,4);assert.equal(f.commands.length,0);
  assert.deepEqual(await f.act('c','read',{}, {operationId:'first-read',expectedRevision:0}),first);
});

test('role capabilities reject impersonation and executor assignment; concurrent stale writes accept only one',async t=>{
  const f=await fixture(t);const request={scope:f.scope,actorId:'c',kind:'read',body:{},operationId:'wrong-cap',expectedRevision:0};
  await assert.rejects(f.service.actor(request,f.contexts.a.capability),/actor_not_authorized/);
  await assert.rejects(f.act('a','assign',{tasks:[]}),/board_store_rejected/);
  const results=await Promise.allSettled([f.act('a','read',{}, {expectedRevision:0}),f.act('b','read',{}, {expectedRevision:0})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.commands.length,0);
});

test('coordinator dispatch uses original recipient, model, permissions and existing admission once',async t=>{
  const f=await fixture(t);await f.assign();const r=await f.act('c','dispatch',{taskId:'task-a'},{operationId:'dispatch-a'});
  assert.equal(r.status,'accepted');assert.equal(f.commands.length,1);const c=f.commands[0];assert.equal(c.threadId,'executor-original-a');
  assert.deepEqual(c.modelSelection,f.threads.get(c.threadId).modelSelection);assert.equal(c.runtimeMode,'approval-required');assert.equal(c.interactionMode,'default');assert.match(c.message.text,/实际原任务A/);
  assert.equal((await f.act('c','dispatch',{taskId:'task-a'},{operationId:'dispatch-a'})).resent,false);assert.equal(f.commands.length,1);
  await assert.rejects(f.act('c','dispatch',{taskId:'task-a'},{operationId:'changed-operation'}),/original_dispatch_frozen/);
  await assert.rejects(f.act('c','dispatch',{taskId:'task-b'},{operationId:'dispatch-a'}),/dispatch_operation_changed/);
  assert.equal(f.commands.length,1);
});

test('changed private role context is refused before original dispatch admission',async t=>{
  const f=await fixture(t);await f.assign();const revision=(await f.service.read(f.scope)).revision;
  const context=f.registration.participants.find(p=>p.actorId==='c').contextFile;
  const altered={...f.contexts.c,capability:'a'.repeat(64)};writeFileSync(context,JSON.stringify(altered));
  await assert.rejects(f.service.actor({scope:f.scope,actorId:'c',kind:'dispatch',body:{taskId:'task-a'},operationId:'altered',expectedRevision:revision},altered.capability),/actor_context_changed/);
  assert.equal(f.commands.length,0);
});

test('unverified transport success stays submitted until exact original receipt is read',async t=>{
  const f=await fixture(t);await f.assign();const original=f.client.dispatch;
  f.client.dispatch=async command=>{await original(command);return {};};
  const unknown=await f.act('c','dispatch',{taskId:'task-a'},{operationId:'malformed-a'});assert.equal(unknown.status,'submitted');assert.equal(unknown.sequence,null);
  const receipt=await f.act('c','dispatch-receipt',{taskId:'task-a'},{operationId:'malformed-a'});assert.equal(receipt.status,'accepted');assert.equal(receipt.sequence,12);assert.equal(f.commands.length,1);
});

test('unknown accepted transport result survives service restart and cold-read after expiry or model change without replay',async t=>{
  const f=await fixture(t,{lost:true});await f.assign();const submitted=await f.act('c','dispatch',{taskId:'task-a'},{operationId:'unknown-a'});assert.equal(submitted.status,'submitted');
  f.threads.get('executor-original-a').modelSelection.model='changed-later';
  const resumed=createDailyBoardService({directory:resolve(f.temp,'boards'),client:f.client,gate:{targetCapability:async()=>{throw Error('must not re-admit');},reconcile(){}},now:()=>Date.parse('2026-10-05T10:00:00Z')});
  const receipt=await resumed.actor({scope:f.scope,actorId:'c',kind:'dispatch-receipt',operationId:'unknown-a',body:{taskId:'task-a'}},f.contexts.c.capability);
  assert.equal(receipt.status,'accepted');assert.equal(receipt.sequence,12);assert.equal(f.commands.length,1);
});

for(const fault of ['no-grant','expired','busy','model-changed','workspace-changed','native-changed','environment-changed'])test(`fresh dispatch refuses ${fault} without forwarding`,async t=>{
  const f=await fixture(t,{grant:fault!=='no-grant',clock:()=>Date.parse(fault==='expired'?'2026-10-05T10:00:00Z':'2026-10-04T10:00:00Z')});await f.assign();const revision=(await f.service.read(f.scope)).revision,thread=f.threads.get('executor-original-a');
  if(fault==='busy')thread.session.activeTurnId='actual-active-turn';
  if(fault==='model-changed')thread.modelSelection.model='different';
  if(fault==='workspace-changed')thread.worktreePath=resolve(f.temp,'another-tree');
  if(fault==='native-changed')thread.nativeSessionObservation.nativeId='another-native';
  if(fault==='environment-changed')f.setEnvironment('different-env');
  await assert.rejects(f.act('c','dispatch',{taskId:'task-a'},{expectedRevision:revision}));assert.equal(f.commands.length,0);
});

test('fixed original T3 ThreadTurnStartCommand accepts exact dispatch and rejects old message.id', {skip:!originalSchema}, async t=>{
  const f=await fixture(t);await f.assign();const result=await f.act('c','dispatch',{taskId:'task-a'});
  assert.equal(result.status,'accepted');const command=f.commands[0];assert.ok(command);
  assert.equal(originalSchema.validate(command).message.messageId,command.message.messageId);
  const wrong=structuredClone(command);wrong.message.id=wrong.message.messageId;delete wrong.message.messageId;
  assert.throws(()=>originalSchema.validate(wrong),/messageId/);
});

const followup={taskId:'b-t001-title-update',ownerActorId:'b',title:'T001标题续改',instructions:'把“检查网页草稿”改成“检查刷新后草稿保持”，保留T001 ID、用户已改状态和其他任务。'};

test('follow-up waits for actual completed summary/read, refuses duplicate IDs and preserves first batch immutable sources',async t=>{
  const f=await fixture(t);await f.assign();
  await assert.rejects(f.act('c','assign',{tasks:[followup]}),/board_store_rejected/);
  for(const actor of ['a','b']){await f.act(actor,'read');await f.act(actor,'start',{taskId:'task-'+actor});await f.act(actor,'report',{taskId:'task-'+actor,text:'原实际回报'+actor});}
  await f.act('c','read');let board=await f.service.read(f.scope);
  const firstRequest={operationId:'first-summary',expectedRevision:board.revision};
  const first=await f.act('c','summary',{text:'第一批实际汇总',reportEventIds:board.tasks.map(x=>x.report.eventId)},firstRequest);
  await assert.rejects(f.act('c','assign',{tasks:[followup]}),/board_store_rejected/);
  await f.act('c','read');board=await f.service.read(f.scope);const priorTasks=structuredClone(board.tasks),priorRelations=structuredClone(board.relations);
  await assert.rejects(f.act('c','assign',{tasks:[{...followup,taskId:'task-b'}]}),/board_store_rejected/);
  assert.deepEqual((await f.service.read(f.scope)).tasks,priorTasks);
  await f.act('c','assign',{tasks:[followup]});
  board=await f.service.read(f.scope);assert.equal(board.status,'in_progress');assert.equal(board.summary,null);assert.equal(board.summaryHistory,undefined);
  assert.deepEqual(board.tasks.slice(0,2),priorTasks);assert.deepEqual(board.relations.slice(0,4),priorRelations);
  await assert.rejects(f.act('a','start',{taskId:followup.taskId}),/board_store_rejected/);
  await f.act('b','read');await f.act('b','start',{taskId:followup.taskId});await f.act('b','report',{taskId:followup.taskId,text:'同原B已完成精确续改'});
  await f.act('c','read');board=await f.service.read(f.scope);
  await f.act('c','summary',{text:'两批实际汇总',reportEventIds:board.tasks.map(x=>x.report.eventId)});
  board=await f.service.read(f.scope);assert.equal(board.status,'summarized');assert.equal(board.relations.length,6);
  assert.deepEqual(board.relations.filter(x=>x.taskId===followup.taskId).map(x=>[x.sourceThreadId,x.targetThreadId]),[['coordinator-original','executor-original-b'],['executor-original-b','coordinator-original']]);
  assert.deepEqual(await f.act('c','summary',{text:'第一批实际汇总',reportEventIds:priorTasks.map(x=>x.report.eventId)},firstRequest),first);
});

test('explicit three-dispatch grant permits same B follow-up without replacing original SID or replaying old dispatch',async t=>{
  const f=await fixture(t,{dispatchLimit:3});await f.assign();
  await f.act('c','dispatch',{taskId:'task-a'},{operationId:'dispatch-a'});
  await f.act('c','dispatch',{taskId:'task-b'},{operationId:'dispatch-b'});
  for(const actor of ['a','b']){await f.act(actor,'read');await f.act(actor,'start',{taskId:'task-'+actor});await f.act(actor,'report',{taskId:'task-'+actor,text:'实际回报'+actor});}
  await f.act('c','read');let board=await f.service.read(f.scope);
  await f.act('c','summary',{text:'首轮汇总',reportEventIds:board.tasks.map(x=>x.report.eventId)});
  await f.act('c','read');await f.act('c','assign',{tasks:[followup]});await f.act('c','read');
  const result=await f.act('c','dispatch',{taskId:followup.taskId},{operationId:'dispatch-b-followup'});
  assert.equal(result.status,'accepted');assert.equal(f.commands.length,3);
  assert.equal(f.commands[1].threadId,f.commands[2].threadId);assert.notEqual(f.commands[1].commandId,f.commands[2].commandId);
  assert.match(f.commands[2].message.text,/检查刷新后草稿保持/);
  assert.equal((await f.service.read(f.scope)).participants.find(x=>x.actorId==='b').nativeThreadId,'original-native-2');
  assert.equal((await f.act('c','dispatch',{taskId:'task-b'},{operationId:'dispatch-b'})).status,'accepted');assert.equal(f.commands.length,3);
});

test('follow-up cannot enlarge original two-dispatch authorization',async t=>{
  const f=await fixture(t);await f.assign();
  for(const actor of ['a','b'])await f.act('c','dispatch',{taskId:'task-'+actor},{operationId:'dispatch-'+actor});
  for(const actor of ['a','b']){await f.act(actor,'read');await f.act(actor,'start',{taskId:'task-'+actor});await f.act(actor,'report',{taskId:'task-'+actor,text:'实际回报'+actor});}
  await f.act('c','read');let board=await f.service.read(f.scope);await f.act('c','summary',{text:'汇总',reportEventIds:board.tasks.map(x=>x.report.eventId)});
  await f.act('c','read');await f.act('c','assign',{tasks:[followup]});await f.act('c','read');
  await assert.rejects(f.act('c','dispatch',{taskId:followup.taskId}),/dispatch_limit_or_task_state/);assert.equal(f.commands.length,2);
});
