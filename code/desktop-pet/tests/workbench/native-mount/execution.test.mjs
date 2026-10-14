import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { createNativeExecutionGate } from '../../../workbench/native-mount/execution-gate.mjs';
import { makeExecutionRpcFilter } from '../../../workbench/native-mount/policy.mjs';
import { startNativeReadMount } from '../../../workbench/native-mount/server.mjs';
const capability = { providerInstanceId:'codex',send:true,continue:true,modelSelection:true,
  runtimeModes:['approval-required'],attachments:{file:true,image:true,maxBytes:50*1024*1024},
  interrupt:true,approval:true,userInput:true };
const command = (commandId='command-1') => ({type:'thread.turn.start',commandId,threadId:'thread-1',
  runtimeMode:'approval-required',modelSelection:{instanceId:'codex',model:'fixture-model'},
  message:{messageId:'message-1',role:'user',text:'controlled unique text',attachments:[]}});
const envelope = (payload,id='rpc-1') => ({_tag:'Request',id,tag:'orchestration.dispatchCommand',payload,
  headers:[['Authorization','untrusted browser header']]});
const scope = {environmentId:'environment-1',projectId:'project-1',providerInstanceId:'codex',newThread:false,readonly:false,source:'t3'};

test('a lost native receipt survives gateway reopening and requires cold-read before the next command',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'aaa-web-admission-'));
  try{
    const options={environmentId:'environment-1',file:join(dir,'admission.json'),providers:[capability],prepareCommand:async()=>scope};
    const first=createNativeExecutionGate(options),filter=makeExecutionRpcFilter(first);
    const accepted=await filter.filter(JSON.stringify(envelope(command())));
    assert.equal(accepted.forward.length,1);assert.deepEqual(accepted.forward[0].headers,[]);
    const restarted=createNativeExecutionGate(options);
    assert.equal((await restarted.reserve(envelope(command(),'rpc-2'))).kind,'deny');
    assert.equal((await restarted.reserve(envelope({...command(),message:{...command().message,text:'edited'}},'rpc-3'))).kind,'deny');
    assert.equal((await restarted.reserve(envelope(command('command-2'),'rpc-4'))).kind,'deny');
    restarted.receive('command-1',{_tag:'Failure'});
    assert.equal((await restarted.reserve(envelope(command('command-2'),'rpc-failure'))).kind,'deny','RPC failure still requires original cold-read');
    restarted.reconcile('command-1',{commandId:'wrong',aggregateKind:'thread',aggregateId:'thread-1',status:'accepted',resultSequence:5});
    assert.equal((await restarted.reserve(envelope(command('command-2'),'rpc-5'))).kind,'deny');
    restarted.reconcile('command-1',{commandId:'command-1',aggregateKind:'thread',aggregateId:'thread-1',status:'accepted',resultSequence:5});
    assert.equal((await restarted.reserve(envelope(command('command-2'),'rpc-6'))).kind,'forward');
    assert.equal((await readFile(options.file,'utf8')).includes('controlled unique text'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('scope, provider, strict mode, attachment and mixed batches fail before native dispatch',async()=>{
  const gate=createNativeExecutionGate({environmentId:'environment-1',providers:[capability],prepareCommand:async c=>
    c.threadId==='wrong' ? {...scope,environmentId:'wrong'} : scope});
  const filter=makeExecutionRpcFilter(gate);
  for(const bad of [{...command(),runtimeMode:'full-access'},{...command(),runtimeMode:undefined},
    {...command(),threadId:'wrong'},{...command(),modelSelection:{instanceId:'dsh',model:'fixture'}},
    {...command(),message:{...command().message,attachments:[{type:'file',sizeBytes:50*1024*1024+1}]}},
    {...command(),message:{...command().message,attachments:[{type:'image',sizeBytes:10*1024*1024+1}]}},
    {...command(),providerOnlyProjectContext:{version:1}}, {...command(),bootstrap:{prepareWorktree:{projectCwd:'/private'}}}]){
    const result=await filter.filter(JSON.stringify(envelope(bad)));
    assert.equal(result.forward.length,0);assert.equal(result.rejected[0].exit._tag,'Failure');
  }
  const mixed=await filter.filter(JSON.stringify([envelope(command()),{_tag:'Request',id:'read',tag:'server.getConfig',payload:{}}]));
  assert.equal(mixed.forward.length,0);
  const asset=await filter.filter(JSON.stringify({_tag:'Request',id:'asset',tag:'assets.createUrl',payload:{resource:{_tag:'file',path:'/private'}}}));
  assert.equal(asset.forward.length,0);
});

test('an unverified stop capability closes both turn interrupt and session stop',async()=>{
  const gate=createNativeExecutionGate({environmentId:'environment-1',providers:[{...capability,interrupt:false}],prepareCommand:async()=>scope});
  for(const type of ['thread.turn.interrupt','thread.session.stop']) {
    const result=await gate.reserve(envelope({type,commandId:'stop-'+type,threadId:'thread-1',turnId:'original-turn'}));
    assert.equal(result.kind,'deny');
  }
});

test('DSH continued questions expose answering while unsupported dismissal never reaches the executor',async()=>{
  const target={...scope,providerInstanceId:'dsh',threadId:'thread-1',nativeSessionId:'t3_original'};
  const gate=createNativeExecutionGate({environmentId:'environment-1',
    providers:[{...capability,providerInstanceId:'dsh',interrupt:false,runtimeModes:['auto-accept-edits']}],
    getTarget:async()=>target,prepareCommand:async()=>target});
  const current=await gate.targetCapability('thread-1');
  assert.ok(current.commandTypes.includes('thread.user-input.respond'));
  assert.equal(current.commandTypes.includes('thread.user-input.dismiss'),false);
  const request={commandId:'question-response',threadId:'thread-1',requestId:'dsh:t3_original:question:call'};
  assert.equal((await gate.reserve(envelope({...request,type:'thread.user-input.dismiss'}))).kind,'deny');
  assert.equal((await gate.reserve(envelope({...request,type:'thread.user-input.respond',answers:{q1:['yes']}}))).kind,'forward');
});

test('original authenticated HTTP/WS and SQLite receipts carry exact commands and attachment bytes without replay',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'aaa-web-native-flow-'));
  const ws=await import(pathToFileURL(process.env.NATIVE_MOUNT_WS_MODULE).href),WebSocket=ws.default,WebSocketServer=ws.default.WebSocketServer;
  const db=new Database(join(dir,'native.sqlite'));db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT,provider TEXT);CREATE TABLE receipts(command_id TEXT PRIMARY KEY,thread_id TEXT,seq INTEGER);INSERT INTO threads VALUES(\'thread-1\',\'project-1\',\'codex\')');
  await writeFile(join(dir,'index.html'),'<p>controlled original renderer</p>');
  let sends=0,receiptReads=0,uploaded,operate=true;const received=[];
  const native=createServer((req,res)=>{void(async()=>{
    assert.equal(req.headers.authorization,'Bearer '+'n'.repeat(64));res.setHeader('Content-Type','application/json');
    if(req.url==='/api/auth/session')return res.end(JSON.stringify({authenticated:true,scopes:operate?['orchestration:read','orchestration:operate']:['orchestration:read']}));
    if(req.url==='/.well-known/t3/environment')return res.end(JSON.stringify({environmentId:'environment-1'}));
    if(req.url==='/api/orchestration/commands/command-1/receipt'){
      receiptReads++;const row=db.prepare('SELECT * FROM receipts WHERE command_id=?').get('command-1');
      return res.end(JSON.stringify({commandId:row.command_id,aggregateKind:'thread',aggregateId:row.thread_id,
        acceptedAt:'2026-10-03T00:00:00Z',status:'accepted',resultSequence:row.seq}));
    }
    if(req.url==='/api/attachments/upload/signed-fixture'&&req.method==='POST'){
      const chunks=[];for await(const bytes of req)chunks.push(bytes);uploaded=Buffer.concat(chunks);res.statusCode=204;return res.end();
    }
    res.statusCode=404;res.end('{}');
  })().catch(()=>{res.statusCode=500;res.end('{}');});});
  const upstream=new WebSocketServer({server:native});upstream.on('connection',socket=>socket.on('message',bytes=>{
    const request=JSON.parse(bytes);received.push(request);if(request.tag==='orchestration.dispatchCommand'){
      sends++;db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(request.payload.commandId,request.payload.threadId,sends);
      // First native acceptance is durable, while the caller loses its initial reply.
      return;
    }
    socket.send(JSON.stringify({_tag:'Exit',requestId:request.id,exit:{_tag:'Success',value:{}}}));
  }));
  const management=createServer((req,res)=>res.end('{}'));
  for(const server of [native,management]){server.listen(0,'127.0.0.1');await once(server,'listening');}
  const gate=createNativeExecutionGate({environmentId:'environment-1',file:join(dir,'admission.json'),providers:[capability],
    getTarget:async threadId=>threadId==='thread-1'?{...scope,threadId,nativeSessionId:'native-1'}:null,
    findReceipt:key=>db.prepare('SELECT * FROM receipts WHERE command_id=?').get(key),prepareCommand:async c=>{
      const row=db.prepare('SELECT * FROM threads WHERE id=?').get(c.threadId);
      return row?{...scope,projectId:row.project_id,providerInstanceId:row.provider}:null;
    }});
  const mount=await startNativeReadMount({managementOrigin:'http://127.0.0.1:'+management.address().port,
    nativeOrigin:'http://127.0.0.1:'+native.address().port,managementToken:'m'.repeat(64),nativeToken:'n'.repeat(64),
    uiRoot:dir,nativeDist:dir,webSocket:{WebSocket,WebSocketServer},executionGate:gate});
  let socket;
  try{
    const issue=()=>fetch(mount.origin+'/api/native-mount/session',{method:'POST',headers:{Authorization:'Bearer '+mount.token,Origin:mount.origin,'Content-Type':'application/json'},body:'{}'});
    const issued=await issue(),session=await issued.json(),cookie=issued.headers.get('set-cookie').split(';')[0];
    assert.equal(session.mode,'native-operate');assert.equal(session.readonly,false);
    const caps=await(await fetch(mount.origin+'/api/native-mount/capabilities',{headers:{Cookie:cookie}})).json();
    assert.equal(caps.environmentId,'environment-1');assert.equal(caps.providers[0].attachments.file,true);
    assert.equal(caps.expiresAt,session.expiresAt);
    const target=await(await fetch(mount.origin+'/api/native-mount/targets/thread-1/capabilities',{headers:{Cookie:cookie}})).json();
    assert.equal(target.readonly,false);assert.equal(target.nativeSessionId,'native-1');assert.equal(target.expiresAt,session.expiresAt);
    assert.equal((await fetch(mount.origin+'/api/native-mount/targets/missing/capabilities',{headers:{Cookie:cookie}})).status,404);
    assert.equal((await fetch(mount.origin+'/api/native-mount/capabilities')).status,401);
    const bytes=Buffer.from('UTF-8 控制附件 nonce-56');const upload=await fetch(mount.origin+'/api/attachments/upload/signed-fixture',{
      method:'POST',headers:{Cookie:cookie,Origin:mount.origin,'Content-Type':'application/octet-stream'},body:bytes});
    assert.equal(upload.status,204);assert.equal(createHash('sha256').update(uploaded).digest('hex'),createHash('sha256').update(bytes).digest('hex'));
    socket=new WebSocket(mount.origin.replace('http:','ws:')+'/ws',{headers:{Cookie:cookie,Origin:mount.origin}});await once(socket,'open');
    socket.send(JSON.stringify(envelope(command())));
    for(let i=0;i<100&&!sends;i++)await new Promise(done=>setTimeout(done,5));assert.equal(sends,1);assert.deepEqual(received[0].headers,[]);
    const rejection=once(socket,'message');socket.send(JSON.stringify(envelope(command(),'rpc-2')));
    assert.equal(JSON.parse((await rejection)[0]).exit._tag,'Failure');assert.equal(sends,1);
    const receipt=await(await fetch(mount.origin+'/api/orchestration/commands/command-1/receipt',{headers:{Cookie:cookie}})).json();
    assert.equal(receipt.resultSequence,1);assert.equal(receiptReads,1);assert.equal(sends,1);
    assert.equal((await fetch(mount.origin+'/api/settings',{method:'PUT',headers:{Cookie:cookie,Origin:mount.origin},body:'{}'})).status,401);
    operate=false;const readonly=await(await issue()).json();assert.equal(readonly.mode,'native-read');assert.equal(readonly.readonly,true);
    const readonlyCookie=(await issue()).headers.get('set-cookie').split(';')[0];
    const readonlyTarget=await(await fetch(mount.origin+'/api/native-mount/targets/thread-1/capabilities',{headers:{Cookie:readonlyCookie}})).json();
    assert.equal(readonlyTarget.readonly,true);assert.deepEqual(readonlyTarget.commandTypes,[]);
  }finally{
    socket?.terminate();await mount.close();for(const s of upstream.clients)s.terminate();upstream.close();
    for(const s of [native,management]){s.closeAllConnections();await new Promise(done=>s.close(done));}
    db.close();await rm(dir,{recursive:true,force:true});
  }
});
