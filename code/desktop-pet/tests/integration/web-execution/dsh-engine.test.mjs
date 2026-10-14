import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const source = resolve(process.env.DSH_WEB_SOURCE);
let engine;
before(async () => {
  const out = join(source, 'apps/server/dist/dsh-engine-test.mjs');
  const imports = [
    ['Adapter', 'apps/server/src/provider/Layers/DshAdapter.ts'],
    ['Pipeline', 'apps/server/src/orchestration/Layers/ProjectionPipeline.ts'],
    ['PipelineService', 'apps/server/src/orchestration/Services/ProjectionPipeline.ts'],
    ['EventStore', 'apps/server/src/persistence/Services/OrchestrationEventStore.ts'],
    ['EventStoreLayer', 'apps/server/src/persistence/Layers/OrchestrationEventStore.ts'],
    ['Sqlite', 'apps/server/src/persistence/Layers/Sqlite.ts'],
    ['Config', 'apps/server/src/config.ts'],
    ['Reducer', 'packages/client-runtime/src/state/threadReducer.ts'],
    ['Requests', 'packages/client-runtime/src/pendingRequests.ts'],
    ['History', 'apps/server/src/orchestration/NativeSessionHistory.ts'],
    ['DshHistory', 'apps/server/src/provider/Layers/DshNativeHistory.ts'],
  ];
  await mkdir(join(source, 'apps/server/dist'), { recursive: true });
  await build({ stdin: { contents: imports.map(([name, file]) => 'export * as ' + name + ' from ' + JSON.stringify(join(source, file)) + ';').join('\n'),
      resolveDir: source, sourcefile: 'test-only-original-engine.ts', loader: 'ts' },
    outfile: out, bundle: true, platform: 'node', format: 'esm',
    external: ['effect', 'effect/*', '@effect/platform-node/*', '@effect/platform-node-shared/*'],
    banner: { js: 'import { createRequire } from "node:module";const require=createRequire(import.meta.url);' } });
  engine = await import(pathToFileURL(out));
});
async function effects() {
  // Resolve the recorded immutable Effect runtime from the test-owned assembly.
  const { createRequire } = await import('node:module'), require = createRequire(join(source, 'package.json'));
  const modules = {};
  for (const [name, id] of [['Effect','effect/Effect'],['Stream','effect/Stream'],['Layer','effect/Layer'],
    ['SqlClient','effect/unstable/sql/SqlClient'],['NodeServices','@effect/platform-node/NodeServices']])
    modules[name] = await import(pathToFileURL(require.resolve(id)));
  return modules;
}
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(test) { for (let n=0;n<100;n++) { if (test()) return; await sleep(10); } throw Error('Original event did not arrive'); }
async function adapterFixture(t) {
  const { Effect, Stream } = await effects();
  const state = { status:'running', nativeTurn:7, approvals:[], questions:[], messages:[] }, calls=[];
  const host = { describe:async()=>({installed:true,authenticated:true,version:'isolated',models:[]}),
    hasSession:async()=>true, create:async()=>{throw Error('Existing binding only');}, selectModel:async()=>{}, pinTitle:async()=>{},
    permission:async()=>{}, retain:async()=>{}, release:()=>{}, prompt:async(sid,id)=>calls.push({type:'prompt',sid,id}),
    observe:async()=>structuredClone(state), approve:async(sid,id,audit)=>{calls.push({type:'approve',sid,id,audit});throw Error('Unknown native result');},
    answer:async(sid,id,call)=>calls.push({type:'answer',sid,id,call}), interrupt:async()=>{calls.push({type:'interrupt'});} };
  const adapter=await Effect.runPromise(engine.Adapter.makeDshAdapter({instanceId:'dsh',environmentId:'isolated-env',preset:'isolated-preset',host,pollIntervalMs:5}));
  const events=[], abort=new AbortController();
  const reader=Effect.runPromise(Stream.runForEach(adapter.streamEvents,e=>Effect.sync(()=>events.push(e))),{signal:abort.signal}).catch(()=>{});
  const start={threadId:'isolated-thread',cwd:'/isolated/project',runtimeMode:'auto-accept-edits'};
  const input={threadId:start.threadId,sourceCommandId:'original-command',input:'isolated',modelSelection:{instanceId:'dsh',model:'original-model'}};
  const session=await Effect.runPromise(adapter.startSession(start));
  t.after(async()=>{await Effect.runPromise(adapter.stopAll());abort.abort();await reader;});
  return {Effect,adapter,state,calls,events,host,start,input,session};
}

test('adapter emits stable native audit IDs and waits for native confirmation after an unknown approval',async t=>{
  const f=await adapterFixture(t),sid=f.session.resumeCursor.sessionId;
  f.state.status='waiting_approval';f.state.approvals=[{id:'native-audit',toolName:'bash',callId:'native-call',actionable:true}];
  await f.Effect.runPromise(f.adapter.sendTurn(f.input));
  await until(()=>f.events.some(e=>e.type==='request.opened'));
  const request=f.events.find(e=>e.type==='request.opened');assert.equal(request.requestId,'dsh:'+sid+':native-audit');
  await assert.rejects(f.Effect.runPromise(f.adapter.respondToRequest(f.start.threadId,request.requestId,'accept')));
  await sleep(30);assert.equal(f.events.some(e=>e.type==='request.resolved'),false);
  f.state.approvals[0].outcome='allowed-once';
  await until(()=>f.events.some(e=>e.type==='request.resolved'));
  assert.equal(f.events.find(e=>e.type==='request.resolved').payload.resolution.nativeOutcome,'allowed-once');
  assert.deepEqual(f.calls.filter(c=>c.type==='approve'),[{type:'approve',sid,id:'original-command',audit:'native-audit'}]);
});

test('continued questions survive a failed read and close only after original projection settlement',async t=>{
  const f=await adapterFixture(t);f.state.status='completed';f.state.terminalSeq=9;
  f.state.questions=[{callId:'original-question',state:'continued',questions:[{id:'q1',question:'answer'}]}];
  await f.Effect.runPromise(f.adapter.sendTurn(f.input));
  await until(()=>f.events.some(e=>e.type==='user-input.requested')&&f.events.some(e=>e.type==='turn.completed'));
  const key=f.events.find(e=>e.type==='user-input.requested').requestId;
  f.host.observe=async()=>{throw Error('Disconnected original read');};await sleep(30);
  assert.equal(f.events.some(e=>e.type==='user-input.resolved'),false);
  f.host.observe=async()=>structuredClone(f.state);
  await f.Effect.runPromise(f.adapter.respondToUserInput(f.start.threadId,key,{q1:{answers:['yes']}}));
  await sleep(30);assert.equal(f.events.some(e=>e.type==='user-input.resolved'),false);
  f.state.questions=[];await until(()=>f.events.some(e=>e.type==='user-input.resolved'));
  assert.equal(f.events.filter(e=>e.type==='turn.completed').length,1);
  assert.equal(f.calls.filter(c=>c.type==='answer')[0].call,'original-question');
});

test('unknown cancellation keeps the original session; confirmed native terminal releases it',async t=>{
  const f=await adapterFixture(t),turn=await f.Effect.runPromise(f.adapter.sendTurn(f.input));
  await assert.rejects(f.Effect.runPromise(f.adapter.interruptTurn(f.start.threadId,'another-turn')));
  assert.equal(f.calls.some(c=>c.type==='interrupt'),false);
  await assert.rejects(f.Effect.runPromise(f.adapter.stopSession(f.start.threadId)));
  assert.equal(await f.Effect.runPromise(f.adapter.hasSession(f.start.threadId)),true);
  assert.equal(turn.turnId,'dsh:original-command');
  f.state.status='cancelled';f.state.terminalSeq=10;
  await f.Effect.runPromise(f.adapter.stopSession(f.start.threadId));
  assert.equal(await f.Effect.runPromise(f.adapter.hasSession(f.start.threadId)),false);
});

test('continued native question reply persists its own turn lifecycle without another prompt',async t=>{
  const f=await adapterFixture(t),sid=f.session.resumeCursor.sessionId;
  f.state.status='completed';f.state.terminalSeq=9;
  f.state.questions=[{callId:'original-question',state:'continued',questions:[{id:'q1',question:'answer'}]}];
  await f.Effect.runPromise(f.adapter.sendTurn(f.input));
  await until(()=>f.events.some(e=>e.type==='user-input.requested')&&f.events.some(e=>e.type==='turn.completed'));
  const key=f.events.find(e=>e.type==='user-input.requested').requestId;
  await f.Effect.runPromise(f.adapter.respondToUserInput(f.start.threadId,key,{q1:{answers:['yes']}}));
  f.state.questions=[];
  f.state.followUps=[{callId:'original-question',nativeTurn:8,status:'running',approvals:[],questions:[],messages:[]}];
  const childId='dsh:'+sid+':question:original-question:8';
  await until(()=>f.events.some(e=>e.type==='turn.started'&&e.turnId===childId));
  assert.equal((await f.Effect.runPromise(f.adapter.listSessions()))[0].activeTurnId,childId);
  f.state.followUps[0].messages=[{seq:12,text:'actual continued answer'}];
  f.state.followUps[0].status='completed';f.state.followUps[0].terminalSeq=13;
  await until(()=>f.events.some(e=>e.type==='turn.completed'&&e.turnId===childId));
  assert.equal(f.events.filter(e=>e.type==='turn.completed').length,2);
  const message=f.events.find(e=>e.type==='item.completed');
  assert.equal(message.turnId,childId);assert.equal(message.payload.detail,'actual continued answer');
  assert.equal((await f.Effect.runPromise(f.adapter.listSessions()))[0].activeTurnId,undefined);
  assert.equal(f.calls.filter(c=>c.type==='prompt').length,1);
  assert.deepEqual(f.calls.filter(c=>c.type==='answer'),[{type:'answer',sid,id:'original-command',call:'original-question'}]);
});

test('restoring the same binding does not replay an old terminal over a new source input',async t=>{
  const f=await adapterFixture(t);f.state.status='completed';f.state.terminalSeq=9;
  await f.Effect.runPromise(f.adapter.sendTurn(f.input));
  await until(()=>f.events.some(e=>e.type==='turn.completed'));
  const cursor=(await f.Effect.runPromise(f.adapter.listSessions()))[0].resumeCursor;
  await sleep(30);const before=f.events.filter(e=>e.type==='turn.started'||e.type==='turn.completed').length;
  await f.Effect.runPromise(f.adapter.startSession({...f.start,resumeCursor:cursor}));
  await sleep(30);
  assert.equal(f.events.filter(e=>e.type==='turn.started'||e.type==='turn.completed').length,before,
    'A restored completed request must not consume the next pending source input');
  const prior=structuredClone(f.state);f.state.status='running';f.state.nativeTurn=8;delete f.state.terminalSeq;
  f.host.observe=async(_sid,id)=>structuredClone(id==='original-command'?prior:f.state);
  await f.Effect.runPromise(f.adapter.sendTurn({...f.input,sourceCommandId:'second-command',input:'second source'}));
  await until(()=>f.events.some(e=>e.type==='turn.started'&&e.turnId==='dsh:second-command'));
  assert.equal(f.events.filter(e=>e.type==='turn.started'&&e.turnId==='dsh:original-command').length,1);
});

test('recorded original continued question stays waiting across bounded native-history checkpoints',async()=>{
  const record=JSON.parse(await readFile(process.env.DSH_QUESTION_OBSERVATIONS,'utf8'));
  const session=structuredClone(record.sessions[0]),sid=session.id,cwd='/recorded-owned-project',preset='recorded-preset';
  let active=structuredClone(session.questions);
  const rpc={call:async(method,args)=>{
    if(method==='session/list')return {items:[{sessionId:sid,cwd,running:session.running,
      projections:{asOfSeq:session.events.at(-1).seq,values:{agentPreset:preset,userQuestions:{active,settled:[]}}}}]};
    assert.equal(method,'session/page');const q=args.request;
    const end=Math.min(q.throughSeq+1,q.beforeSeq??session.events.length);
    return {records:session.events.slice(Math.max(0,end-q.maxMessages),end).map(event=>({type:'event',event}))};
  }};
  const history=await engine.DshHistory.readDshHistoryChunk(rpc,sid,cwd,preset);
  assert.equal(history.observation,'waiting_answer');assert.equal(history.complete,true);
  assert.equal(history.turns.length,2);assert.equal(history.turns[1].messages[0].sourceCommandId,'7d96ae1e-c049-4f8e-b9c1-92db16ac5f8b');
  const again=await engine.DshHistory.readDshHistoryChunk(rpc,sid,cwd,preset,history.checkpoint);
  assert.equal(again.observation,'waiting_answer');assert.deepEqual(again.turns,[]);
  // Older checkpoints have no question owners: cold re-read original events rather than assuming ready.
  const old=await engine.DshHistory.readDshHistoryChunk(rpc,sid,cwd,preset,{afterSeq:14,activeTurn:null,pending:[]});
  assert.equal(old.observation,'waiting_answer');
  active=[{...session.questions[0],callId:'foreign-question'}];
  await assert.rejects(engine.DshHistory.readDshHistoryChunk(rpc,sid,cwd,preset,again.checkpoint),/question.*identity/i);
});

test('exact native turn keeps original source input when transport adds an attachment reference',()=>{
  for(const provider of ['codex','dsh']){
    const nativeTurn='native-turn',turnId=provider==='codex'?nativeTurn:'dsh:original-command',sourceId='original-user';
    const native={id:nativeTurn,state:'completed',startedAt:'2026-10-04T04:00:00.000Z',completedAt:'2026-10-04T04:01:00.000Z',messages:[
      {id:'native-user',role:'user',text:'original input\n\n[Attached file "proof.txt" is saved at: /owned/proof.txt]',createdAt:'2026-10-04T04:00:00.000Z',...(provider==='dsh'?{sourceCommandId:'original-command'}:{})},
      {id:'native-assistant',role:'assistant',text:'actual original reply',createdAt:'2026-10-04T04:01:00.000Z'}]};
    const saved=[{turnId,pendingMessageId:sourceId,assistantMessageId:'assistant:native-assistant'}];
    const original={id:sourceId,role:'user',text:'original input',turnId,streaming:false,createdAt:native.startedAt,updatedAt:native.startedAt,attachments:[{type:'file',id:'actual-file'}]};
    const assistant={id:'assistant:native-assistant',role:'assistant',text:'actual original reply',turnId,createdAt:native.completedAt,updatedAt:native.completedAt,streaming:false};
    const plan=engine.History.planNativeHistory({nativeId:'same-native',cwd:'/owned',turns:[native],observation:'ready',checkpoint:{},complete:true},provider,saved,[original,assistant]);
    assert.equal(plan.aliases['message:native-user'],sourceId);assert.equal(plan.latestTurn.turnId,turnId);
    assert.equal(plan.messages.some(message=>message.role==='user'),false);assert.equal(original.text,'original input');
    assert.deepEqual(original.attachments,[{type:'file',id:'actual-file'}]);
    assert.throws(()=>engine.History.planNativeHistory({turns:[native]},provider,saved,[original,{...assistant,text:'conflicting assistant'}]),/content conflicts/);
    assert.throws(()=>engine.History.planNativeHistory({turns:[native]},provider,saved,[{...original,turnId:'foreign-turn'},assistant]),/identity conflict/);
  }
});

test('original T3 SQLite and live reducer retain exact submitted requests until native resolution',async t=>{
  const { Effect,Layer,SqlClient,NodeServices }=await effects();
  const base=await mkdtemp(join(source,'projection-check-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const layer=engine.Pipeline.OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(engine.EventStoreLayer.OrchestrationEventStoreLive),
    Layer.provideMerge(engine.Config.ServerConfig.layerTest(base,base)),
    Layer.provideMerge(engine.Sqlite.SqlitePersistenceMemory),Layer.provideMerge(NodeServices.layer));
  await Effect.runPromise(Effect.gen(function*(){
    const pipeline=yield* engine.PipelineService.OrchestrationProjectionPipeline,
      store=yield* engine.EventStore.OrchestrationEventStore,sql=yield* SqlClient.SqlClient;
    let id=0;const date='2026-10-03T16:00:00.000Z',threadId='original-thread',requestId='dsh:original-native:audit-1';
    const append=(type,payload,aggregateKind='thread',commandId)=>Effect.gen(function*(){
      const event=yield* store.append({type,payload,eventId:'event-'+(++id),aggregateKind,aggregateId:aggregateKind==='project'?'original-project':payload.threadId??threadId,
        occurredAt:date,commandId:commandId??'command-'+id,causationEventId:null,correlationId:null,metadata:{}});
      yield* pipeline.projectEvent(event);return event;
    });
    yield* append('project.created',{projectId:'original-project',title:'fixture',workspaceRoot:base,defaultModelSelection:null,scripts:[],createdAt:date,updatedAt:date},'project');
    yield* append('thread.created',{threadId,projectId:'original-project',title:'fixture',modelSelection:{instanceId:'dsh',model:'original-model'},runtimeMode:'auto-accept-edits',interactionMode:'default',branch:null,worktreePath:null,createdAt:date,updatedAt:date});
    for(const provider of ['dsh','codex']){
      const target=provider+'-pending-thread',source=provider+'-pending-source',turn=provider+'-original-turn';
      yield* append('thread.created',{threadId:target,projectId:'original-project',title:'pending identity',modelSelection:{instanceId:provider,model:'original-model'},runtimeMode:'full-access',interactionMode:'default',branch:null,worktreePath:null,createdAt:date,updatedAt:date});
      yield* append('thread.turn-start-requested',{threadId:target,messageId:source,modelSelection:{instanceId:provider,model:'original-model'},runtimeMode:'full-access',interactionMode:'default',createdAt:date});
      const session={threadId:target,status:'ready',providerName:provider,providerInstanceId:provider,runtimeMode:'full-access',activeTurnId:null,lastError:null,updatedAt:date};
      yield* append('thread.session-set',{threadId:target,session},'thread','server:provider-session-set:restore-'+provider);
      let pending=yield* sql`SELECT pending_message_id FROM projection_turns WHERE thread_id=${target} AND turn_id IS NULL`;
      assert.deepEqual(pending.map(row=>({...row})),[{pending_message_id:source}]);
      yield* append('thread.session-set',{threadId:target,session:{...session,status:'running',activeTurnId:turn}});
      pending=yield* sql`SELECT pending_message_id FROM projection_turns WHERE thread_id=${target} AND turn_id=${turn}`;
      assert.equal(pending[0].pending_message_id,source);
    }
    const activity={id:'original-activity',turnId:null,tone:'approval',kind:'approval.requested',summary:'fixture',payload:{requestId,requestKind:'command'},createdAt:date};
    yield* append('thread.activity-appended',{threadId,activity});
    const submitted=yield* append('thread.approval-response-requested',{threadId,requestId,decision:'accept',createdAt:date});
    let rows=yield* sql`SELECT status,decision,resolved_at FROM projection_pending_approvals WHERE request_id=${requestId}`;
    assert.deepEqual(rows.map(row=>({...row})),[{status:'pending',decision:'accept',resolved_at:null}]);
    let activities=yield* sql`SELECT payload_json FROM projection_thread_activities WHERE activity_id='original-activity'`;
    const marker=JSON.parse(activities[0].payload_json).responseSubmitted;
    assert.deepEqual(marker,{commandId:submitted.commandId,sequence:submitted.sequence,submittedAt:date});
    let reduced=engine.Reducer.applyThreadDetailEvent({id:threadId,activities:[activity],updatedAt:date},submitted);
    assert.equal(reduced.kind,'updated');assert.deepEqual(reduced.thread.activities[0].payload.responseSubmitted,marker);
    const reopened=yield* append('thread.activity-appended',{threadId,activity});
    reduced=engine.Reducer.applyThreadDetailEvent(reduced.thread,reopened);
    assert.deepEqual(reduced.thread.activities[0].payload.responseSubmitted,marker);
    activities=yield* sql`SELECT payload_json FROM projection_thread_activities WHERE activity_id='original-activity'`;
    assert.deepEqual(JSON.parse(activities[0].payload_json).responseSubmitted,marker);
    yield* append('thread.activity-appended',{threadId,activity:{...activity,id:'failed-activity',tone:'error',kind:'provider.approval.respond.failed',payload:{requestId,detail:'Unknown pending permission request'}}});
    rows=yield* sql`SELECT status,decision,resolved_at FROM projection_pending_approvals WHERE request_id=${requestId}`;
    assert.equal(rows[0].status,'pending');
    assert.equal(engine.Requests.derivePendingRequests([activity,{...activity,id:'failed-activity',kind:'provider.approval.respond.failed',payload:{requestId,detail:'Unknown pending permission request'}}]).approvals.length,1);
    yield* append('thread.activity-appended',{threadId,activity:{...activity,id:'native-resolution',kind:'approval.resolved',payload:{requestId,decision:'accept',nativeOutcome:'allowed-once'}}});
    rows=yield* sql`SELECT status FROM projection_pending_approvals WHERE request_id=${requestId}`;
    assert.equal(rows[0].status,'resolved');
    const questionId='dsh:original-native:question:original-call';
    const question={...activity,id:'question-activity',tone:'info',kind:'user-input.requested',payload:{requestId:questionId,questions:[]}};
    yield* append('thread.activity-appended',{threadId,activity:question});
    const answer=yield* append('thread.user-input-response-requested',{threadId,requestId:questionId,answers:{q1:{answers:['yes']}},createdAt:date});
    activities=yield* sql`SELECT payload_json FROM projection_thread_activities WHERE activity_id='question-activity'`;
    const answerMarker=JSON.parse(activities[0].payload_json).responseSubmitted;
    reduced=engine.Reducer.applyThreadDetailEvent({id:threadId,activities:[question],updatedAt:date},answer);
    assert.deepEqual(reduced.thread.activities[0].payload.responseSubmitted,answerMarker);
  }).pipe(Effect.provide(layer),Effect.scoped));
});


test('actual SDK wire history is ready at the original paid terminal and rejects private fold-state wrappers',async()=>{
  const record=JSON.parse(await readFile(process.env.DSH_ACTUAL_COLD_READ,'utf8'));
  const {row,history}=record;const scope=history,events=history.events;
  assert.deepEqual(row.projections.values.userQuestions,{active:[],settled:[]});
  const rpc={call:async(method,args)=>{
    if(method==='session/list')return {items:[structuredClone(row)]};
    assert.equal(method,'session/page');const q=args.request,end=Math.min(q.throughSeq+1,q.beforeSeq??events.length);
    return {records:events.slice(Math.max(0,end-q.maxMessages),end).map(event=>({type:'event',event}))};
  }};
  const actual=await engine.DshHistory.readDshHistoryChunk(rpc,scope.sessionId,scope.cwd,scope.preset);
  assert.equal(actual.complete,true);assert.equal(actual.observation,'ready');assert.equal(actual.checkpoint.afterSeq,18);
  assert.equal(actual.turns.length,1);assert.equal(actual.turns[0].state,'completed');
  assert(actual.turns[0].messages.some(m=>m.role==='assistant'&&m.text.includes('P56_3914ee3e1673')));
  row.projections.values.userQuestions={questions:{active:[],settled:[]}};
  await assert.rejects(engine.DshHistory.readDshHistoryChunk(rpc,scope.sessionId,scope.cwd,scope.preset),/wire projection unavailable/);
});
