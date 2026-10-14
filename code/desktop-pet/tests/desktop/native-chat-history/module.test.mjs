import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const {build}=createRequire('/Users/example/AAAAGENT/artifacts/worktrees/W0-I-independent-blackboard-54/code/desktop-pet/package.json')('esbuild');
const src=resolve('desktop/chat-log.ts');
const result=await build({stdin:{contents:`export {DesktopChatLog} from ${JSON.stringify(src)};`,loader:'ts',resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {DesktopChatLog}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const scope={characterId:'companion',sessionId:'old-session',turnId:'old-turn',generation:2};
const history=()=>({version:'0.1.0',characterId:'companion',status:'ready',hasMore:false,rows:['user','assistant'].map((role,i)=>({characterId:'companion',recordId:'old-turn:'+role,recordVersion:1,role,text:i?'原助手\n完整尾部🙂':' 原用户\n原文不截断 English ',createdAt:`2026-10-01T00:00:0${i}Z`,logicalOrder:i+1,sourceScope:{...scope}}))});
const restore=(log,h=history())=>log.restoreHistory('companion',h);
test('cold restore retains complete text, original record identity/version/scope and copies metadata',()=>{
 const log=new DesktopChatLog(),h=history();assert.equal(restore(log,h),true);assert.equal(log.rows('companion').length,2);
 for(let i=0;i<2;i++){const row=log.rows('companion')[i],saved=h.rows[i];assert.equal(row.kind,saved.role);assert.equal(row.text,saved.text);assert.equal(row.recordId,saved.recordId);assert.equal(row.recordVersion,1);assert.deepEqual(row.sourceScope,scope);assert.deepEqual(row.scope,scope);assert.equal(row.createdAt,saved.createdAt);assert.equal(row.logicalOrder,saved.logicalOrder);}
 h.rows[0].sourceScope.sessionId='tampered';assert.equal(log.rows('companion')[0].sourceScope.sessionId,'old-session');assert.equal(log.pending('companion'),false);
});
test('repeat snapshot is idempotent, null source stays unknown, and newer versions supersede without duplicates',()=>{
 const log=new DesktopChatLog();restore(log);const ids=log.rows('companion').map(r=>r.id),revision=log.revision;restore(log);assert.equal(log.revision,revision);assert.deepEqual(log.rows('companion').map(r=>r.id),ids);
 const changed=history();changed.rows[0].recordVersion=2;changed.rows[0].text='已编辑原文';changed.rows[0].sourceScope=null;assert.equal(restore(log,changed),true);assert.equal(log.rows('companion').length,2);assert.equal(log.rows('companion')[0].recordVersion,2);assert.equal(log.rows('companion')[0].sourceScope,null);assert.equal(log.rows('companion')[0].scope,undefined);
 const stable=JSON.stringify(log.rows('companion'));assert.equal(restore(log,history()),false);assert.equal(JSON.stringify(log.rows('companion')),stable);
});
test('live text and voice rows gain exact saved metadata once; subsequent live replies still work',()=>{
 for(const voice of [false,true]){const log=new DesktopChatLog(),h=history();if(voice){log.beginVoice('companion');log.bindVoice(scope);log.transcript(scope,h.rows[0].text);}else{log.submit('companion',h.rows[0].text);log.acknowledge(scope);}
  log.reply(scope,h.rows[1].text);const ids=log.rows('companion').map(r=>r.id);restore(log,h);restore(log,h);assert.equal(log.rows('companion').length,2);assert.deepEqual(log.rows('companion').map(r=>r.id),ids);assert.deepEqual(log.rows('companion').map(r=>r.recordId),h.rows.map(r=>r.recordId));
  log.reply({...scope,turnId:'next-turn',generation:3},'当前新回复');assert.equal(log.rows('companion').at(-1).text,'当前新回复');assert.equal(log.rows('companion').length,3);
 }
});
test('restore preserves drafts and the pending row reference used by acknowledgement and routing',()=>{
 const log=new DesktopChatLog(),live={...scope,sessionId:'new-live-session',turnId:'new-turn',generation:1};log.submit('companion','待确认的新输入');log.acknowledge(live,true);const pending=log.rows('companion')[0];log.setDraft('companion','下一条草稿');
 assert.equal(restore(log),true);assert.equal(log.pending('companion'),true);assert.equal(log.draft('companion'),'下一条草稿');assert.equal(log.rows('companion').at(-1),pending);log.route(live,'companion');assert.equal(log.pending('companion'),false);assert.equal(pending.status,'sent');assert.equal(log.draft('companion'),'下一条草稿');
});
test('invalid envelopes or any invalid row reject atomically and retain existing state',()=>{
 const changes=[h=>h.version='future',h=>h.characterId='friend',h=>h.status='unavailable',h=>h.hasMore='yes',h=>h.rows[1].characterId='friend',h=>h.rows[1].recordId='',h=>h.rows[1].recordId=h.rows[0].recordId,h=>h.rows[1].recordVersion=0,h=>h.rows[1].recordVersion=1.5,h=>h.rows[1].role=['assistant'],h=>h.rows[1].text='',h=>h.rows[1].text='bad\0text',h=>h.rows[1].createdAt='invalid',h=>h.rows[1].logicalOrder=0,h=>h.rows[1].logicalOrder=1/0,h=>h.rows[1].logicalOrder=0.5,h=>h.rows[1].sourceScope.characterId='friend',h=>h.rows[1].sourceScope.sessionId='',h=>h.rows[1].sourceScope.turnId='',h=>h.rows[1].sourceScope.generation=-1,h=>delete h.rows[1].sourceScope];
 for(const change of changes){const log=new DesktopChatLog();restore(log);log.setDraft('companion','留住草稿');const before=JSON.stringify(log.rows('companion')),revision=log.revision,h=history();h.rows[0].recordVersion=2;h.rows[0].text='不能部分应用';change(h);assert.equal(restore(log,h),false);assert.equal(JSON.stringify(log.rows('companion')),before);assert.equal(log.revision,revision);assert.equal(log.draft('companion'),'留住草稿');}
});
test('row and UTF-8 byte limits are checked without truncating text',()=>{
 const log=new DesktopChatLog(),h=history();h.rows[0].text='中'.repeat(87381);h.rows[1].text='x';assert.equal(Buffer.byteLength(h.rows[0].text+h.rows[1].text),256*1024);assert.equal(restore(log,h),true);assert.equal(log.rows('companion')[0].text,h.rows[0].text);
 const before=JSON.stringify(log.rows('companion'));h.rows[0].recordVersion=2;h.rows[0].text+='x';assert.equal(restore(log,h),false);assert.equal(JSON.stringify(log.rows('companion')),before);
 const tooMany=history();tooMany.rows=Array.from({length:51},(_,i)=>({...tooMany.rows[0],recordId:'record-'+i,logicalOrder:i+1,sourceScope:null}));assert.equal(restore(log,tooMany),false);
});
test('valid fresh snapshots remove only disappeared restored rows and keep live text',()=>{
 const log=new DesktopChatLog();restore(log);log.submit('companion','本次输入');const live=log.rows('companion').at(-1);assert.equal(restore(log,{...history(),rows:[]}),true);assert.deepEqual(log.rows('companion'),[live]);assert.equal(log.pending('companion'),true);
 const unknown=history();unknown.rows[0].sourceScope=null;unknown.rows[1].sourceScope=null;restore(log,unknown);assert.equal(log.rows('companion')[0].sourceScope,null);assert.equal(log.rows('companion')[0].scope,undefined);assert.equal(log.rows('companion').at(-1),live);
});
test('same-version conflicting body or scope cannot overwrite a previously restored record',()=>{
 const log=new DesktopChatLog();restore(log);const before=JSON.stringify(log.rows('companion'));for(const field of ['text','sourceScope','createdAt','logicalOrder']){const h=history();h.rows[1][field]=field==='sourceScope'?{...scope,sessionId:'forged'}:field==='logicalOrder'?3:field==='createdAt'?'2026-10-01T00:00:03Z':'替换原文';assert.equal(restore(log,h),false);assert.equal(JSON.stringify(log.rows('companion')),before);}
});
