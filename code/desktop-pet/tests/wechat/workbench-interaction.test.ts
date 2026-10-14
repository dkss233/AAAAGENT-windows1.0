import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,realpathSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WeChatStore } from '../../wechat/store.js';
import { WeChatWorkbenchInteraction,nativeInteractionPort } from '../../wechat/workbench-interaction.js';
import type { WeChatInput } from '../../wechat/service.js';
import type { WorkbenchInteraction,WorkbenchInteractionResponse,WorkbenchInteractionBindingSummary,WorkbenchInteractionCommandRead,WorkbenchTaskRef,WorkbenchNativeInteractionPort } from '../../contracts/workbench.js';
import { WorkbenchService,type T3WorkbenchClient } from '../../app/workbench-service.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import type { ProjectEntry,ProjectIndexPort } from '../../contracts/projects.js';
const signal=new AbortController().signal;
type Task=Extract<WorkbenchTaskRef,{origin:'t3'}>;
const makeTask=():Task=>({id:randomUUID(),projectId:randomUUID(),origin:'t3',provider:'codex',environmentId:'synthetic-env',t3ProjectId:'native-project',threadId:'native-thread',providerInstanceId:'codex'});
const approval=(task:Task):WorkbenchInteraction=>({id:randomUUID(),taskId:task.id,kind:'approval',version:7,state:'pending',nativeRequestId:'native-approval',answerLifetime:'durable',summary:'Execute synthetic action?',choiceSource:'provider',choices:[{id:'allow-once',label:'允许一次',warning:'会执行受控操作'},{id:'deny',label:'拒绝'},{id:'cancel-turn',label:'取消本轮'}]});
const question=(task:Task):WorkbenchInteraction=>({id:randomUUID(),taskId:task.id,kind:'question',version:9,state:'pending',nativeRequestId:'native-question',answerLifetime:'durable',questions:[{id:'q1',prompt:'选择范围',allowMultiple:true,allowCustomAnswer:false,options:[{id:'a',label:'甲',description:'第一项'},{id:'b',label:'乙'}]},{id:'q2',prompt:'附加说明',allowMultiple:false,allowCustomAnswer:true,options:[{id:'none',label:'无'}]}]});
function root(t:TestContext){const parent=resolve('../../artifacts/W3/wechat-native-interactions-54/tmp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(join(realpathSync(parent),'native-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function fixture(t:TestContext){
 const dir=root(t),filename=join(dir,'channel.sqlite');let store=new WeChatStore(filename);
 const task=makeTask();let focus:Task|undefined=task,listedTask:WorkbenchTaskRef=task,status:'supported'|'unsupported'|'unverified'='supported';
 let requests:WorkbenchInteraction[]=[approval(task)],bindings:WorkbenchInteractionBindingSummary[]=[],reads=0,loss=false,listError=false;
 let beforeList:(()=>Promise<void>)|undefined,beforeBindings:(()=>Promise<void>)|undefined;
 let resolution:WorkbenchInteractionCommandRead['resolution']='pending',readTask:WorkbenchTaskRef=task,disabled=false;
 const calls:WorkbenchInteractionResponse[]=[],order:string[]=[];
 const port:WorkbenchNativeInteractionPort={
  async listNativeInteractions(p,id){order.push('list');assert.equal(p,task.projectId);assert.equal(id,task.id);await beforeList?.();if(listError)throw Error('synthetic unavailable');return {task:listedTask,status,interactions:requests};},
  async listNativeInteractionBindings(p,id){order.push('bindings');assert.equal(p,task.projectId);assert.equal(id,task.id);await beforeBindings?.();return {task:listedTask,status:'supported',bindings};},
  async respondNativeInteraction(p,id,r,v,response){order.push('respond');assert.equal(p,task.projectId);assert.equal(id,task.id);calls.push(response);
   if(disabled)return {command:{task,commandId:r,state:'unsupported',detail:'原生请求派发尚未启用。'},resolution:'unknown'};
   const request=requests.find(x=>x.id===r)!;assert.equal(request.version,v);const b={interactionId:r,commandId:randomUUID(),kind:request.kind,requestVersion:v};bindings.push(b);
   if(loss)throw Error('synthetic lost reply');return {command:{task,commandId:b.commandId,state:'accepted'},resolution};},
  async readNativeInteractionCommand(){throw Error('must use exact task locator');},
  async readNativeInteractionCommandForTask(p,id,r){order.push('read');reads++;assert.equal(p,task.projectId);assert.equal(id,task.id);return {command:{task:readTask,commandId:bindings.find(b=>b.interactionId===r)!.commandId,state:'accepted'},resolution};}
 };
 const build=(channel='channel-a',selectedPort:WorkbenchNativeInteractionPort|undefined=port)=>new WeChatWorkbenchInteraction({port:selectedPort,store,channelKey:channel,focusTask:()=>focus});
 let handler=build();t.after(()=>store.close());
 const send=(text:string,extra:Partial<WeChatInput>={})=>handler.handle({text,messageId:randomUUID(),...extra},signal);
 const show=async(accepted=true)=>{const result=await send('查询原生请求');assert.equal(result.handled,true);if(result.handled)result.onDelivered?.(accepted);return result;};
 const reply=(r=requests[0]!,body='选项 1')=>`${r.kind==='approval'?'回应':'回答'}原生请求 ${r.id} v${r.version}：${body}`;
 return {dir,filename,task,port,calls,order,build,send,show,reply,get store(){return store;},get handler(){return handler;},get requests(){return requests;},get bindings(){return bindings;},get reads(){return reads;},
  setRequests:(r:WorkbenchInteraction[])=>{requests=r;},setFocus:(v:Task|undefined)=>{focus=v;},setListedTask:(v:WorkbenchTaskRef)=>{listedTask=v;},setStatus:(v:typeof status)=>{status=v;},setLoss:()=>{loss=true;},setListError:()=>{listError=true;},setReadTask:(v:WorkbenchTaskRef)=>{readTask=v;},setResolution:(v:typeof resolution)=>{resolution=v;},setDisabled:()=>{disabled=true;},setBeforeList:(v:()=>Promise<void>)=>{beforeList=v;},setBeforeBindings:(v:()=>Promise<void>)=>{beforeBindings=v;},
  reopen:()=>{store.close();store=new WeChatStore(filename);handler=build();}};
}
function text(result:Awaited<ReturnType<WeChatWorkbenchInteraction['handle']>>){assert.equal(result.handled,true);return result.handled?result.text??'':'';}
test('full card contains every native option and warning; explicit denial maps exactly with acceptance separate from resolution',async t=>{
 const f=fixture(t),shown=await f.show();assert.match(text(shown),/允许一次/);assert.match(text(shown),/拒绝/);assert.match(text(shown),/取消本轮/);assert.match(text(shown),/会执行受控操作/);
 assert.match(text(await f.send(f.reply(undefined,'选项 2'))),/已接收；原生请求仍在等待处理/);assert.deepEqual(f.calls,[{type:'decide_approval',choiceId:'deny'}]);assert.ok(f.order.indexOf('bindings')<f.order.indexOf('respond'));
 await f.send(f.reply());assert.equal(f.calls.length,1);assert.equal(f.reads,1,'even a different answer only reads original command');
 f.setResolution('answered');assert.match(text(await f.send(`查询原生回执 ${f.requests[0]!.id} v7`)),/原生请求已解决/);
 const metadata=JSON.stringify(f.store.get('workbench-native:channel-a'));assert.ok(!metadata.includes('Execute synthetic'));assert.ok(!metadata.includes('deny'));assert.ok(!metadata.includes('会执行'));
});
test('undelivered, wrong-channel, pre-card timestamp and batch-empty snapshots cannot authorize replies',async t=>{
 const f=fixture(t),empty=f.handler.capture();await f.show(false);assert.match(text(await f.send(f.reply())),/此前已送达/);await f.show();
 await f.send(f.reply(),{nativeInteractionCapture:empty});await f.send(f.reply(),{createdAt:1});
 const foreign={...f.handler.capture(),channel:'channel-b'};await f.send(f.reply(),{nativeInteractionCapture:foreign});
 const other=f.build('channel-b');assert.match(text(await other.handle({text:f.reply(),messageId:randomUUID(),nativeInteractionCapture:f.handler.capture()},signal)),/此前已送达/);
 assert.equal(f.calls.length,0);
 await f.send(f.reply());assert.equal(f.calls.length,1);
});
test('exact task identity, version, kind and same-version option drift reject stale cards',async t=>{
 const f=fixture(t);await f.show();const original=f.requests[0]!;
 f.setRequests([{...original,version:8}]);await f.send(f.reply(original));
 f.setRequests([{...original,summary:'changed'} as WorkbenchInteraction]);await f.send(f.reply(original));
 f.setRequests([original]);await f.send(f.reply(original).replace('回应','回答'));
 f.setListedTask({...f.task,nativeSessionId:'different-session'});await f.send(f.reply(original));assert.equal(f.calls.length,0);
});
test('focus change during a read or late delivery suppresses both submission and persisted card',async t=>{
 const f=fixture(t);const card=await f.send('查询原生请求');f.setFocus({...f.task,threadId:'other'});if(card.handled)card.onDelivered?.(true);assert.equal(f.handler.capture().cards.length,0);
 f.setFocus(f.task);await f.show();f.setBeforeBindings(async()=>{f.setFocus({...f.task,providerInstanceId:'other'});});const result=await f.send(f.reply());assert.equal(text(result),'');assert.equal(f.calls.length,0);
});
test('multiple requests and bare confirms clarify without choosing; ordinary chat and explicit continuation are left alone',async t=>{
 const f=fixture(t);f.setRequests([f.requests[0]!,question(f.task)]);assert.match(text(await f.show()),/选择范围/);
 for(const word of ['确认','批准','拒绝','允许','同意','选项 1'])assert.match(text(await f.send(word)),/请明确/);
 for(const word of ['确认续接','取消续接','聊天今天开心'])assert.equal((await f.send(word)).handled,false);
 f.setRequests([]);assert.match(text(await f.send('确认')),/请明确/,'a disappeared native request must not redirect an old confirmation to dispatch');
 assert.equal(f.calls.length,0);
});
test('all question answers, multiple selections and custom text map without changing user text',async t=>{
 const f=fixture(t),q=question(f.task);f.setRequests([q]);assert.match(text(await f.show()),/第一项/);
 for(const body of ['1：选项 1','1：选项 1\n1：选项 2','1：选项 1,1\n2：自填：test','1：自填：forbidden\n2：选项 1','1：选项 3\n2：选项 1','1：选项 1\n2：自填：'])await f.send(f.reply(q,body));
 assert.equal(f.calls.length,0);
 const custom='ＡＢＣ  保留原文';await f.send(f.reply(q,`2：自填：${custom}\n1：选项 2,1`));
 assert.deepEqual(f.calls,[{type:'answer_question',answers:[{questionId:'q2',selectedOptionIds:[],customText:custom},{questionId:'q1',selectedOptionIds:['b','a']}]}]);assert.ok(!JSON.stringify(f.store.get('workbench-native:channel-a')).includes(custom));
});
test('first POST reply loss survives SQLite reopen and recovers original command even when current card fetch fails',async t=>{
 const f=fixture(t);await f.show();f.setLoss();assert.match(text(await f.send(f.reply())),/暂不可确认/);assert.equal(f.calls.length,1);
 const id=f.bindings[0]!.commandId;f.reopen();f.setListError();assert.match(text(await f.send(f.reply())),new RegExp(id));assert.equal(f.calls.length,1);assert.equal(f.reads,1);
});
test('claimed local attempt without server binding stays unknown after reopen, never replays',async t=>{
 const f=fixture(t);await f.show();f.setLoss();await f.send(f.reply());f.bindings.splice(0);f.reopen();assert.match(text(await f.send(f.reply())),/不会再次提交/);assert.equal(f.calls.length,1);
});
test('server binding survives missing local attempt; mismatched binding or receipt cannot be accepted',async t=>{
 const f=fixture(t);await f.show();await f.send(f.reply());f.store.delete('workbench-native:channel-a');f.reopen();assert.match(text(await f.send(f.reply())),/已接收/);assert.equal(f.calls.length,1);
 f.bindings[0]={...f.bindings[0]!,requestVersion:8};assert.match(text(await f.send(f.reply())),/身份或版本不符/);f.bindings[0]={...f.bindings[0]!,requestVersion:7};
 f.setReadTask({...f.task,threadId:'foreign-thread'});assert.match(text(await f.send(f.reply())),/身份或版本不符/);assert.equal(f.calls.length,1);
});
test('message ID claim prevents reusing an inbound message for a second native request',async t=>{
 const f=fixture(t),second=approval(f.task);f.setRequests([f.requests[0]!,second]);await f.show();await f.send(f.reply(),{messageId:'duplicate'});await f.send(f.reply(second),{messageId:'duplicate'});assert.equal(f.calls.length,1);
});
test('missing port, absent focus, DSH and unverified capability never submit',async t=>{
 const f=fixture(t);assert.equal(nativeInteractionPort({listNativeInteractions(){}}),undefined);
 const missing=new WeChatWorkbenchInteraction({port:undefined,store:f.store,channelKey:'a',focusTask:()=>f.task});assert.match(text(await missing.handle({text:'查询原生请求',messageId:'x'},signal)),/接口不可用/);
 f.setFocus(undefined);assert.match(text(await f.send('查询原生请求')),/请先/);f.setFocus({...f.task,provider:'dsh'});assert.match(text(await f.send('查询原生请求')),/不支持/);
 f.setFocus(f.task);f.setStatus('unverified');assert.match(text(await f.send('查询原生请求')),/尚未核实/);assert.equal(f.calls.length,0);
});
test('abort after respond keeps durable claim and suppresses late success',async t=>{
 const f=fixture(t);await f.show();const abort=new AbortController(),original=f.port.respondNativeInteraction;
 f.port.respondNativeInteraction=async(...args)=>{const result=await original(...args);abort.abort();return result;};
 const result=await f.handler.handle({text:f.reply(),messageId:'abort'},abort.signal);assert.equal(text(result),'');f.reopen();await f.send(f.reply());assert.equal(f.calls.length,1);
});
test('actual WorkbenchService and both SQLite stores: deterministic disabled reply admits only a fresh explicit message after enable, then cold-recovers lost receipt once',async t=>{
 const dir=root(t),at='2026-09-27T00:00:00.000Z',channelFile=join(dir,'channel.sqlite'),workbenchFile=join(dir,'workbench.sqlite');
 let channel=new WeChatStore(channelFile),workbench=new SqliteWorkbenchStore(workbenchFile);
 t.after(()=>{channel.close();workbench.close();});
 const project:ProjectEntry={id:randomUUID(),name:'Synthetic project',abstract:'',detailRef:{rootPath:dir},version:1,updatedAt:at};
 const projects:ProjectIndexPort={async get(id){return id===project.id?project:null;},async list(){throw Error('unused');},async save(){throw Error('unused');},async remove(){throw Error('unused');},async close(){}};
 const activity={id:'a',kind:'approval.requested',tone:'approval',summary:'Synthetic action',turnId:'turn-1',sequence:8,createdAt:at,payload:{requestId:'r',options:[{decision:'accept',label:'Allow once'},{decision:'decline',label:'Deny'}]}};
 let sends=0;const accepted=new Map<string,any>();
 const native:T3WorkbenchClient={async environmentDescriptor(){return {environmentId:'env'};},async shellSnapshot(){return {snapshotSequence:10,updatedAt:at,projects:[{id:'np',workspaceRoot:dir}],threads:[{id:'nt',projectId:'np',modelSelection:{instanceId:'codex'},latestTurn:{turnId:'turn-1',state:'running'},hasPendingApprovals:true}]};},async threadSnapshot(){return {thread:{id:'nt',projectId:'np',modelSelection:{instanceId:'codex'},session:{threadId:'nt',status:'running',activeTurnId:'turn-1'},activities:[activity]}};},async dispatch(command){sends++;accepted.set(command.commandId,{status:'accepted',aggregateKind:'thread',aggregateId:'nt',resultSequence:11});return {sequence:11};},async readReceipt(id){return accepted.get(id)??null;}};
 workbench.bindProject(project,'env',{id:'np',workspaceRoot:dir},dir);
 let service=new WorkbenchService(projects,workbench,native),task=await service.bindTask(project.id,'np','nt','codex');assert.equal(task.origin,'t3');
 const make=(key:string,port:WorkbenchNativeInteractionPort)=>new WeChatWorkbenchInteraction({port,store:channel,channelKey:key,focusTask:()=>task as Task});
 const show=async(h:WeChatWorkbenchInteraction)=>{const result=await h.handle({text:'查询原生请求',messageId:randomUUID()},signal);if(result.handled)result.onDelivered?.(true);};
 const request=(await service.listNativeInteractions(project.id,task.id)).interactions[0]!;
 const input={text:`回应原生请求 ${request.id} v${request.version}：选项 2`,messageId:'response'};
 const disabled=make('same-channel',service);await show(disabled);assert.match(text(await disabled.handle(input,signal)),/已确认这次没有提交/);assert.equal(sends,0);assert.equal(workbench.interactionLedger.listByTask(project.id,task.id).length,0);
 channel.close();channel=new WeChatStore(channelFile);
 service=new WorkbenchService(projects,workbench,native,true);
 // Inject a lost adapter receipt after the real local service has committed its command binding.
 const original=service.respondNativeInteraction.bind(service);service.respondNativeInteraction=async(...args)=>{await original(...args);throw Error('synthetic lost adapter receipt');};
 let handler=make('same-channel',service);await show(handler);assert.match(text(await handler.handle(input,signal)),/这条消息已处理/);assert.equal(sends,0,'old message ID cannot be reused after enable');
 assert.match(text(await handler.handle({...input,messageId:'fresh-explicit-reply'},signal)),/暂不可确认/);assert.equal(sends,1);
 const commandId=workbench.interactionLedger.listByTask(project.id,task.id)[0]!.commandId;
 channel.close();workbench.close();channel=new WeChatStore(channelFile);workbench=new SqliteWorkbenchStore(workbenchFile);service=new WorkbenchService(projects,workbench,native,true);handler=make('same-channel',service);
 assert.match(text(await handler.handle({...input,messageId:'after-restart'},signal)),new RegExp(commandId));assert.equal(sends,1);
});

test('unsupported cleanup requires exact zero-submission identity and a successful empty binding recheck; conflicts and unknown remain claimed',async t=>{
 for(const variant of ['conflict','unknown','wrong-command','wrong-task','wrong-detail','binding-exists','binding-unavailable','binding-task-drift','binding-read-fails'] as const){
  await t.test(variant,async t=>{
   const f=fixture(t);await f.show();f.setDisabled();const respond=f.port.respondNativeInteraction.bind(f.port),readBindings=f.port.listNativeInteractionBindings.bind(f.port);let checks=0;
   f.port.listNativeInteractionBindings=async(...args)=>{
    checks++;const result=await readBindings(...args);
    if(checks===2){
     if(variant==='binding-unavailable')return {...result,status:'unsupported'};
     if(variant==='binding-task-drift')return {...result,task:{...f.task,threadId:'other'}};
     if(variant==='binding-read-fails')throw Error('synthetic uncertain ledger');
    }
    return result;
   };
   f.port.respondNativeInteraction=async(...args)=>{
    const result=await respond(...args);
    if(variant==='conflict'||variant==='unknown')return {...result,command:{...result.command,state:variant}};
    if(variant==='wrong-detail')return {...result,command:{...result.command,detail:'Other unsupported path'}};
    if(variant==='wrong-command')return {...result,command:{...result.command,commandId:'not-zero-submit-placeholder'}};
    if(variant==='wrong-task')return {...result,command:{...result.command,task:{...f.task,threadId:'other'}}};
    if(variant==='binding-exists')f.bindings.push({interactionId:f.requests[0]!.id,commandId:'already-claimed',kind:'approval',requestVersion:7});
    return result;
   };
   await f.send(f.reply(),{messageId:'first'});f.reopen();await f.send(f.reply(),{messageId:'fresh'});assert.equal(f.calls.length,1,'uncertain or conflicting state must not issue another respond');
  });
 }
});
