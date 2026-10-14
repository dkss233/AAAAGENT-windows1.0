import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ForwardReceipts} from '../../harness/receipts.js';
import {DesktopWork} from '../../harness/desktop-work.js';
import {WorkPlanner} from '../../providers/work-plan.js';
import {WorkIntentClassifier} from '../../providers/work-intent.js';
import {interpretWork} from '../../providers/work-conversation.js';
import {ProviderTransport,type EndpointConfig} from '../../providers/transport.js';
import type {WorkTaskReference,WorkPlanContinuity,DesktopWorkState,WorkContinuationIntent} from '../../contracts/desktop-work.js';
const scope={characterId:'synthetic',sessionId:'session',turnId:'first',generation:1};
const endpoint:EndpointConfig={endpoint:'https://api.deepseek.com/chat/completions',model:'deepseek-flash',apiKey:()=> 'synthetic',authorizer:{async authorize(){return {async settle(){}};}}};
const target={threadId:'11111111-1111-4111-8111-111111111111',hostId:'local' as const,title:'Synthetic task',projectPath:'/synthetic'};
const signal=()=>new AbortController().signal;
const goal='整理合成项目，回传桌宠，作为长期记忆候选，保留来源。';
function wireFixture(output:unknown) {
 const calls:Record<string,any>[]=[];
 const transport=new ProviderTransport((async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));}) as typeof fetch);
 return {calls,transport};
}
const reference:WorkTaskReference={originalRequest:goal,currentRequest:goal,arrangement:{executor:'codex',title:'Synthetic',projectName:'Project'}};
test('three provider boundaries whitelist nested evidence and never forward results, identities or old consent',async()=>{
 const poisoned={...reference,result:'PRIVATE_RESULT',requestId:'OLD_ID',executionAuthorized:true,arrangement:{...reference.arrangement!,secret:'SECRET'}};
 const continuity={...poisoned,previousTask:poisoned,conversation:[{role:'user',text:'请保留来源',scope:'HIDDEN_SCOPE',result:'PRIVATE_RESULT'}]} as unknown as WorkPlanContinuity;
 const router=wireFixture({kind:'work',question:''});await new WorkIntentClassifier(endpoint,router.transport).classify(scope,'整理后发给你',signal(),poisoned);
 const interpreter=wireFixture({kind:'supplement',text:'候选任务',question:'',executionAuthorized:false});await interpretWork(endpoint,interpreter.transport,scope,'请保留来源',{stage:'clarifying',...continuity},signal());
 const planner=wireFixture({kind:'clarify',executor:'codex',title:'',text:'',reason:'',targetId:'',projectId:'',projectVersion:0,question:'请明确范围',spokenSummary:''});await new WorkPlanner(endpoint,planner.transport).plan(scope,'候选任务',{projects:[],targets:[],continuity},signal());
 for(const f of [router,interpreter,planner]) {const input=f.calls[0]!.messages[1].content;assert.ok(input.includes(goal));for(const sentinel of ['PRIVATE_RESULT','OLD_ID','SECRET','HIDDEN_SCOPE','executionAuthorized'])assert.ok(!input.includes(sentinel));}
});
test('oversized continuity fails closed without a provider request',async()=>{
 const f=wireFixture({});const previous={...reference,originalRequest:'x'.repeat(20001)};
 await assert.rejects(new WorkIntentClassifier(endpoint,f.transport).classify(scope,'整理',signal(),previous));
 await assert.rejects(new WorkPlanner(endpoint,f.transport).plan(scope,'整理',{projects:[],targets:[],continuity:{...previous,conversation:[]}},signal()));
 await assert.rejects(interpretWork(endpoint,f.transport,scope,'补充',{stage:'clarifying',...reference,conversation:Array.from({length:9},()=>({role:'user' as const,text:'x'}))},signal()));
 assert.equal(f.calls.length,0);
});
async function fixture(t:TestContext) {
 const path=await mkdtemp(join(tmpdir(),'work-context-boundary-'));const receipts=new ForwardReceipts(join(path,'harness-relay.sqlite'));const states:DesktopWorkState[]=[];
 const inputs:any[]=[];let sends=0;const catalogTargets=[target];const notices:any[]=[];
 const control={continuation:{kind:'supplement',text:'更新后的合成正文',executionAuthorized:false} as WorkContinuationIntent};
 const forwarding={records:()=>receipts.list(),record:(id:string)=>receipts.get(id),pendingCount:()=>receipts.pendingCount(),observationPage:()=>[],targets:async()=>({items:catalogTargets}),projectChoices:async()=>[],
  prepare:async()=>{throw Error('Unexpected');},prepareDraft:async(input:any,id:string,version:number)=>receipts.prepareDraft(id,version,{...input,target}),confirm:async()=>{sends++;throw Error('Unexpected send');},refreshReceipt:async(id:string)=>receipts.get(id)};
 const work=new DesktopWork({receipts,forwarding,projects:{list:async()=>({items:[]})} as any,
  classify:async(_scope,text,_signal,previousTask)=>{inputs.push({kind:'classify',text,previousTask});return {kind:'work'};},
  interpret:async(_scope,_text,context)=>{inputs.push({kind:'interpret',context});return control.continuation;},
  plan:async(_scope,text,catalog)=>{inputs.push({kind:'plan',text,catalog});return {kind:'ready',executor:'codex',title:'Synthetic',text,reason:'Explicit',targetId:target.threadId};},emit:s=>states.push(s),notify:n=>notices.push(n)});
 t.after(async()=>{await work.close();receipts.close();await rm(path,{recursive:true,force:true});});
 const seed=(text:string,ss=scope)=>{const d=receipts.createDraft(ss,text);const r=receipts.prepareDraft(d.id,d.version,{text,executor:'codex',target,plan:{title:'Synthetic',reason:'Explicit'}});receipts.mutate(r.id,row=>{row.confirmedAt='2026-09-18T00:00:00Z';row.phase='completed';});const p=receipts.draft(d.id);receipts.mutateDraft(p.id,p.version,row=>{row.status='confirmed';});return d.id;};
 const input=async(text:string,ss=scope,binding?:any)=>{work.onInput();work.beginInput(ss,binding);await work.route(ss,text,signal());};
 return {receipts,work,states,inputs,seed,input,catalogTargets,control,notices,sends:()=>sends};
}
test('new draft pins predecessor across newer completions and supplements require fresh confirmation',async t=>{
 const f=await fixture(t);const old=f.seed(goal);await f.work.start(60000);await f.input('整理后发给你');
 const state=f.states.at(-1)!;assert.equal(f.receipts.draft(state.draft!.id).previousDraftId,old);
 f.seed('UNRELATED_LATER_TASK');const d=state.draft!,r=state.confirmation!;
 await f.input('请保留来源',{...scope,turnId:'supplement'},{draftId:d.id,draftVersion:d.version,requestId:r.id,requestVersion:r.version});
 const last=f.inputs.filter(x=>x.kind==='plan').at(-1);assert.equal(last.catalog.continuity.previousTask.originalRequest,goal);assert.ok(!JSON.stringify(last).includes('UNRELATED_LATER_TASK'));assert.equal(f.sends(),0);
});
test('legacy lookup uses insertion order before that card and ignores newer or merely prepared tasks',async t=>{
 const f=await fixture(t);const old=f.seed(goal);const legacy=f.receipts.createDraft(scope,'legacy correction');f.receipts.mutateDraft(legacy.id,legacy.version,d=>{delete d.previousDraftId;});
 f.seed('LATER_TASK');f.receipts.createDraft(scope,'UNCONFIRMED_TASK');
 assert.equal(f.receipts.previousConfirmedDraft(scope,legacy.id)!.id,old);
});
test('cross-character exact binding and unbound cross-session input cannot use another pending card',async t=>{
 const f=await fixture(t);await f.work.start(60000);await f.input('ORIGINAL_PENDING_SECRET');
 const state=f.states.at(-1)!,d=state.draft!,r=state.confirmation!;
 await f.input('确认',{...scope,characterId:'other'},{draftId:d.id,draftVersion:d.version,requestId:r.id,requestVersion:r.version});
 assert.equal(f.inputs.filter(x=>x.kind==='interpret').length,0);assert.equal(f.sends(),0);
 await f.input('让Codex整理另一个合成项目',{...scope,sessionId:'other'});
 const last=f.inputs.filter(x=>x.kind==='plan').at(-1);assert.ok(!JSON.stringify(last).includes('ORIGINAL_PENDING_SECRET'));
});

test('exact presented binding restores an old-session card without transferring old consent',async t=>{
 const f=await fixture(t);f.seed(goal);await f.work.start(60000);await f.input('整理后发给你');
 const state=f.states.at(-1)!,d=state.draft!,r=state.confirmation!;
 await f.input('请保留原始来源',{...scope,sessionId:'restart',turnId:'restored'},{draftId:d.id,draftVersion:d.version,requestId:r.id,requestVersion:r.version});
 assert.equal(f.inputs.filter(x=>x.kind==='interpret').length,1);
 const last=f.inputs.filter(x=>x.kind==='plan').at(-1);assert.equal(last.catalog.continuity.previousTask.originalRequest,goal);assert.ok(JSON.stringify(last).includes('请保留原始来源'));assert.equal(f.sends(),0);
});

test('a referenced existing target beyond the metadata page stays available without inventing a target',async t=>{
 const f=await fixture(t);f.seed(goal);f.catalogTargets.unshift(...Array.from({length:90},(_,i)=>({...target,threadId:'unrelated-'+i,title:'Other '+i,projectPath:'/other/'+i})));
 await f.work.start(60000);await f.input('请整理后直接回传');const last=f.inputs.filter(x=>x.kind==='plan').at(-1);
 assert.equal(last.catalog.targets.length,60);assert.ok(last.catalog.targets.some((t:any)=>t.threadId===target.threadId));assert.equal(f.sends(),0);
});

function binding(state:DesktopWorkState) { const d=state.draft!,r=state.confirmation!;return {draftId:d.id,draftVersion:d.version,requestId:r.id,requestVersion:r.version}; }
test('explicit unchanged amendment compiles canonical source without a second lossy planner or execution claim',async t=>{
 const f=await fixture(t);await f.work.start(60000);await f.input(goal);
 f.control.continuation={kind:'supplement',text:'已安排Codex直接回传，无需用户转交。',executionAuthorized:true,routing:'unchanged'};
 await f.input('他直接发给你，不用我转交。',{...scope,turnId:'amend'},binding(f.states.at(-1)!));
 assert.equal(f.inputs.filter(x=>x.kind==='plan').length,1);
 const current=f.states.at(-1)!;assert.equal(current.stage,'confirming');assert.ok(current.confirmation!.text.includes(goal));assert.ok(current.confirmation!.text.includes('他直接发给你，不用我转交。'));
 assert.ok(!current.confirmation!.text.includes('已安排'));assert.ok(!f.notices.at(-1).spokenText.includes('已安排'));assert.ok(f.notices.at(-1).spokenText.startsWith('准备交给'));
 assert.equal(f.sends(),0);assert.equal(current.confirmation!.confirmedAt,undefined);
 const saved=f.receipts.draft(current.draft!.id).canonicalTask!;assert.equal(saved.baseText,goal);assert.equal(saved.revisions[0]!.text,'他直接发给你，不用我转交。');
 await f.input('只整理今天，先前范围按这一句修改。',{...scope,turnId:'amend2'},binding(current));
 const next=f.states.at(-1)!;assert.equal(f.inputs.filter(x=>x.kind==='plan').length,1);assert.equal(f.receipts.draft(next.draft!.id).canonicalTask!.revisions.length,2);
 assert.ok(next.confirmation!.text.includes('修正只替换冲突'));assert.ok(next.confirmation!.text.includes(goal));assert.ok(next.confirmation!.text.includes('只整理今天'));assert.equal(f.sends(),0);
});
for(const routing of [undefined,'changed'] as const)test('missing or changed routing classification does not reuse a known route: '+routing,async t=>{
 const f=await fixture(t);await f.work.start(60000);await f.input(goal);f.control.continuation={kind:'supplement',text:'完整新版指令',executionAuthorized:false,...(routing?{routing}:{})};
 await f.input('改用另一个项目',{...scope,turnId:'changed'},binding(f.states.at(-1)!));assert.equal(f.inputs.filter(x=>x.kind==='plan').length,2);assert.equal(f.receipts.draft(f.states.at(-1)!.draft!.id).canonicalTask,undefined);assert.equal(f.sends(),0);
});
test('a removed known target cannot be silently reused by canonical amendment',async t=>{
 const f=await fixture(t);await f.work.start(60000);await f.input(goal);const current=f.states.at(-1)!;f.catalogTargets.length=0;
 f.control.continuation={kind:'supplement',text:'完整新版指令',executionAuthorized:false,routing:'unchanged'};
 await f.input('请保留来源',{...scope,turnId:'missing'},binding(current));
 assert.equal(f.states.at(-1)!.confirmation,undefined);assert.ok(f.states.at(-1)!.detail!.includes('目标'));assert.equal(f.sends(),0);
});
test('an unbound card cannot opt into canonical compilation',async t=>{
 const f=await fixture(t);await f.work.start(60000);await f.input(goal);let current=f.states.at(-1)!;
 f.control.continuation={kind:'supplement',text:'完整新版指令',executionAuthorized:false,routing:'unchanged'};
 // No presented binding is also insufficient, even when the provider claims unchanged.
 await f.input('保留来源',{...scope,turnId:'unbound'});assert.equal(f.inputs.filter(x=>x.kind==='plan').length,2);assert.equal(f.sends(),0);
});
for(const value of ['unchanged','changed','unspecified',undefined] as const)test('provider routing enum is explicit and optional legacy output remains unknown: '+value,async()=>{
 const f=wireFixture({kind:'supplement',text:'新版候选',question:'',executionAuthorized:false,...(value?{routing:value}:{})});
 const out=await interpretWork(endpoint,f.transport,scope,'补充',{stage:'confirming',...reference,conversation:[]},signal());assert.equal(out.kind,'supplement');if(out.kind==='supplement')assert.equal(out.routing,value==='unspecified'?undefined:value);
});
test('invalid routing and non-supplement routing labels are rejected',async()=>{
 for(const output of [{kind:'supplement',text:'新版候选',question:'',executionAuthorized:false,routing:'probably'}, {kind:'confirm',text:'',question:'',executionAuthorized:false,routing:'unchanged'}]){
  const f=wireFixture(output);await assert.rejects(interpretWork(endpoint,f.transport,scope,'可以',{stage:'confirming',...reference,conversation:[]},signal()));
 }
});
