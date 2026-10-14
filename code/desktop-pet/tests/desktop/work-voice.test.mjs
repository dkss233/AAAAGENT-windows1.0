import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';
const scope={characterId:'companion',sessionId:'s1',turnId:'voice',generation:1};
const original={...scope,sessionId:'saved',turnId:'original'};
const draft={id:'draft-a',version:3,text:'整理演示项目',projects:[],targets:[]};
const confirmation={id:'request-a',version:7,phase:'awaiting_confirmation',executor:'harness',text:'核对演示资料',createdAt:''};
const source={draftId:draft.id,scope:original,text:draft.text,provenance:'original_input'};
const snapshot=(sequence,extra={})=>({sequence,stage:'confirming',focus:'work',draft,confirmation,sourceInput:source,requests:[],...extra});
const receive=(a,message)=>a.bridge.receive(message,1);
const state=(a,s)=>receive(a,{channel:'work_state',state:s});
const event=(a,e)=>receive(a,{channel:'event',event:e});
const commands=a=>a.wire().map(x=>x.value.message).filter(m=>m.channel==='command').map(m=>m.command);
const actions=a=>a.wire().map(x=>x.value.message).filter(m=>m.channel==='work_action').map(m=>m.action);
const plain=v=>JSON.parse(JSON.stringify(v));
async function setup(extra={}){const a=await app({explicitRouting:true});a.changed(1);await a.ready();await state(a,snapshot(1,extra));a.node('work-reopen').onclick();return a;}
function down(a){a.bridge.hotkeyConfig('Space');a.listeners.get('keydown')({key:' ',code:'Space',target:{tagName:'BODY'},preventDefault(){},stopPropagation(){}});}

test('PTT freezes the displayed request version and keeps its card; transcript never triggers a second frontend confirm',async()=>{
 const a=await setup();down(a);const sent=commands(a).find(c=>c.type==='start_voice');assert.deepEqual(plain(sent.workBinding),{draftId:'draft-a',draftVersion:3,requestId:'request-a',requestVersion:7});assert.equal(a.node('work-card').hidden,false);
 await event(a,{type:'turn',input:{kind:'voice',scope,startedAt:''}});await event(a,{type:'transcript',scope,text:'确认，按这个安排执行'});assert.match(a.node('reply').textContent,/确认，按这个安排执行/);
 await state(a,snapshot(2,{confirmation:{...confirmation,version:8,text:'已变更的安排'}}));assert.equal(sent.workBinding.requestVersion,7);
 await receive(a,{channel:'input_route',scope,route:'work'});assert.equal(a.node('work-card').hidden,false);assert.match(a.node('reply').textContent,/确认，按这个安排执行/);assert.equal(actions(a).filter(x=>x.type==='confirm').length,0);
 await state(a,snapshot(3,{stage:'working',confirmation:{...confirmation,phase:'accepted',confirmedAt:'now'},pendingCount:1}));assert.match(a.node('work-badge').textContent,/已接收/);assert.equal(actions(a).filter(x=>x.type==='confirm').length,0);
});

test('voice answer retains same draft, source and ordered task dialogue without stealing focus',async()=>{
 const a=await setup({stage:'clarifying',confirmation:undefined,draft:{...draft,question:'只核对标题吗？'}});let focus=0;a.node('work-clarify-text').focus=()=>focus++;down(a);assert.deepEqual(plain(commands(a).find(c=>c.type==='start_voice').workBinding),{draftId:'draft-a',draftVersion:3});
 await event(a,{type:'turn',input:{kind:'voice',scope,startedAt:''}});await event(a,{type:'transcript',scope,text:'还要核对日期'});assert.match(a.node('reply').textContent,/还要核对日期/);
 const conversation=[{role:'user',text:draft.text,scope:original},{role:'assistant',text:'只核对标题吗？',scope:original},{role:'user',text:'还要核对日期',scope}];
 await state(a,snapshot(2,{draft:{...draft,version:4,text:'核对标题和日期'},sourceInput:{...source,conversation}}));await receive(a,{channel:'input_route',scope,route:'work'});
 assert.equal(a.node('work-card').hidden,false);assert.match(a.node('work-conversation').textContent,/整理演示项目.*只核对标题吗.*还要核对日期/);assert.doesNotMatch(a.node('reply').textContent,/只核对标题吗/);assert.match(a.node('reply').textContent,/整理演示项目/);assert.equal(focus,0);
 a.node('work-hide').onclick();a.node('work-reopen').onclick();assert.match(a.node('work-conversation').textContent,/还要核对日期/);assert.equal(actions(a).filter(x=>x.type==='confirm').length,0);
});

test('pending, edited, cancelled or already sent cards supply no confirmation binding',async()=>{
 for(const mode of ['cancelled','pending','edited','sent','background']){const a=await setup();if(mode==='cancelled')a.node('stop').onclick();if(mode==='pending')a.node('work-confirm').onclick();if(mode==='edited')a.node('work-edit').onclick();if(mode==='sent')await state(a,snapshot(2,{confirmation:{...confirmation,confirmedAt:'now',phase:'accepted'}}));if(mode==='background')await state(a,snapshot(2,{stage:'working',confirmation:undefined}));down(a);assert.equal(commands(a).find(c=>c.type==='start_voice').workBinding,undefined,mode);}
});

test('typing retains the visible pending arrangement until submit, while ordinary companion routing collapses it',async()=>{
 const a=await setup();a.node('text').value='先别执行，我再想一下';a.node('text').oninput();assert.equal(a.node('work-card').hidden,false);a.node('form').onsubmit({preventDefault(){}});const sent=commands(a).find(c=>c.type==='submit_text');assert.equal(sent.workBinding.requestVersion,7);
 await event(a,{type:'turn',input:{kind:'text',scope,startedAt:''}});await receive(a,{channel:'input_route',scope,route:'companion'});assert.equal(a.node('work-card').hidden,true);assert.equal(actions(a).filter(x=>x.type==='confirm').length,0);
});

test('reconnect recovers only selected task dialogue and background changes do not append old conversation',async()=>{
 const conversation=[{role:'assistant',text:'已保存的澄清问题',scope:original},{role:'user',text:'已保存的回答',scope:original}];const a=await setup({sourceInput:{...source,conversation}});a.changed(1,'disconnected');a.changed(2);await a.ready(2,'s2');await a.bridge.receive({channel:'work_state',state:snapshot(1,{focus:'companion',sourceInput:{...source,conversation}})},2);assert.equal(a.node('work-card').hidden,true);assert.doesNotMatch(a.node('reply').textContent,/已保存的回答/);a.node('work-reopen').onclick();assert.match(a.node('work-conversation').textContent,/已保存的澄清问题.*已保存的回答/);
 await a.bridge.receive({channel:'work_state',state:snapshot(2,{sourceInput:{...source,draftId:'other-selected',conversation:[]}})},2);assert.equal(a.node('work-card').textContent.includes('已保存的澄清问题'),false);
});

test('last displayed binding survives collapse/close, but hidden new versions and never-shown cards do not bind',async()=>{
 for(const mode of ['collapse','close','new-version','never-shown']){let a;if(mode==='never-shown'){a=await app({explicitRouting:true});a.changed(1);await a.ready();await state(a,snapshot(1));}else{a=await setup();if(mode==='close')a.node('close').onclick();else a.node('work-hide').onclick();if(mode==='new-version')await state(a,snapshot(2,{confirmation:{...confirmation,version:8}}));}down(a);const b=commands(a).find(c=>c.type==='start_voice').workBinding;if(['collapse','close'].includes(mode))assert.equal(b.requestVersion,7,mode);else assert.equal(b,undefined,mode);}
});

test('only completely played trusted arrangement binds a never-shown card; interruptions and changed versions do not',async()=>{
 for(const mode of ['complete','interrupted','changed','no-start']){const a=await app({explicitRouting:true});a.changed(1);await a.ready();await state(a,snapshot(1));const binding={draftId:'draft-a',draftVersion:3,requestId:'request-a',requestVersion:7};
 await receive(a,{channel:'work_speech',event:{state:'start',noticeId:'arrangement',scope,inputEpoch:0,workBinding:binding}});
 const playing=receive(a,{channel:'play',requestId:'spoken-plan',tts:{scope,audio:{id:'plan-a'}},audioBase64:'AQI='});await Promise.resolve();
 if(mode!=='no-start')a.harness.playback.emit({type:'started',audioId:'plan-a',at:''});
 if(mode==='changed')await state(a,snapshot(2,{confirmation:{...confirmation,version:8}}));
 if(mode==='interrupted')a.node('stop').onclick();else{a.harness.playback.emit({type:'ended',at:''});a.harness.playback.session.stop();}await playing;
 down(a);const b=commands(a).find(c=>c.type==='start_voice').workBinding;if(mode==='complete')assert.deepEqual(plain(b),binding);else assert.equal(b,undefined,mode);
 }
});
