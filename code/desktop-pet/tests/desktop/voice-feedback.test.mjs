import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';
const scope={characterId:'companion',sessionId:'s1',turnId:'voice',generation:1};
const down=(a,extra={})=>a.listeners.get('keydown')({code:'Space',key:' ',target:{tagName:'DIV'},preventDefault(){},stopPropagation(){},...extra});
async function ready(){const a=await app();a.changed(1);await a.ready();a.bridge.hotkeyConfig('Space');return a;}
test('local PTT attention fires once before bridge and capture; accepted turn preserves it',async()=>{
 const a=await ready();a.harness.order.length=0;down(a);
 assert.equal(a.harness.attention,1);assert.equal(a.harness.captureOpens,0);
 assert.ok(a.harness.order.indexOf('attention')<a.harness.order.indexOf('command:start_voice'));
 down(a,{repeat:true});assert.equal(a.harness.attention,1);
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'voice',startedAt:''}}},1);
 assert.equal(a.harness.resetOptions?.preserveAttention,true);
 a.node('stop').onclick();assert.notEqual(a.harness.resetOptions?.preserveAttention,true);
});
test('voice button triggers attention; editable and composing Space do not',async()=>{
 const a=await ready();down(a,{target:{tagName:'INPUT'}});down(a,{isComposing:true});assert.equal(a.harness.attention,undefined);
 a.node('voice').onclick();assert.equal(a.harness.attention,1);a.node('stop').onclick();
});
