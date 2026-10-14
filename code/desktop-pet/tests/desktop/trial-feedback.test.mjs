import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';
const submit=a=>a.node('form').onsubmit({preventDefault(){}});
async function ready(){const a=await app();a.changed(1);await a.ready();return a}
test('routed companion text remains visible while waiting for a reply',async()=>{
 const a=await ready();a.node('text').value='今天有点累';submit(a);
 assert.equal(a.wire().at(-1).value.message.command.text,'今天有点累');
 assert.ok(a.node('reply').textContent.includes('今天有点累'),'原话提交后立即显示，显示不等于记忆写入');
 const scope={characterId:'companion',sessionId:'s1',turnId:'t1',generation:1};
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'text',startedAt:''}}},1);
 assert.ok(a.node('reply').textContent.includes('今天有点累'),'确认陪伴路由后保留消息');
});
test('Chinese IME composition submit does not send or clear the unfinished input',async()=>{
 const a=await ready();a.emit(a.node('text'),'compositionstart');a.node('text').value='正在选字';submit(a);
 assert.equal(a.wire().length,0,'组合输入期间不能发送半成品');assert.equal(a.node('text').value,'正在选字');
 a.emit(a.node('text'),'compositionend');submit(a);assert.equal(a.wire().length,1);
});
test('failure before the turn is acknowledged retains a recoverable user draft',async()=>{
 const a=await ready();a.node('text').value='请保留这句话';submit(a);
 a.changed(1,'disconnected');
 assert.equal(a.node('text').value,'请保留这句话','未确认发送的输入应可重试');
});
test('device-open failure shows a useful local error and enables another explicit attempt',async()=>{
 const a=await ready();a.node('voice').onclick();const scope={characterId:'companion',sessionId:'s1',turnId:'t1',generation:1};
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'voice',startedAt:''}}},1);
 const opening=a.bridge.receive({channel:'capture_start',requestId:'c1',scope},1);
 const error=new Error('Permission denied');error.name='NotAllowedError';a.harness.rejectCapture(error);await opening;
 assert.match(a.node('status').textContent,/权限|录音失败|无法.*录音/,'本地录音失败不应继续显示正在听');
 assert.equal(a.node('voice').disabled,false);
});
test('Chinese draft and displayed messages survive reconnect without a role selector',async()=>{
 const a=await ready();a.node('text').value='今天练琴很顺利';a.emit(a.node('text'),'input');submit(a);
 const scope={characterId:'companion',sessionId:'s1',turnId:'t1',generation:1};
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'text',startedAt:''}}},1);
 a.node('text').value='继续输入的中文草稿';a.emit(a.node('text'),'input');
 a.changed(1,'disconnected');a.changed(2);await a.ready(2,'s2');
 assert.equal(a.node('text').value,'继续输入的中文草稿');assert.ok(a.renderedText().includes('今天练琴很顺利'));
 assert.equal(a.node('role').onchange,undefined);
});
test('finishing before device-ready does not leave the panel thinking with a hidden capture error',async()=>{
 const a=await ready();a.node('voice').onclick();const scope={characterId:'companion',sessionId:'s1',turnId:'t1',generation:1};
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'voice',startedAt:''}}},1);
 a.node('voice').onclick();
 await a.bridge.receive({channel:'capture_start',requestId:'late-capture',scope},1);
 assert.equal(a.harness.captureOpens,0,'结束动作后不能再打开采集');
 assert.match(a.node('status').textContent,/取消|未就绪|录音失败/,'过早松开应有可理解状态');
 assert.equal(a.node('voice').disabled,false);
});

test('configured arrow key starts once and early release cancels rather than sending an empty recording',async()=>{
 const a=await ready();a.node('hotkey-bind').onclick();a.node('hotkey-bind').onkeydown({code:'ArrowLeft',key:'ArrowLeft',preventDefault(){}});
 a.bridge.hotkeyEvent({type:'down',code:'ArrowLeft'});a.bridge.hotkeyEvent({type:'down',code:'ArrowLeft',repeat:true});
 a.bridge.hotkeyEvent({type:'up',code:'ArrowLeft'});a.bridge.hotkeyEvent({type:'up',code:'ArrowLeft'});
 assert.deepEqual(a.wire().map(m=>m.value.message.command?.type),['start_voice','cancel']);
 assert.match(a.node('status').textContent,/未发送/);assert.equal(a.harness.captureOpens,0);
});
test('hold release after actual readiness finishes once; focus loss cancels instead',async()=>{
 const a=await ready();a.bridge.hotkeyConfig('KeyV');a.bridge.hotkeyEvent({type:'down',code:'KeyV'});
 const scope={characterId:'companion',sessionId:'s1',turnId:'t1',generation:1};
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'voice',startedAt:''}}},1);
 const open=a.bridge.receive({channel:'capture_start',requestId:'c',scope},1);a.harness.openCapture({stop(){}});await open;
 assert.match(a.node('status').textContent,/正在听/);a.bridge.hotkeyEvent({type:'up',code:'KeyV'});
 assert.equal(a.wire().at(-1).value.message.command.type,'finish_voice');
 a.node('stop').onclick();a.bridge.hotkeyEvent({type:'down',code:'KeyV'});a.bridge.hotkeyEvent({type:'cancel'});a.bridge.hotkeyEvent({type:'up',code:'KeyV'});
 assert.equal(a.wire().at(-1).value.message.command.type,'cancel');
});

test('focused key events preserve arrow editing and composition, and cancel on focus loss',async()=>{
 const a=await ready();a.bridge.hotkeyConfig('ArrowLeft');const key=a.listeners.get('keydown');
 const base={code:'ArrowLeft',key:'ArrowLeft',preventDefault(){},stopPropagation(){}};
 key({...base,target:{tagName:'INPUT'}});key({...base,target:{tagName:'DIV'},isComposing:true});assert.equal(a.wire().length,0);
 key({...base,target:{tagName:'BUTTON'}});a.listeners.get('focusin')({target:{tagName:'INPUT'}});
 assert.deepEqual(a.wire().map(m=>m.value.message.command?.type),['start_voice','cancel']);
});
test('cancel before turn acknowledgement rejects the old token and only opens capture for the immediate retry',async()=>{
 const a=await ready();a.bridge.hotkeyConfig('KeyV');a.bridge.hotkeyEvent({type:'down',code:'KeyV'});
 const first=a.wire().at(-1).value.message.command.clientRequestId;
 a.bridge.hotkeyEvent({type:'up',code:'KeyV'});a.bridge.hotkeyEvent({type:'down',code:'KeyV'});
 const second=a.wire().at(-1).value.message.command.clientRequestId;assert.notEqual(first,second);
 const old={characterId:'companion',sessionId:'s1',turnId:'old',generation:1};
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope:old,kind:'voice',startedAt:'',clientRequestId:first}}},1);
 await a.bridge.receive({channel:'capture_start',requestId:'old-c',scope:old},1);assert.equal(a.harness.captureOpens,0);
 const current={...old,turnId:'current',generation:3};
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope:current,kind:'voice',startedAt:'',clientRequestId:second}}},1);
 const opening=a.bridge.receive({channel:'capture_start',requestId:'current-c',scope:current},1);a.harness.openCapture({stop(){}});await opening;assert.equal(a.harness.captureOpens,1);
 await a.bridge.receive({channel:'capture_start',requestId:'late-c',scope:old},1);assert.equal(a.harness.captureSignal.aborted,false,'旧scope不能停止新录音');
 a.bridge.hotkeyEvent({type:'up',code:'KeyV'});assert.equal(a.wire().at(-1).value.message.command.type,'finish_voice');
});
test('validated voice transcript replaces only its full-scope placeholder',async()=>{
 const a=await ready();a.node('voice').onclick();const scope={characterId:'companion',sessionId:'s1',turnId:'voice',generation:1};
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'voice',startedAt:''}}},1);
 await a.bridge.receive({channel:'event',event:{type:'transcript',scope:{...scope,turnId:'old'},text:'不应显示的旧转写'}},1);assert.ok(!a.renderedText().includes('不应显示'));
 await a.bridge.receive({channel:'event',event:{type:'transcript',scope,text:'这是实际转写展示位'}},1);assert.ok(a.renderedText().includes('这是实际转写展示位'));assert.ok(!a.renderedText().includes('语音输入 · 准备中'));
 a.changed(1,'disconnected');a.changed(2);await a.ready(2,'s2');
 await a.bridge.receive({channel:'event',event:{type:'transcript',scope,text:'迟到的旧会话转写'}},2);assert.ok(!a.renderedText().includes('迟到的旧会话'));
});
test('capture exception detail never crosses the bridge or appears in the UI',async()=>{
 const a=await ready();a.node('voice').onclick();const scope={characterId:'companion',sessionId:'s1',turnId:'voice',generation:1};
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'voice',startedAt:''}}},1);
 const open=a.bridge.receive({channel:'capture_start',requestId:'c',scope},1);a.harness.rejectCapture(new Error('private-device-detail https://invalid.local/key=secret'));await open;
 const error=a.wire().at(-1).value.message;assert.equal(error.channel,'rpc_error');assert.equal(error.scope.turnId,'voice');assert.equal(error.error.code,'capture_start_failed');assert.ok(!JSON.stringify(error).includes('private-device-detail'));assert.ok(!a.renderedText().includes('invalid.local'));
});
