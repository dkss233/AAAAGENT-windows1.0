import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';
const scope={characterId:'companion',sessionId:'s1',turnId:'voice-1',generation:1};
const ev=(a,event,g=1)=>a.bridge.receive({channel:'event',event},g);
const route=(a,route,which=scope)=>a.bridge.receive({channel:'input_route',route,scope:which},1);
async function ready(){const a=await app({explicitRouting:true});a.changed(1);await a.ready();return a;}
async function voice(a,which=scope){a.node('voice').onclick();await ev(a,{type:'turn',input:{kind:'voice',scope:which,startedAt:''}});}
const raw='嗯，请在演示项目里查一下，A 会议和 B 会议的截止日期。';
const draft={id:'draft',version:1,text:raw,projects:[],targets:[]};
const planned='查询两项会议截止日期，汇总到演示项目。';
const request={id:'request',version:1,phase:'awaiting_confirmation',executor:'harness',text:planned,createdAt:''};
const work=(a,sequence,stage,extra={})=>a.bridge.receive({channel:'work_state',state:{sequence,stage,focus:'work',draft,requests:[],...extra}},1);
const originals=a=>a.node('reply').children.filter(n=>n.className==='chat-row user');
test('ASR is visible before planning progresses; prepared/sending/completed cards never replace it',async()=>{
 const a=await ready();await voice(a);await ev(a,{type:'transcript',scope,text:raw});assert.equal(originals(a).length,1);assert.match(a.node('reply').textContent,/嗯，请在演示项目里查一下/);assert.equal(a.node('work-card').hidden,true);
 await work(a,1,'classifying');await route(a,'work');assert.equal(a.node('work-card').hidden,false);assert.equal(originals(a).length,1);
 for(const [i,stage]of ['confirming','sending','completed'].entries()){await work(a,i+2,stage,stage==='confirming'?{confirmation:request}:{draft:undefined,requests:[{...request,phase:stage==='completed'?'completed':'accepted',result:'合成工程结果'}]});assert.match(a.node('reply').textContent,/嗯，请在演示项目里查一下/);assert.doesNotMatch(a.node('reply').textContent,/查询两项会议截止日期|合成工程结果/);assert.equal(originals(a).length,1);}
 assert.equal(a.harness.playOpens,0);assert.equal(a.harness.captureOpens,0);assert.equal(a.wire().filter(x=>x.value.message.channel==='command').length,1);
});
test('ASR arriving after work view reset remains scoped and cancellation preserves an already visible original',async()=>{
 const a=await ready();await voice(a);await route(a,'work');await ev(a,{type:'transcript',scope,text:raw});await ev(a,{type:'transcript',scope,text:raw});assert.equal(originals(a).length,1);a.node('stop').onclick();assert.match(a.node('reply').textContent,/嗯，请在演示项目里查一下/);assert.doesNotMatch(a.node('reply').textContent,/语音未发送/);
 await ev(a,{type:'transcript',scope,text:'取消后不能覆盖原话'});assert.doesNotMatch(a.node('reply').textContent,/取消后不能覆盖原话/);
});
test('route failure keeps successful ASR, while canceled/new-session/old-generation ASR is ignored',async()=>{
 const a=await ready();await voice(a);await ev(a,{type:'transcript',scope,text:raw});await ev(a,{type:'error',scope,message:'整理暂未完成'});assert.match(a.node('reply').textContent,/嗯，请在演示项目里查一下/);assert.doesNotMatch(a.node('reply').textContent,/语音未发送/);
 const b=await ready();await voice(b);b.node('stop').onclick();await ev(b,{type:'transcript',scope,text:'取消后的旧原话'});assert.equal(originals(b).length,0);
 await voice(b,{...scope,turnId:'new',generation:2});await ev(b,{type:'transcript',scope,text:'旧轮迟到'});await ev(b,{type:'transcript',scope:{...scope,turnId:'new',generation:2},text:'新的原话'});assert.equal(originals(b).length,1);assert.doesNotMatch(b.node('reply').textContent,/旧轮迟到/);
 b.changed(1,'disconnected');b.changed(2);await b.ready(2,'s2');await ev(b,{type:'transcript',scope,text:'旧连接迟到'},1);assert.equal(originals(b).length,1);assert.doesNotMatch(b.node('reply').textContent,/旧连接迟到/);
});
test('release waits for transcription without fake thinking; ASR displays before thought status and original survives Space',async()=>{
 const a=await ready();await voice(a);const opening=a.bridge.receive({channel:'capture_start',requestId:'synthetic',scope},1);a.harness.openCapture({stop(){}});await opening;a.node('voice').onclick();assert.equal(a.node('status').textContent,'正在转写…');assert.equal(a.node('thinking-indicator').hidden,true);
 await ev(a,{type:'transcript',scope,text:raw});assert.match(a.node('reply').textContent,/嗯，请在演示项目里查一下/);assert.equal(a.node('status').textContent,'正在想怎么回应你…');await route(a,'work');await work(a,1,'confirming',{confirmation:request});a.bridge.hotkeyConfig('Space');a.bridge.hotkeyEvent({type:'down',code:'Space',repeat:false});assert.match(a.node('reply').textContent,/嗯，请在演示项目里查一下/);assert.equal(a.node('work-card').hidden,true);assert.equal(a.wire().filter(x=>x.value.message.channel==='work_action').length,0);
});
