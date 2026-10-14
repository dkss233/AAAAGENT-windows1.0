import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';

// Actual renderer and card; only the existing harness's device adapters and DOM
// geometry are controlled. Real painting is checked separately with WebKit.
const task={id:'native-a',projectId:'project-a',provider:'codex',origin:'t3',environmentId:'env-a',
 t3ProjectId:'t3-project-a',threadId:'thread-a',providerInstanceId:'codex'};
const other={...task,id:'native-b',threadId:'thread-b'};
const origin={channel:'desktop',channelSessionId:'desktop-primary',messageId:'raw-a'};
const raw='请先核对文档，不改文件。';
const draft={id:'draft-a',version:1,commandId:'original-command',state:'open',task,
 input:{inputId:origin.messageId,origin,rawText:raw,dispatchText:raw,createdAt:'2026-10-04T00:00:00Z'}};
const binding=(revision=1,version=1)=>({version:'0.1.0',projectId:task.projectId,taskId:task.id,
 focusRevision:revision,draftId:draft.id,draftVersion:version,commandId:draft.commandId});
const state=(sequence=1,change={})=>({version:'0.1.0',sequence,readAvailable:true,dispatchEnabled:true,
 focus:{version:'0.1.0',revision:1,projectId:task.projectId,task},projects:[{id:task.projectId,name:'测试项目'}],
 projectsTruncated:false,tasks:[{task,projection:null},{task:other,projection:null}],drafts:[draft],draftsTruncated:false,
 selectedDraftId:draft.id,command:{commandId:draft.commandId,state:'recorded',task},voiceBinding:binding(),...change});
const receive=(a,s)=>a.bridge.receive({channel:'workbench_state',state:s},1);
const commands=a=>a.wire().filter(r=>r.value.message.channel==='command').map(r=>r.value.message.command);
const actions=a=>a.wire().filter(r=>r.value.message.channel==='workbench_action').map(r=>r.value.message.action);
const plain=value=>JSON.parse(JSON.stringify(value));
async function setup(){const a=await app({explicitRouting:true});
 // The shared minimal DOM has separate root nodes; reproduce the production
 // dialog parentage rather than weakening the renderer's containment check.
 a.node('workbench-dialog').append(a.node('workbench-content'),a.node('workbench-footer'),a.node('workbench-close'));
 a.node('workbench-source').querySelector=()=>null;
 a.changed(1);await a.ready();a.bridge.hotkeyConfig('Space');return a;}
function layout(a){const ids=['workbench-draft-raw','workbench-draft-body',
 ...(a.node('workbench-conversation').children??[]).filter(n=>n.id?.startsWith('workbench-draft-dialogue-')).map(n=>n.id)];
 for(const id of ids){const pre=a.node(id);for(const [key,value] of Object.entries({clientWidth:300,scrollWidth:300,clientHeight:100,scrollHeight:100,scrollTop:0}))
  if(pre[key]===undefined)pre[key]=value;}}
function painted(a){layout(a);a.frame();a.frame();}
function scroll(a,pre,top){pre.scrollTop=top;a.emit(a.node('workbench-content'),'scroll',{target:pre});painted(a);}
function voice(a){a.listeners.get('keydown')({key:' ',code:'Space',target:{tagName:'BODY'},preventDefault(){},stopPropagation(){}});
 const sent=commands(a).filter(c=>c.type==='start_voice').at(-1),generation=a.testGeneration??1;
 // Finish this controlled input lifecycle via an actual scoped failure receipt,
 // without opening a capture adapter or cancelling the draft's displayed state.
 const scope={characterId:'companion',sessionId:generation===1?'s1':'s2',turnId:sent.clientRequestId,generation:a.inputGeneration=(a.inputGeneration??0)+1};
 a.bridge.receive({channel:'event',event:{type:'turn',input:{kind:'voice',scope,startedAt:''}}},generation);
 a.bridge.receive({channel:'event',event:{type:'error',scope,message:'受控采集未启用'}},generation);
 return sent;}
function text(a,value='再加一项日期核对'){a.node('text').value=value;a.node('form').onsubmit({preventDefault(){}});
 return commands(a).filter(c=>c.type==='submit_text').at(-1);}

test('native card automatically opens; neither receipt nor first frame grants a binding',async()=>{
 for(const frames of [0,1,2]){const a=await setup();await receive(a,state());assert.equal(a.node('workbench-dialog').open,true);
  assert.match(a.node('workbench-content').textContent,/请先核对文档/);layout(a);for(let i=0;i<frames;i++)a.frame();
  const sent=voice(a);assert.ok(sent,'PTT works while native dialog is open');
  assert.equal(sent.workBinding,undefined);if(frames===2)assert.deepEqual(plain(sent.workbenchBinding),binding());else assert.equal(sent.workbenchBinding,undefined);
  assert.equal(a.harness.captureOpens,0);assert.equal(actions(a).length,0);
 }
});
test('text and voice attach one exact native binding, never the visible generic binding',async()=>{
 for(const kind of ['text','voice']){const a=await setup();await a.bridge.receive({channel:'work_state',state:{sequence:1,stage:'clarifying',focus:'work',
  draft:{id:'generic',version:3,text:'旧卡片',projects:[],targets:[]},requests:[]}},1);a.node('work-reopen').onclick();
  await receive(a,state());painted(a);const sent=kind==='text'?text(a):voice(a);
  assert.deepEqual(plain(sent.workbenchBinding),binding());assert.equal(sent.workBinding,undefined);assert.equal(actions(a).length,0);
 }
});
test('hidden background updates and never painted new versions cannot inherit display',async()=>{
 const a=await setup();a.document.hidden=true;await receive(a,state());painted(a);assert.equal(a.node('workbench-dialog').open,undefined);
 assert.equal(voice(a).workbenchBinding,undefined);
 const b=await setup();await receive(b,state());painted(b);b.node('workbench-close').onclick();b.document.hidden=true;
 const newer={...draft,version:2,input:{...draft.input,dispatchText:'新增日期核对'}};
 await receive(b,state(2,{drafts:[newer],voiceBinding:binding(1,2)}));painted(b);assert.equal(voice(b).workbenchBinding,undefined);
});
test('same draft supplementation preserves raw input and ordered dialogue; rebinds only after painting v2',async()=>{
 const a=await setup();await receive(a,state());painted(a);const first=text(a,'还要核对日期');assert.deepEqual(plain(first.workbenchBinding),binding());
 const conversation=[{role:'user',text:raw,origin},{role:'assistant',text:'需要核对日期吗？',origin},
  {role:'user',text:'还要核对日期',origin:{...origin,messageId:'supplement'}}];
 const newer={...draft,version:2,input:{...draft.input,dispatchText:'核对原文和日期，不修改。',conversation}};
 await receive(a,state(2,{drafts:[newer],voiceBinding:binding(1,2)}));assert.equal(voice(a).workbenchBinding,undefined);
 painted(a);a.node('stop').onclick();a.node('workbench-open').onclick();painted(a);
 assert.deepEqual(plain(voice(a).workbenchBinding),binding(1,2));assert.equal(first.workbenchBinding.draftVersion,1);
 assert.match(a.node('workbench-conversation').textContent,/需要核对日期吗？.*还要核对日期/);
 assert.match(a.node('workbench-draft').textContent,/用户原话.*请先核对文档.*待派发完整正文.*核对原文和日期/);
 assert.equal(actions(a).filter(x=>x.type==='prepare'||x.type==='confirm').length,0);
});
test('focus A→B→A revokes the original binding even when native identity returns',async()=>{
 const a=await setup();await receive(a,state());painted(a);const first=voice(a);
 await receive(a,state(2,{focus:{version:'0.1.0',revision:2,projectId:task.projectId,task:other},drafts:[],selectedDraftId:null,voiceBinding:undefined}));
 assert.equal(voice(a).workbenchBinding,undefined);
 await receive(a,state(3,{focus:{version:'0.1.0',revision:3,projectId:task.projectId,task},voiceBinding:binding(3)}));
 assert.equal(voice(a).workbenchBinding,undefined);painted(a);assert.deepEqual(plain(voice(a).workbenchBinding),binding(3));assert.equal(first.workbenchBinding.focusRevision,1);
});
test('cancel, claimed, unknown, malformed binding and backend ready revoke display',async()=>{
 for(const mode of ['cancel','claimed','unknown','malformed','ready','source']){const a=await setup();await receive(a,state());painted(a);
  if(mode==='cancel'){a.node('stop').onclick();await receive(a,state(2));painted(a);}
  if(mode==='claimed')await receive(a,state(2,{drafts:[{...draft,state:'claimed'}],voiceBinding:undefined}));
  if(mode==='unknown')await receive(a,state(2,{command:{commandId:draft.commandId,state:'unknown',task}}));
  if(mode==='malformed')await receive(a,state(2,{voiceBinding:{...binding(),commandId:'wrong-command'}}));
  if(mode==='ready'){a.changed(1,'disconnected');a.changed(2);await a.ready(2,'s2');a.testGeneration=2;}
  if(mode==='source')await receive(a,state(2,{drafts:[{...draft,input:{...draft.input,dispatchText:'正文已变化'}}]}));
  assert.equal(voice(a).workbenchBinding,undefined,mode);
 }
});
test('closing a fully shown unchanged card retains its binding; closing before paint does not',async()=>{
 for(const show of [false,true]){const a=await setup();await receive(a,state());if(show)painted(a);a.node('workbench-close').onclick();painted(a);
  const sent=voice(a);if(show)assert.deepEqual(plain(sent.workbenchBinding),binding());else assert.equal(sent.workbenchBinding,undefined);
 }
});
test('manual confirm remains one attempt; unknown receipt only reads the original command',async()=>{
 const a=await setup();await receive(a,state());painted(a);a.node('workbench-confirm').onclick();a.node('workbench-confirm').onclick();
 assert.deepEqual(plain(actions(a)),[{type:'confirm',draftId:draft.id,expectedVersion:1}]);assert.equal(voice(a).workbenchBinding,undefined);
 await receive(a,state(2,{command:{commandId:draft.commandId,state:'unknown',task}}));painted(a);a.node('workbench-confirm').onclick();
 a.node('workbench-refresh').onclick();assert.deepEqual(plain(actions(a)),[{type:'confirm',draftId:draft.id,expectedVersion:1},{type:'refresh'}]);
});
test('changing the displayed source to the original generic card revokes native binding',async()=>{
 const a=await setup();await a.bridge.receive({channel:'work_state',state:{sequence:1,stage:'clarifying',focus:'work',
  draft:{id:'generic',version:3,text:'旧卡片原话',projects:[],targets:[]},requests:[]}},1);
 await receive(a,state());painted(a);assert.deepEqual(plain(voice(a).workbenchBinding),binding());
 a.node('work-reopen').onclick();const generic=voice(a);assert.equal(generic.workbenchBinding,undefined);
 assert.deepEqual(plain(generic.workBinding),{draftId:'generic',draftVersion:3});
 await receive(a,state(2));painted(a);assert.equal(voice(a).workbenchBinding,undefined,'background readback does not undo source choice');
 a.node('workbench-open').onclick();assert.equal(voice(a).workbenchBinding,undefined);painted(a);
 const native=voice(a);assert.deepEqual(plain(native.workbenchBinding),binding());assert.equal(native.workBinding,undefined);
});
test('a card outside the scroll viewport cannot acquire its first displayed binding',async()=>{
 const a=await setup();await receive(a,state());const body=a.node('workbench-draft-body'),rect=body.getBoundingClientRect;
 body.getBoundingClientRect=()=>({top:500,bottom:600,left:0,right:300,width:300,height:100});
 painted(a);assert.equal(voice(a).workbenchBinding,undefined);
 body.getBoundingClientRect=rect;a.emit(a.node('workbench-content'),'scroll');assert.equal(voice(a).workbenchBinding,undefined);
 painted(a);assert.deepEqual(plain(voice(a).workbenchBinding),binding(),'scrolling into view still needs a paint boundary');
});
test('a long body requires all actually scrolled intervals; header and bottom alone leave a gap',async()=>{
 const a=await setup();await receive(a,state());const body=a.node('workbench-draft-body'),rect=body.getBoundingClientRect;
 body.scrollHeight=500;body.getBoundingClientRect=()=>({top:500,bottom:600,left:0,right:300,width:300,height:100});
 painted(a);assert.equal(voice(a).workbenchBinding,undefined,'only card header/raw were visible');
 assert.equal(a.node('workbench-confirm').disabled,true);a.node('workbench-confirm').onclick();assert.equal(actions(a).length,0);
 body.getBoundingClientRect=rect;scroll(a,body,0);assert.equal(voice(a).workbenchBinding,undefined,'body top is insufficient');
 scroll(a,body,400);assert.equal(voice(a).workbenchBinding,undefined,'jumping to body bottom leaves unshown middle');
 for(const top of [100,200,300])scroll(a,body,top);
 assert.deepEqual(plain(voice(a).workbenchBinding),binding());assert.equal(a.node('workbench-confirm').disabled,false);
});
test('new body and new dialogue need actual presentation; readback does not reset in-progress scrolling',async()=>{
 const a=await setup();await receive(a,state());painted(a);assert.deepEqual(plain(voice(a).workbenchBinding),binding());
 const newer={...draft,version:2,input:{...draft.input,dispatchText:'新版完整正文',conversation:[{role:'user',text:'新增要求',origin:{...origin,messageId:'new-answer'}}]}};
 const next=state(2,{drafts:[newer],voiceBinding:binding(1,2)});await receive(a,next);
 let body=a.node('workbench-draft-body'),answer=a.node('workbench-draft-dialogue-0');body.scrollHeight=500;
 const rect=body.getBoundingClientRect;body.getBoundingClientRect=answer.getBoundingClientRect=()=>({top:500,bottom:600,left:0,right:300,width:300,height:100});
 painted(a);assert.equal(voice(a).workbenchBinding,undefined,'v1 presentation does not cover v2 body or new answer');
 answer.getBoundingClientRect=rect;scroll(a,answer,0);assert.equal(voice(a).workbenchBinding,undefined,'new answer alone does not show dispatch body');
 body.getBoundingClientRect=rect;scroll(a,body,0);scroll(a,body,100);
 await receive(a,{...next,sequence:3});body=a.node('workbench-draft-body');body.scrollHeight=500;layout(a);
 assert.equal(body.scrollTop,100,'same-version readback preserves inner scroll position');painted(a);
 assert.equal(voice(a).workbenchBinding,undefined);for(const top of [200,300,400])scroll(a,body,top);
 assert.deepEqual(plain(voice(a).workbenchBinding),binding(1,2));
});
test('version/focus changes between frames discard old long-body progress and cannot combine versions',async()=>{
 const a=await setup();await receive(a,state());let body=a.node('workbench-draft-body');body.scrollHeight=500;painted(a);scroll(a,body,100);
 body.scrollTop=200;a.emit(a.node('workbench-content'),'scroll');a.frame();
 const newer={...draft,version:2,input:{...draft.input,dispatchText:'不同版本正文'}};
 await receive(a,state(2,{drafts:[newer],voiceBinding:binding(1,2)}));body=a.node('workbench-draft-body');body.scrollHeight=500;body.scrollTop=400;painted(a);
 assert.equal(voice(a).workbenchBinding,undefined,'old partial intervals cannot fill new version');
 await receive(a,state(3,{focus:{version:'0.1.0',revision:2,projectId:task.projectId,task:other},drafts:[],selectedDraftId:null,voiceBinding:undefined}));
 await receive(a,state(4,{focus:{version:'0.1.0',revision:3,projectId:task.projectId,task},drafts:[newer],voiceBinding:binding(3,2)}));
 body=a.node('workbench-draft-body');body.scrollHeight=500;body.scrollTop=400;painted(a);assert.equal(voice(a).workbenchBinding,undefined);
 for(const top of [0,100,200,300])scroll(a,body,top);assert.deepEqual(plain(voice(a).workbenchBinding),binding(3,2));
});
test('a scroll position that changes across the paint boundary grants no coverage',async()=>{
 const a=await setup();await receive(a,state());const body=a.node('workbench-draft-body'),rect=body.getBoundingClientRect;
 body.scrollHeight=500;body.getBoundingClientRect=()=>({top:500,bottom:600,left:0,right:300,width:300,height:100});painted(a);
 body.getBoundingClientRect=rect;body.scrollTop=100;a.emit(a.node('workbench-content'),'scroll');a.frame();
 body.scrollTop=200;a.frame();painted(a);
 for(const top of [0,300,400])scroll(a,body,top);
 assert.equal(voice(a).workbenchBinding,undefined,'unstable first-frame offset cannot fill the unshown interval');
 scroll(a,body,100);assert.deepEqual(plain(voice(a).workbenchBinding),binding());
});
test('native card exposes the original voice control and a focused text supplement entry',async()=>{
 const a=await setup();await receive(a,state());painted(a);a.node('workbench-voice').onclick();
 const sent=commands(a).filter(c=>c.type==='start_voice').at(-1);assert.deepEqual(plain(sent.workbenchBinding),binding());
 assert.equal(a.node('workbench-voice').textContent,'取消准备');assert.equal(a.harness.captureOpens,0);
 const b=await setup();await receive(b,state());painted(b);b.node('workbench-text').onclick();
 assert.equal(b.node('workbench-dialog').open,false);assert.equal(b.document.activeElement,b.node('text'));
 assert.deepEqual(plain(text(b).workbenchBinding),binding());
});
