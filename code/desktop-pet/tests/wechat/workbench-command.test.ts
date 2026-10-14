import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {WorkbenchChannelCommandPort,WorkbenchContinuationDraft,WorkbenchCommandResult,WorkbenchInput,WorkbenchTaskRef} from '../../contracts/workbench.js';
import {WeChatStore} from '../../wechat/store.js';
import {WorkbenchQuery} from '../../wechat/workbench-query.js';
import {WeChatWorkbenchCommand} from '../../wechat/workbench-command.js';
import {SqliteWorkbenchStore} from '../../app/workbench-store.js';
import {WorkbenchService,type T3WorkbenchClient} from '../../app/workbench-service.js';
import type {ProjectEntry,ProjectIndexPort} from '../../contracts/projects.js';

const signal=new AbortController().signal;
type Task=Extract<WorkbenchTaskRef,{origin:'t3'}>;
async function fixture(t:TestContext){
 const parent=resolve('../../artifacts/W2/workbench-54/tmp');await mkdir(parent,{recursive:true});
 const root=await mkdtemp(join(await realpath(parent),'command-')),file=join(root,'channel.sqlite');
 let store=new WeChatStore(file);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const task:Task={id:randomUUID(),projectId:'project-a',provider:'codex',origin:'t3',environmentId:'env',t3ProjectId:'native-project',threadId:'native-thread',providerInstanceId:'instance'};
 const drafts=new Map<string,WorkbenchContinuationDraft>(),byMessage=new Map<string,string>();
 const claimed=new Set<string>();let confirms=0,reads=0,phase:'running'|'waiting_approval'='running',unknown=false,readFailure=false;
 const port:WorkbenchChannelCommandPort={
  async listTasks(){return {tasks:[]};},
  async refreshTask(id){if(id!==task.id)throw Error('other task');return {task,projection:{taskId:id,sequence:1,eventId:'event-1',phase}};},
  async prepareContinuation(id,input){assert.equal(id,task.id);const prior=byMessage.get(input.origin.channelSessionId+':'+input.origin.messageId);
   if(prior){const draft=drafts.get(prior)!;assert.equal(draft.input.rawText,input.rawText);return draft;}
   const draft:WorkbenchContinuationDraft={id:randomUUID(),version:1,state:'open',commandId:randomUUID(),task,input};
   drafts.set(draft.id,draft);byMessage.set(input.origin.channelSessionId+':'+input.origin.messageId,draft.id);return draft;},
  readContinuationDraft(id,channel,session){const draft=drafts.get(id);
   if(!draft||channel!=='wechat'||session!==draft.input.origin.channelSessionId)throw Error('wrong channel');
   return draft;},
  reviseContinuation(id,version,channel,session,body){const old=drafts.get(id)!;assert.equal(channel,'wechat');assert.equal(session,old.input.origin.channelSessionId);
   if(old.version!==version)throw Error('stale');const next={...old,version:version+1,input:{...old.input,dispatchText:body}};drafts.set(id,next);return next;},
  dismissContinuation(id,version,channel,session){const old=drafts.get(id)!;assert.equal(channel,'wechat');assert.equal(session,old.input.origin.channelSessionId);
   if(old.version!==version||old.state!=='open')throw Error('stale or claimed');
   const next:WorkbenchContinuationDraft={...old,version:version+1,state:'dismissed'};drafts.set(id,next);return next;},
  async confirmContinuation(id,version,channel,session){const draft=drafts.get(id)!;assert.equal(channel,'wechat');assert.equal(session,draft.input.origin.channelSessionId);
   if(draft.version!==version||draft.state==='dismissed')throw Error('stale or dismissed');if(!claimed.has(id)){claimed.add(id);confirms++;drafts.set(id,{...draft,state:'claimed'});}
   return {commandId:draft.commandId,state:unknown?'unknown':'accepted',task} as WorkbenchCommandResult;},
  async readContinuation(id,channel,session){reads++;if(readFailure)throw Error('synthetic read outage');const draft=drafts.get(id);if(!draft||channel!=='wechat'||session!==draft.input.origin.channelSessionId)throw Error('wrong channel');
   return {commandId:draft.commandId,state:claimed.has(id)?unknown?'unknown':'accepted':'recorded',task} as WorkbenchCommandResult;},
 };
 const key='channel-a',make=(channel=key)=>{const query=new WorkbenchQuery({read:port,store,channelKey:channel});
  return {query,command:new WeChatWorkbenchCommand({port,store,channelKey:channel,focusTask:()=>query.focusTask(),selectTask:task=>query.selectTask(task)})};};
 return {root,file,task,port,drafts,make,get store(){return store;},reopen(){store.close();store=new WeChatStore(file);},
  setPhase(value:'running'|'waiting_approval'){phase=value;},setUnknown(value:boolean){unknown=value;},setReadFailure(value:boolean){readFailure=value;},confirms:()=>confirms,reads:()=>reads};
}
async function deliver(command:WeChatWorkbenchCommand,text:string,messageId=randomUUID(),accepted=true,oldPending=false){
 const result=await command.handle({text,messageId},signal,oldPending);assert.equal(result.handled,true);
 if(!result.handled)return '';
 if(result.text&&result.current())result.onDelivered?.(accepted);
 return result.text??'';
}

test('reviewed continuation preserves original voice text, CAS version and one stable confirmed command',async t=>{
 const f=await fixture(t),{command}=f.make(),messageId=randomUUID(),raw='继续任务 '+f.task.id+'：第一版正文';
 const first=await deliver(command,raw,messageId);assert.match(first,/原话：继续任务/);assert.match(first,/将发送：第一版正文/);
 const draft=[...f.drafts.values()][0]!;assert.equal(draft.input.rawText,raw);assert.equal(draft.input.dispatchText,'第一版正文');
 assert.equal(draft.input.origin.messageId,messageId);assert.equal(draft.input.origin.channelSessionId,'channel-a');
 const revised=await deliver(command,'修改续接：第二版正文',randomUUID(),false);assert.match(revised,/版本 2/);
 assert.equal(f.drafts.get(draft.id)!.input.rawText,raw);assert.equal(f.drafts.get(draft.id)!.input.dispatchText,'第二版正文');
 assert.match(await deliver(command,'确认'),/尚未确认送达/);assert.equal(f.confirms(),0);
 await deliver(command,'修改续接：最终正文');const final=f.drafts.get(draft.id)!;assert.equal(final.version,3);
 const confirmed=await deliver(command,'确认');assert.match(confirmed,/已接收/);assert.equal(f.confirms(),1);
 assert.equal(f.drafts.get(draft.id)!.commandId,draft.commandId);assert.equal(f.drafts.get(draft.id)!.input.rawText,raw);
 assert.match(await deliver(command,'确认'),/已接收/);assert.equal(f.confirms(),1);assert.ok(f.reads()>0);
 const history=await command.history(signal);assert.equal(history.length,1);assert.match(history[0]!,new RegExp(draft.commandId));
});

test('unknown confirmation and cold SQLite reopen only read the original command; other channel has no focus or history',async t=>{
 const f=await fixture(t);f.setUnknown(true);let {command}=f.make();
 await deliver(command,'续接任务 '+f.task.id+'：语音转写正文');
 assert.match(await deliver(command,'确认续接'),/结果待核/);assert.equal(f.confirms(),1);
 f.reopen();({command}=f.make());
 assert.match(await deliver(command,'确认'),/结果待核/);assert.equal(f.confirms(),1);
 assert.equal((await command.history(signal)).length,1);
 const other=f.make('channel-b');assert.equal((await other.query.handle('查询任务',signal)).handled,false);
 assert.deepEqual(await other.command.history(signal),[]);
 assert.equal((await other.command.handle({text:'确认',messageId:randomUUID()},signal,false)).handled,false);
 f.setUnknown(false);assert.match(await deliver(command,'查询续接'),/已接收/);assert.equal(f.confirms(),1);
});

test('readback outage retains pending command without calling confirm again; later all-history recovers the claim',async t=>{
 const f=await fixture(t),{command}=f.make();
 await deliver(command,'继续任务 '+f.task.id+'：等回执');f.setReadFailure(true);
 assert.match(await deliver(command,'确认'),/回执待核/);assert.equal(f.confirms(),1);
 assert.deepEqual(await command.history(signal),[]);
 f.reopen();const reopened=f.make().command;
 assert.match(await deliver(reopened,'确认'),/回执待核/);assert.equal(f.confirms(),1);
 f.setReadFailure(false);
 assert.equal((await reopened.history(signal)).length,1);assert.equal(f.confirms(),1);
});

test('plain confirmation requires the one shown card and refuses old-card or native approval ambiguity',async t=>{
 const f=await fixture(t),{command}=f.make();
 const raw='继续任务 '+f.task.id+'：只发一次';
 await deliver(command,raw,randomUUID(),false);
 assert.match(await deliver(command,'确认'),/尚未确认送达/);assert.equal(f.confirms(),0);
 await deliver(command,'修改续接：已展示正文');
 assert.match(await deliver(command,'确认',randomUUID(),true,true),/另一张待确认/);assert.equal(f.confirms(),0);
 f.setPhase('waiting_approval');assert.match(await deliver(command,'确认'),/不会代为批准工具/);assert.equal(f.confirms(),0);
 assert.match(await deliver(command,'确认续接'),/已接收/);assert.equal(f.confirms(),1);
 assert.match(await deliver(command,'取消续接'),/不能把它当作已取消执行/);assert.equal(f.confirms(),1);
});

test('unsubmitted cancellation clears only this channel card; late preparation cannot replace a newer turn',async t=>{
 const f=await fixture(t),{command}=f.make();
 await deliver(command,'继续任务 '+f.task.id+'：待放弃');
 assert.match(await deliver(command,'取消续接'),/已取消这张未发送/);assert.equal(f.confirms(),0);
 assert.equal([...f.drafts.values()][0]?.state,'dismissed');
 assert.equal((await command.history(signal)).length,0);
 const old=await command.handle({text:'确认',messageId:randomUUID()},signal,false);assert.equal(old.handled,false);
 let release!:(draft:WorkbenchContinuationDraft)=>void,started!:()=>void;
 const begin=new Promise<void>(resolve=>{started=resolve;}),original=f.port.prepareContinuation;
 f.port.prepareContinuation=async(id,input:WorkbenchInput)=>{started();return new Promise<WorkbenchContinuationDraft>(resolve=>{release=resolve;});};
 const slow=command.handle({text:'继续任务 '+f.task.id+'：迟到',messageId:randomUUID()},signal,false);await begin;
 await command.handle({text:'查询',messageId:randomUUID()},signal,false);
 const input:WorkbenchInput={inputId:'late',origin:{channel:'wechat',channelSessionId:'channel-a',messageId:'late'},rawText:'迟到',dispatchText:'迟到',createdAt:new Date().toISOString()};
 release(await original(f.task.id,input));const delayed=await slow;
 if(delayed.handled)assert.equal(delayed.text,undefined);
 assert.equal((await command.history(signal)).length,0);assert.equal(f.confirms(),0);
});

/** Exercises the public 0.1.6 service and its durable SQLite claim, not a mock command result. */
async function realService(t:TestContext,enabled:boolean){
 const parent=resolve('../../artifacts/W2/workbench-54/tmp');await mkdir(parent,{recursive:true});
 const root=await mkdtemp(join(await realpath(parent),'real-command-'));
 const project:ProjectEntry={id:'logical-project',name:'Project',abstract:'',detailRef:{rootPath:root},version:1,updatedAt:'2026-09-27T00:00:00.000Z'};
 const projects:ProjectIndexPort={async get(id){return id===project.id?project:null;},async list(){return {items:[project],total:1,offset:0,limit:1};},
  async save(){throw Error('unexpected save');},async remove(){throw Error('unexpected remove');},async close(){}};
 const receipts=new Map<string,{status:'accepted';aggregateKind:'thread';aggregateId:string;resultSequence:number}>();
 let sends=0,receiptVisible=true;
 const native:T3WorkbenchClient={
  async environmentDescriptor(){return {environmentId:'native-environment'};},
  async shellSnapshot(){return {snapshotSequence:8,updatedAt:'2026-09-27T00:00:00.000Z',
   projects:[{id:'native-project',workspaceRoot:root}],threads:[{id:'native-thread',projectId:'native-project',
    modelSelection:{instanceId:'codex'},runtimeMode:'approval-required',interactionMode:'plan',
    latestTurn:null,hasPendingApprovals:false,hasPendingUserInput:false}]};},
  async threadSnapshot(){return {thread:{id:'native-thread',projectId:'native-project',
   modelSelection:{instanceId:'codex'},runtimeMode:'approval-required',interactionMode:'plan'}};},
  async dispatch(command){sends++;assert.equal(command.type,'thread.turn.start');
   assert.equal(command.runtimeMode,'approval-required');assert.equal(command.interactionMode,'plan');
   if(receiptVisible)receipts.set(command.commandId,{status:'accepted',aggregateKind:'thread',aggregateId:'native-thread',resultSequence:9});
   throw Error('synthetic lost dispatch reply');},
  async readReceipt(commandId){return receipts.get(commandId)??null;},
 };
 const ledgerFile=join(root,'workbench.sqlite'),channelFile=join(root,'channel.sqlite');
 let ledger=new SqliteWorkbenchStore(ledgerFile),channel=new WeChatStore(channelFile);
 ledger.bindProject(project,'native-environment',{id:'native-project',workspaceRoot:root},root);
 let service=new WorkbenchService(projects,ledger,native,enabled);
 const task=await service.bindTask(project.id,'native-project','native-thread','codex');
 const open=(channelKey='channel-a')=>{const query=new WorkbenchQuery({read:service,store:channel,channelKey});
  return {query,command:new WeChatWorkbenchCommand({port:service,store:channel,channelKey,
   focusTask:()=>query.focusTask(),selectTask:task=>query.selectTask(task)})};};
 t.after(async()=>{ledger.close();channel.close();await rm(root,{recursive:true,force:true});});
 return {task,open,receipts,sends:()=>sends,setReceiptVisible(value:boolean){receiptVisible=value;},
  currentDraft(){const state=channel.get<{current?:{draftId:string;version:number};history:unknown[]}>('workbench-continuation:channel-a');
   assert.ok(state?.current);return ledger.getContinuation(state.current.draftId,'wechat','channel-a');},
  simulateCrashBeforeServerClaim(){const key='workbench-continuation:channel-a';
   const state=channel.get<{current?:{phase:string;[key:string]:unknown};history:unknown[]}>(key);
   assert.ok(state?.current);channel.set(key,{...state,current:{...state.current,phase:'checking'}});},
  reopen(){ledger.close();channel.close();ledger=new SqliteWorkbenchStore(ledgerFile);channel=new WeChatStore(channelFile);
   service=new WorkbenchService(projects,ledger,native,enabled);}};
}

test('real 0.1.6 service with dispatch off keeps open draft out of submitted history and permits only public dismissal',async t=>{
 const f=await realService(t,false),{command}=f.open();
 assert.match(await deliver(command,'继续任务 模糊标题：正文'),/准确任务ID/);
 assert.equal(f.sends(),0);
 await deliver(command,'继续任务 '+f.task.id+'：原始请求');
 assert.match(await deliver(command,'确认'),/当前不可派发/);
 assert.equal(f.sends(),0);assert.deepEqual(await command.history(signal),[]);
 assert.match(await deliver(command,'查询续接'),/仍待确认/);
 assert.match(await deliver(command,'取消续接'),/已取消这张未发送/);
 assert.deepEqual(await command.history(signal),[]);
 f.reopen();const reopened=f.open();
 assert.equal((await reopened.command.handle({text:'确认',messageId:randomUUID()},signal,false)).handled,false);
 assert.deepEqual(await reopened.command.history(signal),[]);
});

test('real 0.1.6 claimed command survives lost reply and SQLite reopen without a second dispatch',async t=>{
 const f=await realService(t,true);f.setReceiptVisible(false);
 let {command}=f.open();await deliver(command,'继续任务 '+f.task.id+'：一次派发');
 assert.match(await deliver(command,'确认'),/结果待核/);assert.equal(f.sends(),1);
 assert.equal((await command.history(signal)).length,1);
 assert.match(await deliver(command,'取消续接'),/不能把它当作已取消执行/);
 f.reopen();({command}=f.open());
 assert.match(await deliver(command,'确认续接'),/结果待核/);assert.equal(f.sends(),1);
 assert.equal((await command.history(signal)).length,1);
 const latest=await f.open().query.handle('查询任务结果',signal,'latest');
 assert.equal(latest.handled,true);if(latest.handled)assert.match(latest.text??'',new RegExp(f.task.id));
 const other=f.open('channel-b');assert.deepEqual(await other.command.history(signal),[]);
 const claim=f.receipts.keys().next().value;
 assert.equal(claim,undefined,'no native receipt was visible yet');
});

test('crash before public claim cold-recovers the exact open draft for re-display, then requires a fresh confirm',async t=>{
 const f=await realService(t,true);let {command}=f.open();
 const original='继续任务 '+f.task.id+'：崩溃前的原话';
 await deliver(command,original);f.simulateCrashBeforeServerClaim();f.reopen();({command}=f.open());
 assert.equal(f.currentDraft().state,'open');assert.equal(f.currentDraft().version,1);
 assert.equal(f.currentDraft().input.rawText,original);
 const recovered=await deliver(command,'确认',randomUUID(),false);
 assert.match(recovered,/原话：.*崩溃前的原话/);assert.match(recovered,/将发送：崩溃前的原话/);
 assert.equal(f.sends(),0);assert.deepEqual(await command.history(signal),[]);
 assert.match(await deliver(command,'确认'),/尚未确认送达/);assert.equal(f.sends(),0);
 assert.match(await deliver(command,'确认'),/已接收/);assert.equal(f.sends(),1);
 assert.match(await deliver(command,'确认'),/已接收/);assert.equal(f.sends(),1);
});

test('crash before public claim can cancel the still-open draft without marking a sent task',async t=>{
 const f=await realService(t,true);let {command}=f.open();
 await deliver(command,'继续任务 '+f.task.id+'：只取消');f.simulateCrashBeforeServerClaim();f.reopen();({command}=f.open());
 assert.match(await deliver(command,'取消续接'),/已取消这张未发送/);
 assert.equal(f.sends(),0);assert.deepEqual(await command.history(signal),[]);
 assert.equal((await command.handle({text:'确认',messageId:randomUUID()},signal,false)).handled,false);
});
