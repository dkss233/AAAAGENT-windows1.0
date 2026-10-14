import test from 'node:test';import assert from 'node:assert/strict';import {app} from './ui-harness.mjs';
const requests=a=>a.messages.filter(m=>m.name==='shell'&&m.value.type==='open_management');
test('management page opens only on explicit click, with one fixed intent and no URL/token payload',async()=>{
 const a=await app();a.changed(1);await a.ready();assert.equal(requests(a).length,0);
 a.node('text').value='保留草稿';a.node('management').onclick();a.node('management').onclick();
 assert.equal(requests(a).length,1);assert.equal(JSON.stringify(requests(a)[0].value),' {"type":"open_management"}'.trim());assert.equal(a.wire().length,0);assert.equal(a.node('management').disabled,true);
 a.bridge.managementResult({ok:true,url:'ignored-private-value'});
 assert.equal(a.node('management').disabled,false);assert.equal(a.node('management-notice').hidden,true);assert.equal(a.node('text').value,'保留草稿');assert.ok(!a.renderedText().includes('ignored-private-value'));
});
test('failed helper result enables retry and shows a sanitized independent notice',async()=>{
 const a=await app();a.node('management').onclick();a.bridge.managementResult({ok:'yes'});assert.equal(a.node('management').disabled,true);
 a.bridge.managementResult({ok:false,error:'private-stack-path'});assert.match(a.node('management-notice').textContent,/无法打开控制台/);assert.equal(a.node('management').disabled,false);assert.ok(!a.renderedText().includes('private-stack-path'));
 a.node('management').onclick();assert.equal(requests(a).length,2);assert.equal(a.node('management-notice').hidden,true);
});
test('management keyboard activation is not consumed by a configured voice key',async()=>{
 const a=await app();a.changed(1);await a.ready();a.bridge.hotkeyConfig('Space');
 a.listeners.get('keydown')({target:a.node('management'),key:' ',code:'Space',preventDefault(){throw Error('management key was intercepted')},stopPropagation(){}});
 assert.equal(a.wire().length,0);
});
