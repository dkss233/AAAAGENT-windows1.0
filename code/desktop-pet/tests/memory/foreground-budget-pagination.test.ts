import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DialogueContext, ConversationMessage } from '../../contracts/index.js';
import type { InputBudgetInfo } from '../../contracts/context-budget.js';
import type { EmotionBackground, EmotionMessageSnapshot } from '../../contracts/emotion-state.js';
import { assembleContext } from '../../memory/context.js';
import { fixture, scope, message, change, NOW } from './sqlite-fixture.js';
import { lifecycle, signal, none } from './lifecycle-fixture.js';
import type { SqliteMemoryStore } from '../../memory/sqlite-store.js';
import { SqliteDynamicsManagementPort } from '../../memory/dynamics-management.js';

const budget=(n=200000):InputBudgetInfo=>({targetInputTokens:n,apiInputLimit:1048576,contextWindowTokens:1048576,reservedOutputTokens:8192,effectiveInputTokens:n,constrainedBy:['target'],counting:{method:'utf8_upper_bound',estimated:true,model:'synthetic',version:'test-json-utf8'}});
const count=(c:DialogueContext,text:string)=>{const {contextBudget:_,...body}=c;return Buffer.byteLength(JSON.stringify({body,currentMessage:text}),'utf8');};
const opts=(n=200000)=>({inputTokenBudget:n,maxRecentMessages:1,maxMemories:1,summaryLimit:0,recentPageSize:1,budgetInfo:budget(n),currentEmotionReserveTokens:512,countTokens:count,relevance:()=>1});
// Synthetic persisted eligible history; production writes continue through issued contexts.
function seedTurns(store:SqliteMemoryStore,number:number,payload='旧对话🙂',prefix='t'){
  const db=new Database(store.filename);
  try{for(let i=0;i<number;i++){
    const id=`${prefix}${i}`,owned=scope('companion',id);
    store.append(owned,[message(`${id}:user`,payload),{...message(`${id}:assistant`,'回复 '+payload),role:'assistant'}]);
    db.prepare('UPDATE memory_records SET evidence_eligible=1,sources_json=? WHERE id=?').run(JSON.stringify([{id:`${id}:user`,version:1}]),`${id}:assistant`);
  }}finally{db.close();}
}
function add(store:SqliteMemoryStore,id:string,text:string){store.append(scope(),[message('raw-'+id,text)]);store.apply(change({type:'add',id,text,sourceIds:['raw-'+id]},'add-'+id));}

// B02/B03/B06/B07: actual local SQLite, public diagnostic contract, zero model.
test('B02 count caps vanish across history, summaries, ranking and actual trace; current text is sent once',async t=>{
  const f=fixture(undefined,'foreground-budget-55');t.after(f.cleanup);const store=f.open();seedTurns(store,30);
  for(let i=0;i<12;i++)add(store,'tea'+i,'红茶 '+i);add(store,'other','钢琴');
  for(let i=0;i<40;i++)store.recordDerived(scope(),{id:'summary'+i,kind:'summary',text:'归纳 '+i,sourceIds:['t0:user'],createdAt:NOW});
  const port=lifecycle(store,undefined,undefined,{context:opts()}),owned=scope('companion','q');
  await port.append(owned,[message('q:user','红茶')]);const c=await port.foregroundContext(owned,'q:user','红茶',null,signal());
  assert.equal(c.recent.filter(m=>m.id.startsWith('t')).length,60);assert.ok(!c.recent.some(m=>m.id==='q:user'));
  assert.equal(c.memories.length,12);assert.ok(!c.memories.some(m=>m.id==='other'));
  assert.equal(c.contextBudget!.selected.summaries,40);assert.equal(c.contextBudget!.selected.turns,43);
  assert.equal(c.contextBudget!.countedInputTokens,count(c,'红茶'));assert.equal(Object.values(c.contextBudget!.layers).reduce((a,b)=>a+b,0),count(c,'红茶'));
  assert.ok(!c.contextBudget!.omissions.some(o=>o.reason==='limit'));
  const trace=store.recall.traces({characterId:'companion',offset:0,limit:1}).records[0]!;
  assert.equal(trace.candidates.filter(x=>x.selected).length,12);assert.ok(!trace.candidates.some(x=>x.omission==='limit'));
  assert.deepEqual(trace.contextBudget,c.contextBudget);assert.equal(trace.candidates.find(x=>x.source.id==='other')!.omission,'no_cue');
});

test('B03 SQLite page boundaries and equal logical order retain whole groups; leading orphan is reported',t=>{
  const f=fixture(undefined,'foreground-budget-55');t.after(f.cleanup);const store=f.open();
  store.append(scope(),[{...message('orphan','孤立'),role:'assistant'}]);seedTurns(store,7);
  const db=f.track(new Database(f.filename));db.prepare("UPDATE memory_records SET logical_order=17,evidence_eligible=1 WHERE kind='transcript'").run();db.close();
  const groups=(size:number)=>[...store.foregroundRecords(scope(),false,false,size).turns].map(turn=>turn.map(m=>m.id));
  assert.deepEqual(groups(1),groups(3));assert.deepEqual(groups(3),groups(64));assert.deepEqual(groups(1)[0],['t6:user','t6:assistant']);
  const c=lifecycle(store,undefined,undefined,{context:opts()});return c.context(scope(),'query',null,signal()).then(result=>{
    assert.equal(result.recent.length,14);assert.ok(result.contextBudget!.omissions.some(o=>o.id==='orphan'&&o.reason==='orphan_assistant'));
  });
});

test('B03 latest oversize turn stops selection, does not backfill older small turns, and marks unread history',async t=>{
  const f=fixture(undefined,'foreground-budget-55');t.after(f.cleanup);const store=f.open();seedTurns(store,70,'小','old');seedTurns(store,1,'大'.repeat(1000),'latest');
  const owned=scope('companion','q'),port=lifecycle(store,undefined,undefined,{context:opts(5000)});await port.append(owned,[message('q:user','本轮')]);
  const c=await port.foregroundContext(owned,'q:user','本轮',null,signal());assert.deepEqual(c.recent,[]);
  assert.equal(c.contextBudget!.unreadRecent,true);assert.ok(c.contextBudget!.omissions.some(o=>o.id==='latest0:user'&&o.reason==='recent_budget'));
  assert.ok(!c.contextBudget!.omissions.some(o=>o.id==='old0:user'));
  await assert.rejects(port.foregroundContext(owned,'q:user','本轮',null,signal()).then(()=>lifecycle(store,undefined,undefined,{context:opts(1)}).foregroundContext(owned,'q:user','本轮',null,signal())),/required_context_exceeds_budget/);
});

test('B03/B07 a source revision change between pages rejects the assembled candidate',t=>{
  const f=fixture(undefined,'foreground-budget-55');t.after(f.cleanup);const store=f.open();seedTurns(store,3);const read=store.foregroundRecords(scope(),false,false,1),iterator=read.turns[Symbol.iterator]();
  assert.deepEqual((iterator.next().value as readonly ConversationMessage[]).map(m=>m.id),['t2:user','t2:assistant']);store.setPrompt(scope(),'changed');assert.throws(()=>iterator.next(),/stale_context/);
});

const emotion:EmotionBackground={user:{subject:'user',revision:1,observation:{subject:'user',label:'开心',intensity:null,confidence:0.8,provenance:'user_explicit',sources:[{id:'u1',version:1}]},updatedAt:NOW,sourceMessage:{id:'u1',version:1},logicalOrder:1,sessionId:'s'},companion:{subject:'companion',revision:1,observation:null,updatedAt:null,sourceMessage:null,logicalOrder:null,sessionId:null}};
const past=(id:string,label:string):EmotionMessageSnapshot=>({role:'user',message:{id,version:1},scope:scope(),logicalOrder:1,recordedAt:NOW,observations:[{...emotion.user.observation!,label}],background:emotion});
function reader(recent:ConversationMessage[],summaries:ReturnType<SqliteMemoryStore['visible']>=[],memories:DialogueContext['memories']=[]){return {characterId:'companion' as const,contextRecords:()=>({characterId:'companion' as const,revision:1,recent,summaries,memories}),assertContextCurrent(){}};}

test('B06 current emotion reserve is used first, empty background releases it, and history emotion is admitted individually',()=>{
  const recent=[message('u1','对话一'),message('u2','对话二')],r=reader(recent),base={...opts(),prompts:{companion:'test'}};
  const plain=assembleContext(r,scope(),'本轮',null,NOW,base);
  const desired=assembleContext(r,scope(),'本轮',null,NOW,{...base,emotionBackground:emotion,currentEmotionReserveTokens:1000});
  const withSmall={...desired.context,recent:desired.context.recent.map(m=>m.id==='u2'?{...m,emotionSnapshot:past('u2','开心')}:m)};
  const limit=count(withSmall,'本轮')+20;
  const result=assembleContext(r,scope(),'本轮',null,NOW,{...base,inputTokenBudget:limit,budgetInfo:budget(limit),emotionBackground:emotion,currentEmotionReserveTokens:1000,messageEmotions:[past('u1','long'.repeat(1000)),past('u2','开心')]});
  assert.equal(result.context.recent.length,2);assert.equal(result.context.emotionBackground!.user.observation!.provenance,'user_explicit');
  assert.ok(result.context.recent.find(m=>m.id==='u2')!.emotionSnapshot);assert.ok(!result.context.recent.find(m=>m.id==='u1')!.emotionSnapshot);
  assert.equal(result.context.contextBudget!.selected.historicalEmotions,1);assert.ok(result.context.contextBudget!.layers.current_emotion>0);
  const missing={...emotion,user:{...emotion.user,observation:null}};
  assert.equal(assembleContext(r,scope(),'本轮',null,NOW,{...base,emotionBackground:missing}).countedInputTokens,plain.countedInputTokens);
  const zero=assembleContext(r,scope(),'本轮',null,NOW,{...base,emotionBackground:emotion,currentEmotionReserveTokens:0});assert.equal(zero.context.emotionBackground,undefined);assert.ok(zero.context.contextBudget!.omissions.some(o=>o.reason==='current_emotion_budget'));
});

test('B06 recent text takes priority; an oversized memory is skipped, smaller valid memories still use remainder',()=>{
  const memories=[{characterId:'companion' as const,id:'big',version:1,text:'x'.repeat(20000),sourceIds:[]},{characterId:'companion' as const,id:'small',version:1,text:'红茶',sourceIds:[]}];
  const result=assembleContext(reader([message('u','最近')],[],memories),scope(),'本轮',null,NOW,{...opts(1000),prompts:{companion:'test'}});
  assert.equal(result.context.recent[0]!.text,'最近');assert.deepEqual(result.context.memories.map(m=>m.id),['small']);
  assert.ok(result.context.contextBudget!.omissions.some(o=>o.id==='big'&&o.reason==='memory_budget'));
});

test('B07 two failed holds remain after paginated safe conversation and restart; a new hold invalidates issued context',async t=>{
  const f=fixture(undefined,'foreground-budget-55');t.after(f.cleanup);let store=f.open(),port=lifecycle(store,undefined,undefined,{context:opts()});
  add(store,'private','红茶秘密');for(const id of ['hold1','hold2']){const s=scope('companion',id);await port.append(s,[message(id+':user','遗忘请求')]);port.beginPendingMutation(s,id+':user',{request:'forget',sources:null});store.pending.fail(s,id+':user');}
  for(let i=0;i<15;i++){const s=scope('companion','safe'+i),id=s.turnId+':user';await port.append(s,[message(id,'安全 '+i)]);const c=await port.foregroundContext(s,id,'安全 '+i,null,signal());await port.appendAssistant(s,{...message(s.turnId+':assistant','安全回复'),role:'assistant'},c,id,signal());}
  store.close();store=f.open();port=lifecycle(store,undefined,undefined,{context:opts()});const s=scope('companion','q');await port.append(s,[message('q:user','本轮')]);
  const c=await port.foregroundContext(s,'q:user','本轮',null,signal());assert.equal(c.recent.length,30);assert.equal(c.summary,'');assert.deepEqual(c.memories,[]);assert.equal(c.emotionBackground,undefined);
  assert.ok(!JSON.stringify(c).includes('红茶秘密'));assert.equal(port.pendingMutations('companion').length,2);assert.ok(port.pendingMutations('companion').every(x=>x.status==='failed'));
  const n=scope('companion','new');await port.append(n,[message('new:user','更晚遗忘')]);port.beginPendingMutation(n,'new:user',{request:'forget',sources:null});assert.throws(()=>port.assertContextCurrent(c),/stale_context/);
});

test('B07 budget traces lose forgotten provenance even when the forgotten candidate was not selected',async t=>{
  const f=fixture(undefined,'foreground-budget-55');t.after(f.cleanup);const store=f.open();add(store,'secret','红茶秘密');const owned=scope('companion','q');
  const port=lifecycle(store,undefined,undefined,{context:opts()});await port.append(owned,[message('q:user','红茶')]);const c=await port.foregroundContext(owned,'q:user','红茶',null,signal());assert.ok(c.contextBudget);
  const result=new SqliteDynamicsManagementPort(store).forget({characterId:'companion',id:'secret',expectedVersion:1,operationId:'forget',reason:'explicit'});assert.equal(result.status,'applied');assert.throws(()=>port.assertContextCurrent(c),/stale_context/);
  const trace=store.recall.traces({characterId:'companion',offset:0,limit:1}).records[0]!;assert.equal(trace.status,'invalidated');assert.deepEqual(trace.candidates,[]);assert.equal(trace.contextBudget,undefined);
});

test('B08 independent background read limits and summary12/24 remain unchanged by foreground expansion',async t=>{
  const f=fixture(undefined,'foreground-budget-55');t.after(f.cleanup);const store=f.open();seedTurns(store,20);let seen=0;
  const port=lifecycle(store,input=>{seen=input.messages.length;return Promise.resolve(none(input));},undefined,{context:opts(),turn:{inputTokenBudget:30000,countTokens:()=>1,provider:{async plan(input){seen=input.messages.length;return none(input);}},readLimits:{maxRecentMessages:3,maxMemories:2,summaryLimit:1}},summary:{inputTokenBudget:30000,countTokens:()=>1,minMessages:12,maxMessages:24,provider:{async summarize(input){assert.equal(input.sources.length,24);return {scope:input.scope,text:'summary',sourceVersions:input.sources.map(({id,version})=>({id,version}))};}}}});
  const s=scope('companion','q');await port.append(s,[message('q:user','新输入')]);await port.foregroundContext(s,'q:user','新输入',null,signal());await port.prepareBackgroundTurn(s,'q:user','新输入',signal());assert.ok(seen<=3);
  assert.equal((await port.summarizePending(s,signal())).status,'applied');
});

test('B02/B03 performance: paged 200K selection counts fitting blocks rather than every candidate',async t=>{
  const f=fixture(undefined,'foreground-budget-55');t.after(f.cleanup);const store=f.open();seedTurns(store,400,'合成🙂'.repeat(50));let calls=0;
  const port=lifecycle(store,undefined,undefined,{context:{...opts(),recentPageSize:64,countTokens:(c,text)=>{calls++;return count(c,text);}}});const start=performance.now(),c=await port.context(scope(),'本轮',null,signal()),elapsedMs=performance.now()-start;
  assert.ok(c.recent.length>24);assert.ok(c.contextBudget!.unreadRecent);assert.ok(c.contextBudget!.countedInputTokens<=200000);assert.ok(calls<100);
  writeFileSync(resolve(dirname(f.filename),'../..','performance.json'),JSON.stringify({fixtureTurns:400,selected:c.contextBudget!.selected,countedInputTokens:c.contextBudget!.countedInputTokens,countCalls:calls,elapsedMs,method:'synthetic full JSON UTF8;not production provider tokenizer',zeroModels:true},null,2)+'\n');
});
