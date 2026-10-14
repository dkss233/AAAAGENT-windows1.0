import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';
test('Space uses actual audio readiness, reports timing only for its active capture and submits zero camera frames',async()=>{
 const a=await app();a.changed(1);await a.ready();a.bridge.hotkeyConfig({code:'Space'});a.bridge.hotkeyEvent({type:'down',code:'Space'});
 const scope={characterId:'companion',sessionId:'s1',turnId:'ptt-onset',generation:1};await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'voice',startedAt:''}}},1);
 const opening=a.bridge.receive({channel:'capture_start',requestId:'start',scope},1);
 assert.match(a.node('status').textContent,/准备麦克风/);assert.doesNotMatch(a.node('status').textContent,/摄像头/);
 a.harness.captureDiagnostic({phase:'first_pcm',elapsedMs:12,firstBlockSampleCount:128,flushedSampleCount:0});
 a.harness.openCapture({stop(){},async finish(){return {audio:Uint8Array.of(1,2),images:[],captureStoppedAt:'2026-09-12T00:00:00Z'}}});await opening;
 assert.ok(a.wire().some(m=>m.value.message.channel==='ack'));assert.match(a.node('status').textContent,/正在听/);
 a.bridge.hotkeyEvent({type:'up',code:'Space'});assert.equal(a.wire().at(-1).value.message.command.type,'finish_voice');
 await a.bridge.receive({channel:'capture_finish',requestId:'finish',scope},1);assert.equal(a.wire().at(-1).value.message.result.images.length,0);
 const timing=()=>a.messages.filter(m=>m.name==='diagnostic'&&m.value.type==='capture-timing');assert.equal(timing().length,1);assert.equal(timing()[0].value.firstBlockSampleCount,128);assert.ok(timing()[0].value.requestElapsedMs>=0);
 a.harness.captureDiagnostic({phase:'first_pcm',elapsedMs:99,firstBlockSampleCount:128,flushedSampleCount:0});assert.equal(timing().length,1,'late inactive capture cannot emit current-turn timing');
});
