import test from 'node:test';import assert from 'node:assert/strict';import {app} from '../ui-harness.mjs';
const settings={keyword:'乐正绫',sensitivity:'standard',silenceMs:1500};
const scope={characterId:'companion',sessionId:'s1',turnId:'wake-turn',generation:1};
const tick=()=>new Promise(r=>setImmediate(r));
const messages=a=>a.messages.filter(m=>m.name==='desktop').map(m=>m.value.message);
const commands=a=>messages(a).filter(m=>m.channel==='command');
async function start(){const a=await app({explicitRouting:true});a.changed(1);await a.ready();await a.bridge.receive({channel:'wake_control',generation:1,enabled:true,settings},1);await tick();const driver=a.harness.wakeDrivers[0];driver.options.onPCM(new Float32Array(512));driver.ready({echoCancellation:true});await tick();return {a,driver};}
async function ack(a,driver,speech=false,keyword){const frame=messages(a).filter(m=>m.channel==='wake_pcm').at(-1);await a.bridge.receive({channel:'wake_result',generation:1,sequence:frame.sequence,samples:512,speech,keyword},1);await tick();}
async function wakeTurn(a,driver){await ack(a,driver,true,settings.keyword);await a.bridge.receive({channel:'event',event:{type:'turn',input:{kind:'voice',scope,startedAt:''}}},1);await a.bridge.receive({channel:'capture_start',requestId:'wake-capture',scope},1);await tick();}
test('actual renderer idle never opens mic; wake begins one stream, camera only at original capture_start; silence submits once',async()=>{
 const {a,driver}=await start();assert.equal(a.harness.captureOpens,0);assert.equal(driver.clips,0);assert.equal(driver.cameras,0);assert.equal(a.node('capture-feedback').dataset.phase,'waiting');
 await ack(a,driver,true,settings.keyword);assert.equal(driver.clips,1);assert.equal(driver.cameras,0);assert.equal(commands(a).filter(m=>m.command.type==='start_voice').length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(commands(a).find(m=>m.command.type==='start_voice').command.wakeHit)),{generation:1,sequence:1});
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{kind:'voice',scope,startedAt:''}}},1);await a.bridge.receive({channel:'capture_start',requestId:'wake-capture',scope},1);assert.equal(driver.cameras,1);assert.equal(a.harness.captureOpens,0);await a.bridge.receive({channel:'capture_start',requestId:'duplicate-capture',scope},1);assert.equal(driver.cameras,1);assert.equal(a.harness.captureOpens,0);
 for(let i=0;i<48;i++){driver.options.onPCM(new Float32Array(512));await ack(a,driver);}
 assert.equal(commands(a).filter(m=>m.command.type==='finish_voice').length,1);await a.bridge.receive({channel:'capture_finish',requestId:'wake-finish',scope},1);await tick();assert.equal(messages(a).filter(m=>m.channel==='capture').length,1);assert.equal(driver.finishes,1);assert.equal(driver.closes,0);assert.equal(a.node('capture-feedback').dataset.phase,'replying');a.changed(1,'disconnected');await tick();assert.ok(driver.closes>0);
});
test('PTT cancels wake clip before opening old echo-off driver; stale KWS cannot double-start',async()=>{
 const {a,driver}=await start();await wakeTurn(a,driver);const old=messages(a).filter(m=>m.channel==='wake_pcm').at(-1);a.node('voice').onclick(); // finish existing clip as a manual action is not a second wake
 a.node('stop').onclick();await tick();assert.ok(driver.closes>0);const count=commands(a).filter(m=>m.command.type==='start_voice').length;
 await a.bridge.receive({channel:'wake_result',generation:1,sequence:old.sequence,samples:512,speech:true,keyword:settings.keyword},1);assert.equal(commands(a).filter(m=>m.command.type==='start_voice').length,count);
 a.node('voice').onclick();await a.bridge.receive({channel:'event',event:{type:'turn',input:{kind:'voice',scope:{...scope,turnId:'ptt',generation:2},startedAt:''}}},1);const p=a.bridge.receive({channel:'capture_start',requestId:'manual',scope:{...scope,turnId:'ptt',generation:2}},1);assert.equal(a.harness.captureOpens,1);a.harness.openCapture({stop(){}});await p;a.node('stop').onclick();a.changed(1,'disconnected');
});
test('backend off then same-generation error remains visible; stale frames do not revive wave or camera',async()=>{
 const {a,driver}=await start();await a.bridge.receive({channel:'wake_control',generation:2,enabled:false,settings},1);await a.bridge.receive({channel:'wake_error',generation:2,detail:'synthetic unavailable'},1);await tick();assert.equal(a.node('capture-feedback').hidden,true);assert.match(a.node('status').textContent,/唤醒已停止/);driver.options.onLevel({rms:1,peak:1});a.frame(0);assert.equal(a.node('capture-feedback').hidden,true);assert.equal(driver.cameras,0);a.changed(1,'disconnected');
});

test('wake control cannot open a stream before versioned backend readiness',async()=>{const a=await app();a.changed(1);await a.bridge.receive({channel:'wake_control',generation:1,enabled:true,settings},1);await tick();assert.equal(a.harness.wakeDrivers,undefined);a.changed(1,'disconnected');});
