import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';
test('real desktop entry applies current policy after ready, ignores stale generation, and still sends ordinary commands',async()=>{
 const a=await app();a.changed(1);await a.ready(1);
 const policy={modelId:'jellyfish-test',revision:2,enabledIds:['exp-zzz']};
 await a.bridge.receive({channel:'presentation_policy',policy},1);assert.deepEqual(JSON.parse(JSON.stringify(a.harness.policy)),policy);
 await a.bridge.receive({channel:'presentation_policy',policy:{...policy,revision:1,enabledIds:[]}},1);assert.equal(a.harness.policy.revision,2);
 a.node('text').value='合成消息';a.emit(a.node('form'),'submit');
 assert.ok(a.wire().some(m=>m.value.message.command?.type==='submit_text'));
 a.changed(2);assert.equal(a.harness.policy.modelId,'disconnected');await a.ready(2);
 await a.bridge.receive({channel:'presentation_policy',policy},1);assert.equal(a.harness.policy.modelId,'disconnected');
 await a.bridge.receive({channel:'presentation_policy',policy:{...policy,revision:0,enabledIds:[]}},2);assert.equal(a.harness.policy.revision,0);assert.equal(a.harness.policy.enabledIds.length,0);
});
