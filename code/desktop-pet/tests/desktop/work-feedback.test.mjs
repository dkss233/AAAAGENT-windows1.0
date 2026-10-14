import test from 'node:test';import assert from 'node:assert/strict';import {app} from './ui-harness.mjs';
const scope={characterId:'companion',sessionId:'s1',turnId:'work-speech',generation:1};
const originalScope={...scope,sessionId:'persisted-session',turnId:'original'};
const source={draftId:'stored-draft',scope:originalScope,text:'嗯，这是已保存的输入，和计划正文不同。',provenance:'original_input'};
const confirmation={id:'request',version:1,phase:'awaiting_confirmation',executor:'harness',text:'整理后的任务正文',createdAt:''};
const state=(sequence,extra={})=>({sequence,stage:'confirming',focus:'work',draft:{id:'stored-draft',version:1,text:source.text,projects:[],targets:[]},confirmation,sourceInput:source,requests:[],...extra});
async function ready(){const a=await app({explicitRouting:true});a.changed(1);await a.ready();return a;}
const work=(a,s)=>a.bridge.receive({channel:'work_state',state:s},1);
const speech=(a,change={})=>a.bridge.receive({channel:'work_speech',event:{noticeId:'notice',scope,inputEpoch:0,state:'start',...change}},1);
const play=a=>a.bridge.receive({channel:'play',requestId:'speech-play',tts:{scope,audio:{id:'short-state'},expression:{emotion:'neutral',intensity:0,gesture:null,delivery:''}},audioBase64:'AQI='},1);
const rows=a=>a.node('reply').children.filter(n=>n.className==='chat-row user');
test('saved source restores independently once; direct collapse/reopen preserves it without state refresh',async()=>{
 const a=await ready();await work(a,state(1));a.node('work-reopen').onclick();assert.equal(rows(a).length,1);assert.match(a.node('reply').textContent,/嗯，这是已保存的输入/);assert.doesNotMatch(a.node('reply').textContent,/整理后的任务正文/);assert.equal(a.node('work-actions').children.some(n=>n.id==='work-confirm'),true);const before=a.harness.replyRenders;a.node('work-hide').onclick();assert.ok(a.harness.replyRenders>before);assert.equal(a.node('work-card').hidden,true);assert.equal(rows(a).length,1);a.node('work-reopen').onclick();assert.equal(a.node('work-card').hidden,false);
 await work(a,state(2,{stage:'completed',draft:undefined,confirmation:undefined,activeRequestId:'request',requests:[{...confirmation,phase:'completed',result:'任务结果'}]}));assert.equal(rows(a).length,1);assert.doesNotMatch(a.node('reply').textContent,/任务结果/);a.changed(1,'disconnected');a.changed(2);await a.ready(2,'s2');await a.bridge.receive({channel:'work_state',state:state(1)},2);assert.equal(rows(a).length,1);
});
test('legacy saved input is labelled honestly and new source binds same scoped live original without duplication',async()=>{
 const a=await ready();await work(a,state(1,{sourceInput:{...source,provenance:'legacy_saved_input'}}));a.node('work-reopen').onclick();assert.match(a.node('reply').textContent,/已保存的任务输入/);assert.doesNotMatch(a.node('reply').textContent,/你的原话/);
 const b=await ready();b.node('voice').onclick();await b.bridge.receive({channel:'event',event:{type:'turn',input:{kind:'voice',scope,startedAt:''}}},1);await work(b,state(1,{sourceInput:{...source,scope}}));b.node('work-reopen').onclick();await b.bridge.receive({channel:'event',event:{type:'transcript',scope,text:source.text}},1);assert.equal(rows(b).length,1);
 await work(b,state(2,{sourceInput:{...source,draftId:'different',scope:{...scope,turnId:'another'},text:'另一个准确输入'}}));assert.equal(rows(b).length,2);await work(b,state(3,{sourceInput:{...source,scope}}));assert.equal(rows(b).length,2);assert.match(b.node('reply').textContent,/另一个准确输入/);
});
test('trusted work speech uses actual playback for mouth, never appends text; early end cannot truncate active output',async()=>{
 const a=await ready();await speech(a,{text:'任务已接收。'});const playing=play(a);await Promise.resolve();assert.equal(a.harness.playOpens,1);a.frame();assert.equal(a.harness.presented.mouth,0);a.harness.playback.emit({type:'started',audioId:'short-state',at:''});a.harness.playback.emit({type:'amplitude',value:.7,at:''});a.frame(performance.now()+40);assert.equal(a.harness.presented.state,'speaking');assert.equal(a.harness.presented.mouth,.7);assert.equal(rows(a).length,0);assert.doesNotMatch(a.node('reply').textContent,/任务已接收/);
 await speech(a,{state:'end'});assert.equal(a.harness.playback.signal.aborted,false);a.node('stop').onclick();await playing;assert.equal(a.harness.playback.signal.aborted,true);await speech(a);const stale=play(a);await stale;assert.equal(a.harness.playOpens,1);
});
test('typing and Space preempt work speech without work cancellation; old session/epoch and repeat notices cannot reopen playback',async()=>{
 for(const mode of ['typing','space','reconnect']){const a=await ready();await speech(a);const playing=play(a);await Promise.resolve();a.harness.playback.emit({type:'started',audioId:'short-state',at:''});if(mode==='typing'){a.node('text').value='新输入';a.node('text').oninput();}else if(mode==='space'){a.bridge.hotkeyConfig('Space');a.bridge.hotkeyEvent({type:'down',code:'Space',repeat:false});}else{a.changed(1,'disconnected');a.changed(2);await a.ready(2,'s2');}await playing;assert.equal(a.harness.playback.signal.aborted,true);await speech(a,{noticeId:'late'});await play(a);assert.equal(a.harness.playOpens,1);assert.equal(a.wire().filter(m=>m.value.message.channel==='work_action').length,0);}
 const b=await ready();await speech(b,{inputEpoch:8});await play(b);assert.equal(b.harness.playOpens,0);await speech(b);await speech(b,{state:'end'});await speech(b);await play(b);assert.equal(b.harness.playOpens,0);
});
test('capture driver starts before synchronous UI rebuild and timing is only emitted for accepted voice commands',async()=>{
 const a=await ready();a.node('voice').onclick();const reports=a.messages.filter(m=>m.name==='diagnostic'&&m.value.type==='capture-command-timing');assert.equal(reports.length,1);assert.equal(reports[0].value.source,'voice-button');assert.ok(reports[0].value.handlerToSendMs>=reports[0].value.handlerToCommandMs);await a.bridge.receive({channel:'event',event:{type:'turn',input:{kind:'voice',scope,startedAt:''}}},1);const before=a.harness.replyRenders;const opening=a.bridge.receive({channel:'capture_start',requestId:'capture',scope},1);assert.equal(a.harness.captureOpenReplyRenders,before);a.harness.openCapture({stop(){}});await opening;a.node('stop').onclick();
});

test('background old source stays out of current chat; explicit reopen restores it without a new state message',async()=>{
 const a=await ready();await work(a,state(1,{focus:'companion'}));assert.equal(rows(a).length,0);a.node('text').value='当前正在输入';a.node('text').oninput();await work(a,state(2,{focus:'companion',stage:'completed'}));assert.equal(rows(a).length,0);assert.equal(a.node('text').value,'当前正在输入');a.node('work-reopen').onclick();assert.equal(rows(a).length,1);a.node('work-hide').onclick();assert.equal(rows(a).length,1);a.node('work-reopen').onclick();assert.equal(rows(a).length,1);
});
test('refused speech play returns stopped with its requestId and scope, without opening audio',async()=>{
 const a=await ready();await speech(a);a.node('text').value='typing';a.node('text').oninput();const m={channel:'play',requestId:'blocked-play',tts:{scope},audioBase64:'AQI='};await a.bridge.receive(m,1);assert.equal(m.audioBase64,'');assert.equal(a.harness.playOpens,0);const out=a.wire().map(x=>x.value.message).find(x=>x.channel==='playback'&&x.requestId==='blocked-play');assert.equal(out.event.type,'stopped');assert.equal(out.event.scope.turnId,scope.turnId);
});
