// Runs the original main entry in the existing silent DOM harness. No real backend or devices.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const cache='/Users/example/AAAAGENT/artifacts/worktrees/W0-I-independent-blackboard-54/code/desktop-pet/package.json';
let harness=await readFile('tests/desktop/ui-harness.mjs','utf8');
harness=harness.replace("import {build} from 'esbuild';",`import {createRequire} from 'node:module';const {build}=createRequire(${JSON.stringify(cache)})('esbuild');`)
 .replace('const context={harness,console,structuredClone,','const context={harness,console,TextEncoder,structuredClone,');
const {app}=await import('data:text/javascript;base64,'+Buffer.from(harness).toString('base64'));
const bridgeVersion=(await readFile('contracts/desktop-bridge.ts','utf8')).match(/DESKTOP_BRIDGE_VERSION\s*=\s*'([^']+)'/)[1];
const scope={characterId:'companion',sessionId:'original-session',turnId:'original-turn',generation:2};
const history=()=>({version:'0.1.0',characterId:'companion',status:'ready',hasMore:false,rows:[
 {characterId:'companion',recordId:'original-turn:user',recordVersion:1,role:'user',text:'受控原用户正文\n完整中文 English',createdAt:'2026-10-01T00:00:00Z',logicalOrder:1,sourceScope:scope},
 {characterId:'companion',recordId:'original-turn:assistant',recordVersion:1,role:'assistant',text:'受控原助手正文\n完整尾部',createdAt:'2026-10-01T00:00:01Z',logicalOrder:2,sourceScope:scope},
]});
const ready=(a,h,g=1,s='fresh-session')=>a.bridge.receive({channel:'backend_ready',bridgeVersion,characterId:'companion',sessionId:s,history:h},g);
const rows=a=>a.node('reply').children.filter(x=>x.className?.startsWith('chat-row'));
test('original renderer restores both complete saved rows under a fresh live session without sending',async()=>{
 const a=await app({explicitRouting:true});a.changed(1);a.node('text').value='草稿保留';a.node('text').oninput();const wire=a.wire().length;
 await ready(a,history());assert.equal(rows(a).length,2);assert.ok(rows(a)[0].textContent.includes(history().rows[0].text));assert.ok(rows(a)[1].textContent.includes(history().rows[1].text));
 for(let i=0;i<2;i++){assert.equal(rows(a)[i].dataset.recordId,history().rows[i].recordId);assert.equal(rows(a)[i].dataset.recordVersion,'1');assert.deepEqual(JSON.parse(rows(a)[i].dataset.sourceScope),scope);}
 assert.equal(a.node('text').value,'草稿保留');assert.equal(a.wire().length,wire);assert.equal(a.harness.playOpens,0);assert.equal(a.harness.captureOpens,0);
 assert.equal(a.node('introduction').children.length,0);assert.equal(a.node('status').textContent,'我在这里');
 await ready(a,history());assert.equal(rows(a).length,2);assert.equal(a.wire().length,wire);
});
test('old generation and malformed/foreign history preserve current rows and draft on reconnect',async()=>{
 const a=await app({explicitRouting:true});a.changed(1);await ready(a,history());a.node('text').value='新的未发草稿';a.node('text').oninput();
 a.changed(1,'disconnected');a.changed(2);const changed=history();changed.rows[0].text='不得进入当前窗口';await ready(a,changed,1);assert.equal(rows(a).length,2);
 const bad=history();bad.rows[1].recordVersion=0;await ready(a,bad,2,'new-session');assert.equal(rows(a).length,2);assert.equal(a.node('text').value,'新的未发草稿');
 assert.equal(a.wire().length,0);assert.equal(a.harness.playOpens,0);assert.equal(a.harness.captureOpens,0);
 a.changed(2,'disconnected');a.changed(3);await ready(a,{...history(),characterId:'friend'},3);assert.equal(rows(a).length,2);assert.equal(a.node('text').value,'新的未发草稿');
});
test('reconnect after actual live text events deduplicates the same original records and preserves next draft',async()=>{
 const a=await app({explicitRouting:true});a.changed(1);await a.ready(1,'original-session');a.node('text').value=history().rows[0].text;a.node('form').onsubmit({preventDefault(){}});
 const request=a.wire().at(-1).value.message.command.clientRequestId;
 await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'text',text:history().rows[0].text,clientRequestId:request,startedAt:''}}},1);
 await a.bridge.receive({channel:'input_route',scope,route:'companion'},1);
 await a.bridge.receive({channel:'event',event:{type:'reply',reply:{scope,text:history().rows[1].text,expression:{emotion:'neutral',intensity:0,delivery:'',gesture:null}}}},1);
 assert.equal(rows(a).length,2);a.node('text').value='下一条草稿';a.node('text').oninput();const wire=a.wire().length;
 a.changed(1,'disconnected');a.changed(2);await ready(a,history(),2);assert.equal(rows(a).length,2);assert.equal(a.node('text').value,'下一条草稿');assert.equal(a.wire().length,wire);
 assert.equal(a.harness.playOpens,0);assert.equal(a.harness.captureOpens,0);
});
