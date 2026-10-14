import test from 'node:test';import assert from 'node:assert/strict';import {app} from './ui-harness.mjs';
test('explicit voice command precedes chat rebuilding while local state and feedback remain synchronous',async()=>{
 const a=await app();a.changed(1);await a.ready();a.bridge.hotkeyConfig('Space');const before=a.harness.replyRenders;
 a.bridge.hotkeyEvent({type:'down',code:'Space',repeat:false});
 assert.equal(a.harness.startReplyRenders,before,'native authorization must not wait for chat DOM rebuild');
 const cmd=a.wire().at(-1).value.message.command;assert.equal(cmd.type,'start_voice');assert.equal(typeof cmd.clientRequestId,'string');
 assert.equal(a.harness.replyRenders,before+1);assert.equal(a.harness.attention,1);assert.match(a.node('status').textContent,/准备麦克风/);a.node('stop').onclick();
});
