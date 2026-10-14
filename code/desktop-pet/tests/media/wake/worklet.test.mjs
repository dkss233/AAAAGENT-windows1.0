import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../../media/wake/recorder-worklet.mjs',import.meta.url),'utf8');
function setup(){let Recorder;const output=[];vm.runInNewContext(source,{Float32Array,Number,Math,AudioWorkletProcessor:class{port={postMessage:m=>output.push(m)}} ,registerProcessor:(name,ctor)=>{assert.equal(name,'pet-wake-recorder');Recorder=ctor;}});return {recorder:new Recorder(),output};}
test('actual worklet bounds queued raw PCM when renderer stops acknowledging and never emits more audio',()=>{
 const {recorder,output}=setup();const input=[[new Float32Array(512).fill(.2)]];
 for(let i=0;i<16;i++)assert.equal(recorder.process(input),true);
 assert.equal(recorder.process(input),false);assert.equal(output.filter(m=>m.samples).length,16);assert.equal(output.filter(m=>m.error).length,1);
 assert.equal(recorder.process(input),false);assert.equal(output.length,17);
});
test('acknowledged worklet uses same mono PCM, silence stays zero, explicit close discards partial buffer',()=>{
 const {recorder,output}=setup();for(let i=0;i<40;i++){assert.equal(recorder.process([[new Float32Array(512)]]),true);recorder.port.onmessage({data:{ack:true}});}
 assert.equal(output.length,40);assert.ok(output.every(m=>m.samples.every(x=>x===0)));
 recorder.process([[new Float32Array(128).fill(.2)]]);recorder.port.onmessage({data:'close'});assert.equal(recorder.process([[new Float32Array(512)]]),false);assert.equal(output.length,40);assert.ok(recorder.block.every(x=>x===0));
});
