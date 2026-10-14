import test from 'node:test';import assert from 'node:assert/strict';import {app} from './ui-harness.mjs';
const scope={characterId:'companion',sessionId:'s1',turnId:'voice',generation:1};
async function ready(){const a=await app({explicitRouting:true});a.changed(1);await a.ready();return a;}
async function open(a,s=scope){a.node('voice').onclick();await a.bridge.receive({channel:'event',event:{type:'turn',input:{kind:'voice',scope:s,startedAt:''}}},1);const promise=a.bridge.receive({channel:'capture_start',requestId:'capture',scope:s},1);return {promise,level:a.harness.captureLevel};}
const finishOpen=async(a,p)=>{a.harness.openCapture({stop(){}});await p;};

test('accepted voice shows connection before send and never invents a waveform while waiting',async()=>{
 const a=await ready();assert.equal(a.node('capture-feedback').hidden,true);a.node('voice').onclick();assert.equal(a.harness.feedbackAtSend.hidden,false);assert.equal(a.harness.feedbackAtSend.phase,'connecting');assert.equal(a.harness.captureOpens,0);for(const at of [0,100,500])a.frame(at);assert.equal(a.node('capture-connecting').hidden,false);assert.equal(a.node('capture-wave').hidden,true);a.node('stop').onclick();assert.equal(a.node('capture-feedback').hidden,true);
});

test('first real zero PCM becomes a flat line; timing diagnostics and readiness never fabricate levels',async()=>{
 const a=await ready(),x=await open(a);a.harness.captureDiagnostic({phase:'audio_ready',elapsedMs:0,firstBlockSampleCount:128,flushedSampleCount:0,nonzeroObserved:false});a.frame(0);assert.equal(a.node('capture-wave').hidden,true);x.level({rms:NaN,peak:0});a.frame(50);assert.equal(a.node('capture-wave').hidden,true);x.level({rms:0,peak:0});a.frame(100);assert.equal(a.node('capture-wave').hidden,false);assert.equal(a.node('capture-connecting').hidden,true);const path=a.node('capture-wave-path').d;assert.match(path,/12.00/);assert.equal(path.split(/[MLZ]/).filter(Boolean).every(p=>Number(p.trim().split(/\s+/)[1])===12),true);await finishOpen(a,x.promise);a.node('stop').onclick();
});

test('real levels update locally at no more than20fps and stop moving without new PCM',async()=>{
 const a=await ready(),x=await open(a);await finishOpen(a,x.promise);const messages=a.messages.length,renders=a.harness.replyRenders;x.level({rms:.25,peak:.5});a.frame(0);const writes=a.harness.waveWrites,path=a.node('capture-wave-path').d;x.level({rms:.4,peak:.7});a.frame(25);assert.equal(a.harness.waveWrites,writes);a.frame(50);assert.equal(a.harness.waveWrites,writes+1);assert.notEqual(a.node('capture-wave-path').d,path);a.frame(100);a.frame(500);assert.equal(a.harness.waveWrites,writes+1);assert.equal(a.harness.replyRenders,renders);assert.equal(a.messages.length,messages);a.node('stop').onclick();
});

test('finish, cancellation, failure and disconnect clear feedback; late frames never reopen it',async()=>{
 for(const mode of ['finish','cancel','error','disconnect','processor-stop']){const a=await ready(),x=await open(a);await finishOpen(a,x.promise);x.level({rms:.2,peak:.3});a.frame(0);if(mode==='finish')a.node('voice').onclick();if(mode==='cancel')a.node('stop').onclick();if(mode==='error')await a.bridge.receive({channel:'event',event:{type:'error',scope,message:'本轮采集失败'}},1);if(mode==='processor-stop')a.harness.captureDiagnostic({phase:'stopped',elapsedMs:10,firstBlockSampleCount:128,flushedSampleCount:0,nonzeroObserved:true});if(mode==='disconnect')a.changed(1,'disconnected');assert.equal(a.node('capture-feedback').hidden,true,mode);x.level({rms:.8,peak:.9});a.frame(100);assert.equal(a.node('capture-feedback').hidden,true,mode);}
});

test('new voice starts clean, ignores old captured callback and survives panel open/close',async()=>{
 const a=await ready(),x=await open(a);await finishOpen(a,x.promise);x.level({rms:.5,peak:.8});a.frame(0);a.node('stop').onclick();const y=await open(a,{...scope,turnId:'next',generation:2});assert.equal(a.node('capture-feedback').dataset.phase,'connecting');x.level({rms:.9,peak:1});a.frame(100);assert.equal(a.node('capture-wave').hidden,true);a.node('open').onclick();assert.equal(a.node('capture-feedback').hidden,false);a.node('close').onclick();assert.equal(a.node('capture-feedback').hidden,false);y.level({rms:0,peak:0});a.frame(150);assert.equal(a.node('capture-feedback').dataset.phase,'recording');await finishOpen(a,y.promise);a.node('stop').onclick();
});


test('quiet input rises above the old display while zero stays flat and mid/high levels remain distinct',async t=>{
 const amplitudes=[0,.0001,.001,.02,.3,1],heights=[];
 for(const rms of amplitudes){const a=await ready(),x=await open(a);await finishOpen(a,x.promise);x.level({rms,peak:rms});a.frame(0);const points=a.node('capture-wave-path').d.split(/[MLZ]/).filter(Boolean).map(p=>p.trim().split(/\s+/).map(Number)),ys=points.map(p=>p[1]);const height=Math.max(...ys)-Math.min(...ys);heights.push(height);assert.ok(Math.min(...ys)>=2&&Math.max(...ys)<=22);a.node('stop').onclick();}
 const previous=amplitudes.map(rms=>rms===0?0:Math.pow(rms*.7,.25)*20);
 assert.equal(heights[0],0);assert.ok(heights[1]>=4.7,'RMS0.0001 should exceed three times the 1.4px stroke');assert.ok(heights[2]>=6.6,'RMS0.001 should show a clear envelope');
 assert.ok(heights[1]>=previous[1]*2.5,'the same quiet input should be at least 2.5 times the old envelope');
 for(let i=1;i<heights.length;i++)assert.ok(heights[i]>heights[i-1]);
 assert.ok(heights[4]-heights[3]>=4,'normal levels should remain distinct');assert.ok(heights[5]-heights[4]>=3,'high levels should remain distinct');assert.ok(heights.at(-1)<=20);
 t.diagnostic(JSON.stringify({rms:amplitudes,oldEnvelope:previous.map(x=>Number(x.toFixed(2))),newEnvelope:heights}));
});
