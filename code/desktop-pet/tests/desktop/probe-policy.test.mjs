import test from 'node:test';
import assert from 'node:assert/strict';
import {ProbePolicy} from './probe-policy.mjs';
test('typing and other UI commands never trigger the fixed test audio',()=>{
 const policy=new ProbePolicy();
 for(const command of ['submit_text','start_voice','cancel','switch_character','click_invitation'])assert.equal(policy.request(command,true).play,false);
 assert.equal(policy.request('explicit_play',true).play,true);
});
test('only one explicit audible request is accepted, including rapid repeated triggers',()=>{
 const policy=new ProbePolicy();assert.equal(policy.request('explicit_play',false).play,false);
 const accepted=Array.from({length:20},()=>policy.request('explicit_play',true)).filter(r=>r.play);
 assert.equal(accepted.length,1);
});
