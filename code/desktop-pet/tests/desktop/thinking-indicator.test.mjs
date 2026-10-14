import test from 'node:test';import assert from 'node:assert/strict';import {app} from './ui-harness.mjs';
const scope={characterId:'companion',sessionId:'s1',turnId:'t1',generation:1},expression={emotion:'neutral',intensity:0,delivery:'',gesture:null};
const event=(a,e,g=1)=>a.bridge.receive({channel:'event',event:e},g);
const turn=(a,kind='text')=>event(a,{type:'turn',input:{scope,kind,startedAt:''}});
const submit=a=>{a.node('text').value='合成等待输入';a.node('form').onsubmit({preventDefault(){}})};
const visible=(a,yes)=>assert.equal(a.node('thinking-indicator').hidden,!yes);
async function ready(){const a=await app();a.changed(1);await a.ready();return a;}
test('text waiting appears locally, survives reply/audio preparation, leaves only when output starts',async()=>{
 const a=await ready();visible(a,false);submit(a);visible(a,true);assert.equal(a.harness.captureOpens,0);await turn(a);visible(a,true);
 await event(a,{type:'reply',reply:{scope,text:'合成回复',expression}});visible(a,true);
 const playing=a.bridge.receive({channel:'play',requestId:'p',tts:{scope,audio:{id:'a'},expression},audioBase64:'AQI='},1);await Promise.resolve();visible(a,true);
 a.harness.playback.emit({type:'started',audioId:'a',at:''});visible(a,false);a.node('stop').onclick();await playing;visible(a,false);
});
test('voice listening has no spinner, release waits, failures keep error visible and stale updates cannot revive',async()=>{
 const a=await ready();a.node('voice').onclick();visible(a,false);await turn(a,'voice');
 const opening=a.bridge.receive({channel:'capture_start',requestId:'c',scope},1);a.harness.openCapture({stop(){}});await opening;visible(a,false);
 a.node('voice').onclick();visible(a,false);assert.equal(a.node('status').textContent,'正在转写…');await event(a,{type:'transcript',scope,text:'实际转写'});visible(a,true);await event(a,{type:'error',scope,message:'这段语音暂时无法播放，请重试。'});visible(a,false);assert.match(a.node('status').textContent,/无法播放/);
 await event(a,{type:'presentation',presentation:{scope,state:'thinking',expression,mouth:0}});visible(a,false);
});
test('cancel, new PTT and disconnect remove even unacknowledged text waiting',async()=>{
 for(const action of ['cancel','ptt','disconnect']){const a=await ready();submit(a);visible(a,true);
 if(action==='cancel')a.node('stop').onclick();else if(action==='ptt'){a.bridge.hotkeyConfig('Space');a.bridge.hotkeyEvent({type:'down',code:'Space',repeat:false});}else a.changed(1,'disconnected');
 visible(a,false);
 }
});
test('successful terminal state hides waiting and reconnect cannot revive an old turn',async()=>{
 const a=await ready();await turn(a);visible(a,true);await event(a,{type:'presentation',presentation:{scope,state:'idle',expression,mouth:0}});visible(a,false);
 a.changed(1,'disconnected');a.changed(2);await a.ready(2,'s2');await turn(a);visible(a,false);
});
