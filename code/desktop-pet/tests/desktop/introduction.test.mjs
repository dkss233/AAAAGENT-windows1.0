import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';
const opening={id:'opening-v1',text:'有些记忆像被雾遮住了。不过，能再次和你说话，还是很安心。'};
const acks=a=>a.wire().filter(m=>m.value.message.command?.type==='acknowledge_introduction');
const frames=a=>{a.frame();a.frame();a.frame()};
async function ready(){const a=await app();a.changed(1);await a.ready(1,'s1','companion',opening);return a}
test('hidden introduction is not consumed; visible opening is acknowledged once without conversation or devices',async()=>{
 const a=await ready();frames(a);assert.equal(a.wire().length,0);
 a.node('open').onclick();assert.equal(acks(a).length,0);a.frame();assert.equal(acks(a).length,0);a.frame();
 assert.equal(acks(a).length,1);assert.equal(acks(a)[0].value.message.command.introductionId,opening.id);
 assert.match(a.node('introduction').textContent,/虚构设定/);assert.equal(a.node('introduction').className,'introduction');
 assert.equal(a.node('reply').children.filter(n=>n.className?.includes('chat-row')).length,0);
 assert.equal(a.harness.captureOpens,0);assert.equal(a.harness.playback,undefined);
 a.node('close').onclick();a.node('open').onclick();frames(a);assert.equal(a.wire().length,1);
});
test('closing or hiding the page before paint leaves the opening unacknowledged',async()=>{
 const a=await ready();a.node('open').onclick();a.frame();a.node('close').onclick();frames(a);assert.equal(acks(a).length,0);
 a.document.hidden=true;a.node('open').onclick();frames(a);assert.equal(acks(a).length,0);
 a.document.hidden=false;a.listeners.get('visibilitychange')();frames(a);assert.equal(acks(a).length,1);
});
test('an opening outside the visible log area is not acknowledged until it scrolls into view',async()=>{
 const a=await ready();a.node('introduction').getBoundingClientRect=()=>({left:0,right:300,top:-200,bottom:-100,width:300,height:100});
 a.node('open').onclick();frames(a);assert.equal(acks(a).length,0);
 a.node('introduction').getBoundingClientRect=()=>({left:0,right:300,top:0,bottom:100,width:300,height:100});
 a.emit(a.node('conversation'),'scroll');frames(a);assert.equal(acks(a).length,1);
});
test('reconnect discards stale display callbacks and can acknowledge an opening not persisted by the backend',async()=>{
 const a=await ready();a.node('open').onclick();a.frame();a.changed(1,'disconnected');a.changed(2);frames(a);assert.equal(acks(a).length,0);
 await a.ready(2,'s2','companion',opening);frames(a);assert.equal(acks(a).length,1);assert.equal(acks(a)[0].value.generation,2);
 a.changed(2,'disconnected');a.changed(3);await a.ready(3,'s3');frames(a);assert.equal(acks(a).length,1);
 assert.ok(!a.node('reply').textContent.includes(opening.text));
});
test('opening acknowledgement does not reset a live input turn or forge a message',async()=>{
 const a=await ready();a.node('text').value='今天想聊聊';a.node('form').onsubmit({preventDefault(){}});
 const scope={characterId:'companion',sessionId:'s1',turnId:'t',generation:1};
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'text',startedAt:''}}},1);
 a.node('open').onclick();frames(a);assert.equal(a.node('status').textContent,'正在想怎么回应你…');
 assert.equal(acks(a).length,1);assert.equal(a.wire().filter(m=>m.value.message.command?.type==='submit_text').length,1);
 assert.equal(a.node('reply').children.filter(n=>n.className==='chat-row user').length,1);
});
