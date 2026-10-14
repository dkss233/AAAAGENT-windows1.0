import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';
const scope={characterId:'companion',sessionId:'s1',turnId:'t1',generation:1};
const turn=(scope,kind='text')=>({channel:'event',event:{type:'turn',input:{scope,kind,startedAt:''}}});
const reply=scope=>({channel:'event',event:{type:'reply',reply:{scope,text:'local text',expression:{emotion:'happy',intensity:1,delivery:'',gesture:'heart'}}}});
const submit=a=>{a.node('text').value='unsent text';a.node('form').onsubmit({preventDefault(){}})};
const tick=async()=>{await Promise.resolve();await Promise.resolve()};
test('launch failure disables all commands, preserves unsent input and exposes an explicit retry',async()=>{
 const a=await app();a.changed(1);a.changed(1,'failed',{reason:'launch'});
 assert.equal(a.node('status').textContent,'对话服务连接失败');
 for(const id of ['send','voice','invitation'])assert.equal(a.node(id).disabled,true,id);
 submit(a);a.node('voice').onclick();a.node('stop').onclick();
 assert.equal(a.wire().length,0);assert.equal(a.node('text').value,'unsent text');
 assert.equal(a.node('reconnect').hidden,false);a.node('reconnect').onclick();
 assert.equal(a.messages.at(-1).value.type,'reconnect');
 await a.ready(1);assert.equal(a.node('send').disabled,true,'late ready cannot revive failed connection');
 a.changed(2);await a.ready(2,'s2');submit(a);
 assert.equal(a.wire().length,1);assert.equal(a.wire()[0].value.generation,2);
 assert.equal(a.wire()[0].value.message.command.text,'unsent text');
});
test('disconnect during playback resets presentation and ignores old ready/round/audio after reconnect',async()=>{
 const a=await app();a.changed(1);await a.ready();await a.bridge.receive(turn(scope),1);await a.bridge.receive(reply(scope),1);
 const play=a.bridge.receive({channel:'play',requestId:'p',tts:{scope,audio:{id:'a'},expression:{emotion:'happy',intensity:1,delivery:'',gesture:'heart'}},audioBase64:'AQI='},1);
 await tick();a.harness.playback.emit({type:'started',audioId:'a',at:''});
 assert.equal(a.node('status').textContent,'正在说话…');
 a.changed(1,'disconnected');await play;
 assert.ok(a.harness.playback.signal.aborted);assert.ok(a.harness.playStops>0);assert.match(a.node('reply').textContent,/local text/,'断开后保留已显示的本角色聊天');
 a.changed(2);await a.ready(2,'s2');const current={...scope,sessionId:'s2',turnId:'new'};
 await a.bridge.receive(turn(current),2);await a.bridge.receive(reply(current),2);const sent=a.wire().length;
 a.changed(1,'disconnected');await a.ready(1);await a.bridge.receive(turn({...scope,generation:100}),1);
 a.harness.playback.emit({type:'amplitude',value:1,at:''});a.harness.playback.emit({type:'ended',at:''});
 assert.match(a.node('reply').textContent,/local text/);assert.equal(a.node('status').textContent,'正在想怎么回应你…');assert.equal(a.wire().length,sent);
});
test('late capture opening from an old connection closes without sending an ack/error to the new backend',async()=>{
 const a=await app();a.changed(1);await a.ready();a.node('voice').onclick();await a.bridge.receive(turn(scope,'voice'),1);
 const opening=a.bridge.receive({channel:'capture_start',requestId:'c',scope},1);await tick();assert.equal(a.harness.captureOpens,1);
 a.changed(1,'disconnected');assert.equal(a.harness.captureSignal.aborted,true);
 a.changed(2);await a.ready(2,'s2');const sent=a.wire().length;let stops=0;
 a.harness.openCapture({stop(){stops++}});await opening;
 assert.equal(stops,1);assert.equal(a.wire().length,sent);assert.equal(a.node('status').textContent,'我在这里');
 await a.bridge.receive({channel:'capture_start',requestId:'old',scope},1);assert.equal(a.harness.captureOpens,1);
});
test('legacy and unknown backend identities cannot enter the single companion desktop',async()=>{
 for(const id of ['friend','sweetheart','unknown']){
  const a=await app();a.changed(1);await a.ready(1,'legacy',id);
  assert.equal(a.node('send').disabled,true);assert.equal(a.messages.at(-1).value.type,'disconnect');
 }
 const a=await app();a.changed(1);await a.ready();
 await a.bridge.receive({channel:'character_changed',characterId:'sweetheart',sessionId:'old'},1);
 await a.bridge.receive(turn({...scope,characterId:'sweetheart'}),1);
 assert.equal(a.node('status').textContent,'我在这里');assert.equal(a.wire().length,0);
});
test('protocol mismatch stays failed and stops the native connection',async()=>{
 const a=await app();a.changed(1);await a.bridge.receive({channel:'backend_ready',bridgeVersion:'wrong'},1);
 assert.match(a.node('status').textContent,/版本不一致/);assert.equal(a.node('send').disabled,true);
 assert.equal(a.messages.at(-1).value.type,'disconnect');await a.ready();assert.equal(a.node('send').disabled,true);
});

test('capture result completing after disconnect is wiped and cannot leak into the replacement connection',async()=>{
 const a=await app();a.changed(1);await a.ready();a.node('voice').onclick();await a.bridge.receive(turn(scope,'voice'),1);
 const opening=a.bridge.receive({channel:'capture_start',requestId:'c',scope},1);let finish;
 a.harness.openCapture({stop(){},finish(){return new Promise(r=>finish=r)}});await opening;
 const pending=a.bridge.receive({channel:'capture_finish',requestId:'f',scope},1);
 a.changed(1,'disconnected');a.changed(2);await a.ready(2,'s2');const sent=a.wire().length;
 const audio=new Uint8Array([1,2]),image=new Uint8Array([3]);finish({audio,images:[{bytes:image,mimeType:'image/jpeg'}],captureStoppedAt:''});await pending;
 assert.deepEqual([...audio],[0,0]);assert.deepEqual([...image],[0]);assert.equal(a.wire().length,sent);
});
