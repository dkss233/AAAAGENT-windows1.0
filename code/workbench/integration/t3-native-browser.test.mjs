import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { T3LocalService } from './t3-local-service.mjs';
import { T3HttpClient } from './t3-http-client.mjs';

test('real pinned T3 pairs native browser, opens exact targets and reuses its persisted home without model turns',
  { skip: !process.env.AAAAGENT_T3_TEST_SOURCE, timeout: 90000 }, async () => {
  const evidence = resolve('artifacts/W0-I/native-web-54'); mkdirSync(evidence,{recursive:true});
  const root = mkdtempSync(join(evidence,'native-http-')); const workspaceRoot = join(root,'synthetic-project'); mkdirSync(workspaceRoot);
  const options = {sourceDir:process.env.AAAAGENT_T3_TEST_SOURCE,nodeExecutable:process.execPath,
    baseDir:join(root,'home'),logFile:join(root,'service.log')};
  const a=new T3LocalService(options), b=new T3LocalService(options), t3=new T3HttpClient(a);
  try {
    const connection=await a.start(), {environmentId}=await t3.environmentDescriptor();
    assert.equal((await fetch(connection.origin+'/api/orchestration/shell')).status,401);
    const createdAt=new Date().toISOString();
    await t3.createCommand({type:'project.create',commandId:'project-001',projectId:'project-native-web',title:'Native web isolated trial',workspaceRoot,createdAt});
    await t3.createCommand({type:'thread.create',commandId:'thread-001',projectId:'project-native-web',threadId:'thread-native-web',title:'No model navigation trial',
      modelSelection:{instanceId:'codex',model:'gpt-6-astra'},runtimeMode:'approval-required',interactionMode:'default',branch:null,worktreePath:null,createdAt});
    let cookie;
    for(const kind of ['home','project','task']) {
      let entry;
      try { entry=await a.openBrowser({kind,environmentId,t3ProjectId:'project-native-web',workspaceRoot,
        threadId:'thread-native-web',providerInstanceId:'codex'}); }
      catch(error) { const shell=await t3.shellSnapshot();const detail=await t3.threadSnapshot('thread-native-web',1);
        throw Error(JSON.stringify({kind,environmentId,projects:shell.projects,thread:{id:detail.thread?.id,projectId:detail.thread?.projectId,modelSelection:detail.thread?.modelSelection,deletedAt:detail.thread?.deletedAt}}),{cause:error}); }
      const url=new URL(entry.url);
      const r=await fetch(url.origin+'/launch',{method:'POST',headers:{Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify({ticket:url.hash.slice(1)})});
      assert.equal(r.status,200,kind+' native pairing failed');
      cookie=r.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
      const opened=await r.json();assert.ok(opened.url.startsWith(connection.origin+'/'));
      if(kind==='task')assert.equal(opened.url,connection.origin+'/'+environmentId+'/thread-native-web');
      if(kind==='project')assert.ok(opened.url.includes('aaaProject=project-native-web'));
      const state=await fetch(connection.origin+'/api/auth/session',{headers:{Cookie:cookie}});assert.equal((await state.json()).authenticated,true);
      const shell=await fetch(connection.origin+'/api/orchestration/shell',{headers:{Cookie:cookie}});
      assert.equal(shell.status,200);assert.equal((await shell.json()).threads.length,1);
      assert.equal((await fetch(url.origin+'/launch',{method:'POST',headers:{Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify({ticket:url.hash.slice(1)})})).status,503);
    }
    await a.stop(); assert.equal((await b.start()).pid,connection.pid);
    const detail=await t3.threadSnapshot('thread-native-web',1); assert.equal(detail.thread.messages.length,0);assert.equal(detail.thread.session,null);
    await b.stopBackground();
    // Explicit stop is awaited by polling the private owner, never replaying commands.
    for(let i=0;i<100;i++){try{b.readHost();await new Promise(r=>setTimeout(r,100));}catch{break;}}
    const again=await b.start(); assert.notEqual(again.pid,connection.pid);
    assert.equal((await new T3HttpClient(b).environmentDescriptor()).environmentId,environmentId);
    assert.equal((await new T3HttpClient(b).threadSnapshot('thread-native-web',1)).thread.id,'thread-native-web');
    assert.equal((await fetch(again.origin+'/api/orchestration/shell')).status,401);
  } finally {
    await b.stopBackground().catch(()=>{});
    for(let i=0;i<100;i++){try{b.readHost();await new Promise(r=>setTimeout(r,100));}catch{break;}}
    rmSync(root,{recursive:true,force:true});
  }
});
