import test from 'node:test';import assert from 'node:assert/strict';import {createDecipheriv} from 'node:crypto';
import {prepareCombinedVoiceProbe} from '../../tools/prepare-combined-voice-probe.mjs';import {pcm16Wav} from '../../dist/media/wav.js';
test('one combined message contains exact same-wave FILE and valid native VOICE; encrypted preparations are disposed',async()=>{
 const wav=pcm16Wav(Float32Array.from({length:2400},(_,i)=>.2*Math.sin(i*.1)),24000);const before=Buffer.from(wav),signal=new AbortController().signal;
 const p=await prepareCombinedVoiceProbe({wav,userId:'synthetic',signal});assert.deepEqual(wav,new Uint8Array(before));
 const plain=p.parts.map(x=>{const d=createDecipheriv('aes-128-ecb',Buffer.from(x.uploadRequest.aeskey,'hex'),null);return Buffer.concat([d.update(x.encrypted),d.final()]);});assert.deepEqual(plain[0],before);assert.equal(plain[1].subarray(1,10).toString(),'#!SILK_V3');
 const msg=p.buildMessage({fileParam:'file',voiceParam:'voice',contextToken:'context',clientId:'once'});assert.deepEqual(msg.msg.item_list.map(x=>x.type),[4,3]);assert.equal(msg.msg.item_list[0].file_item.len,String(wav.length));assert.equal(msg.msg.item_list[1].voice_item.encode_type,6);assert.deepEqual(p.parts.map(x=>x.uploadRequest.media_type),[3,4]);
 assert.throws(()=>p.buildMessage({fileParam:'f',voiceParam:'v',contextToken:'c',clientId:'again'}));p.dispose();assert.ok(p.parts.every(x=>x.encrypted.every(v=>v===0)));assert.equal(msg.msg.item_list[0].file_item.media.aes_key,'');assert.equal(msg.msg.item_list[1].voice_item.media.aes_key,'');for(const b of plain)b.fill(0);wav.fill(0);before.fill(0);
});
