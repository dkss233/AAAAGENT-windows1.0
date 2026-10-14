import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { startNativeReadMount } from '../../../workbench/native-mount/server.mjs';
import { createSkillTrialGate } from '../../../workbench/native-mount/skill-trial-gate.mjs';
const ws = await import(pathToFileURL(process.env.NATIVE_MOUNT_WS_MODULE).href);
const webSocket = { WebSocket: ws.default, WebSocketServer: ws.default.WebSocketServer };
const { WebSocket,WebSocketServer }=webSocket;
test('authenticated composition preserves native reads and rejects management-cookie, origin and mixed command batches', async()=> {
  const dir=await mkdtemp(join(tmpdir(),'aaa-native-read-test-'));
  await writeFile(join(dir,'index.html'),'<p>native controlled test</p>');
  const calls=[];let nativeAvailable=true;
  const native=createServer((req,res)=> {
    calls.push(['http',req.method,req.url]);res.setHeader('Content-Type','application/json');
    if(!nativeAvailable){res.statusCode=401;res.end('{}');return;}
    if(req.url==='/api/auth/session')res.end(JSON.stringify({authenticated:true,scopes:['orchestration:read','orchestration:operate']}));
    else if(req.url==='/.well-known/t3/environment')res.end(JSON.stringify({environmentId:'controlled-existing'}));
    else res.end(JSON.stringify({thread:{id:'controlled-thread',projectId:'controlled-project'}}));
  });
  const nativeWs=new WebSocketServer({server:native});
  nativeWs.on('connection',socket=>socket.on('message',bytes=> {
    const m=JSON.parse(bytes.toString());calls.push(['rpc',m.tag]);
    socket.send(JSON.stringify({_tag:'Exit',requestId:m.id,exit:{_tag:'Success',value:{id:'controlled-thread'}}}));
  }));
  const management=createServer((req,res)=>{calls.push(['management',req.method,req.url]);res.setHeader('Content-Type','application/json');res.end('{}');});
  for(const server of [native,management]){server.listen(0,'127.0.0.1');await once(server,'listening');}
  const mount=await startNativeReadMount({managementOrigin:'http://127.0.0.1:'+management.address().port,
    nativeOrigin:'http://127.0.0.1:'+native.address().port,managementToken:'m'.repeat(64),nativeToken:'n'.repeat(64),uiRoot:dir,nativeDist:dir,webSocket,
    independentBlackboardReader:async scope=>scope.environmentId==='controlled-existing'&&scope.projectId==='controlled-project'
      ? {status:200,body:{apiVersion:'0.1.0',source:'aaaagent-independent-blackboard',scope,revision:4}}
      : {status:404,body:{error:'board_scope_mismatch'}}});
  try {
    assert.equal((await fetch(mount.origin+'/native/')).status,401);
    const boardPath='/api/orchestration/projects/controlled-project/independent-blackboard?environmentId=controlled-existing';
    assert.equal((await fetch(mount.origin+boardPath)).status,401);
    const issue=()=>fetch(mount.origin+'/api/native-mount/session',{method:'POST',headers:{Authorization:'Bearer '+mount.token,Origin:mount.origin,'Content-Type':'application/json'},body:'{}'});
    const issued=await issue();assert.equal(issued.status,200);
    const cookie=issued.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await fetch(mount.origin+boardPath,{headers:{Cookie:cookie}})).json()).revision,4);
    assert.equal((await fetch(mount.origin+boardPath.replace('controlled-existing','wrong'),{headers:{Cookie:cookie}})).status,404);
    assert.equal((await fetch(mount.origin+boardPath,{method:'POST',headers:{Cookie:cookie,Origin:mount.origin},body:'{}'})).status,403);
    assert.equal(calls.some(c=>c[2]?.includes('independent-blackboard')),false);
    assert.equal((await fetch(mount.origin+'/api/native-mount/skill-trial')).status,401);
    assert.deepEqual(await (await fetch(mount.origin+'/api/native-mount/skill-trial',{headers:{Cookie:cookie}})).json(),{apiVersion:1,trial:null});
    assert.match(issued.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    assert.equal((await issued.json()).environmentId,'controlled-existing');
    assert.equal((await fetch(mount.origin+'/api/snapshot',{headers:{Cookie:cookie}})).status,401);
    assert.equal((await fetch(mount.origin+'/native/',{headers:{Cookie:cookie,Origin:'http://evil.invalid'}})).status,403);
    const nativePage=await fetch(mount.origin+'/native/',{headers:{Cookie:cookie}});
    assert.match(nativePage.headers.get('content-security-policy'),/frame-ancestors 'self'/);
    assert.equal((await fetch(mount.origin+'/api/self-setup',{headers:{Authorization:'Bearer '+mount.token}})).status,404);
    assert.equal(calls.some(c=>c[2]==='/api/self-setup'),false);
    const parent=await fetch(mount.origin+'/');assert.match(parent.headers.get('content-security-policy'),/style-src 'self';/);
    const thread=await fetch(mount.origin+'/api/orchestration/threads/controlled-thread',{headers:{Cookie:cookie}});
    assert.equal((await thread.json()).thread.id,'controlled-thread');
    const denied=await fetch(mount.origin+'/api/orchestration/dispatch',{method:'POST',headers:{Cookie:cookie,Origin:mount.origin},body:'{}'});
    assert.equal(denied.status,403);
    assert.equal(calls.some(c=>c[2]==='/api/orchestration/dispatch'),false);
    const socket=new WebSocket(mount.origin.replace('http:','ws:')+'/ws',{headers:{Cookie:cookie,Origin:mount.origin}});
    await once(socket,'open');
    const first=once(socket,'message');socket.send(JSON.stringify({_tag:'Request',id:'1',tag:'server.getConfig',payload:{},headers:[]}));
    assert.equal(JSON.parse((await first)[0]).exit.value.id,'controlled-thread');
    const rejection=once(socket,'message');socket.send(JSON.stringify([{_tag:'Request',id:'2',tag:'server.getConfig',payload:{},headers:[]},{_tag:'Request',id:'3',tag:'orchestration.dispatchCommand',payload:{},headers:[]}]));
    assert.equal(JSON.parse((await rejection)[0]).exit._tag,'Failure');
    assert.deepEqual(calls.filter(c=>c[0]==='rpc'),[['rpc','server.getConfig']]);
    socket.terminate();
    nativeAvailable=false;assert.equal((await issue()).status,401);
    assert.equal((await fetch(mount.origin+'/api/auth/session',{headers:{Cookie:cookie}})).status,401);
  } finally {
    await mount.close();for(const s of nativeWs.clients)s.terminate();nativeWs.close();
    for(const s of [native,management]){s.closeAllConnections();await new Promise(done=>s.close(done));}
    await rm(dir,{recursive:true,force:true});
  }
});

test('trial capability forwards only a fixed test turn and recovers its receipt without a second upstream send', async()=> {
  const dir=await mkdtemp(join(tmpdir(),'aaa-skill-mount-test-'));
  await writeFile(join(dir,'index.html'),'<p>synthetic test</p>');
  const config={mode:'bounded-codex-skill-trial',configurationVerified:true,accountCategory:'chatgpt',projectId:'fixture',threadIds:['ordinary','multi'],cwd:'/private/tmp/aaaagent-codex-skill-input-54-test',providerInstanceId:'codex',model:'gpt-6-astra',reasoningEffort:'low',parentTurnsMax:2,automaticCommandIds:['auto-1','auto-2'],expiresAt:'2099-01-01T00:00:00Z'};
  const gate=createSkillTrialGate(config,join(dir,'ledger.json'));
  let sends=0,reads=0;
  const native=createServer((req,res)=> {
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/auth/session')res.end(JSON.stringify({authenticated:true}));
    else if(req.url==='/.well-known/t3/environment')res.end(JSON.stringify({environmentId:'fixture'}));
    else if(req.url==='/api/orchestration/commands/manual-1/receipt'){reads++;res.end(JSON.stringify({commandId:'manual-1',aggregateKind:'thread',aggregateId:'ordinary',status:'accepted',resultSequence:3}));}
    else {res.statusCode=404;res.end('{}');}
  });
  const upstream=new WebSocketServer({server:native});
  upstream.on('connection',socket=>socket.on('message',bytes=>{const m=JSON.parse(bytes.toString());sends++;socket.send(JSON.stringify({_tag:'Exit',requestId:m.id,exit:{_tag:'Success',value:{sequence:3}}}));}));
  const management=createServer((req,res)=>res.end('{}'));
  for(const s of [native,management]){s.listen(0,'127.0.0.1');await once(s,'listening');}
  const mount=await startNativeReadMount({managementOrigin:'http://127.0.0.1:'+management.address().port,nativeOrigin:'http://127.0.0.1:'+native.address().port,managementToken:'m'.repeat(64),nativeToken:'n'.repeat(64),uiRoot:dir,nativeDist:dir,webSocket,skillTrialGate:gate});
  let socket;
  try {
    const issued=await fetch(mount.origin+'/api/native-mount/session',{method:'POST',headers:{Authorization:'Bearer '+mount.token,Origin:mount.origin,'Content-Type':'application/json'},body:'{}'});
    const cookie=issued.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await fetch(mount.origin+'/api/native-mount/skill-trial',{headers:{Cookie:cookie}})).json()).trial.parentTurnsRemaining,2);
    socket=new WebSocket(mount.origin.replace('http:','ws:')+'/ws',{headers:{Cookie:cookie,Origin:mount.origin}});await once(socket,'open');
    const command={type:'thread.turn.start',commandId:'manual-1',threadId:'ordinary',modelSelection:{instanceId:'codex',model:'gpt-6-astra',options:{reasoningEffort:'low'}},message:{role:'user',text:'$grill-me synthetic',context:{records:[{kind:'skill',name:'grill-me',path:'/fixture/SKILL.md'}]}}};
    const rpc=(id,payload)=>({_tag:'Request',id,tag:'orchestration.dispatchCommand',payload,headers:[]});
    let reply=once(socket,'message');socket.send(JSON.stringify(rpc('first',command)));assert.equal(JSON.parse((await reply)[0]).exit._tag,'Success');
    reply=once(socket,'message');socket.send(JSON.stringify(rpc('recovery',command)));assert.equal(JSON.parse((await reply)[0]).exit._tag,'Success');assert.equal(sends,1);
    reply=once(socket,'message');socket.send(JSON.stringify(rpc('private',{...command,commandId:'forbidden',threadId:'private-user'})));assert.equal(JSON.parse((await reply)[0]).exit._tag,'Failure');assert.equal(sends,1);
    assert.equal((await fetch(mount.origin+'/api/orchestration/commands/private-user-command/receipt',{headers:{Cookie:cookie}})).status,403);
    assert.equal((await (await fetch(mount.origin+'/api/orchestration/commands/manual-1/receipt',{headers:{Cookie:cookie}})).json()).resultSequence,3);assert.equal(reads,1);
    assert.equal((await (await fetch(mount.origin+'/api/native-mount/skill-trial',{headers:{Cookie:cookie}})).json()).trial.parentTurnsRemaining,1);
  } finally {
    socket?.terminate();await mount.close();for(const s of upstream.clients)s.terminate();upstream.close();
    for(const s of [native,management]){s.closeAllConnections();await new Promise(done=>s.close(done));}
    await rm(dir,{recursive:true,force:true});
  }
});
