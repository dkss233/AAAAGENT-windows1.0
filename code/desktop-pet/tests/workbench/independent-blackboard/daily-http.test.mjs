import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startNativeReadMount } from '../../../workbench/native-mount/server.mjs';
import { createDailyBoardService } from '../../../workbench/independent-blackboard/service.mjs';
import { boardActorRequest } from '../../../workbench/independent-blackboard/client.mjs';
import { readPrivateBoardJson } from '../../../workbench/independent-blackboard/registry.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../..');
const ws=await import(pathToFileURL(process.env.NATIVE_MOUNT_WS_MODULE).href);
const webSocket={WebSocket:ws.default,WebSocketServer:ws.default.WebSocketServer};

test('actual mount registration, private role CLI, scoped reader and UTF-8 assignments use the existing board store without model dispatch',async t=>{
  const parent=resolve(root,'artifacts/W0-I/web-execution-56/independent-board-daily-01/fixtures');mkdirSync(parent,{recursive:true});
  const temp=mkdtempSync(resolve(parent,'http-'));writeFileSync(resolve(temp,'index.html'),'<p>controlled original static entry</p>');
  const scope={environmentId:'controlled-http',projectId:'original-project'},actors=[{actorId:'c',threadId:'original-c',providerInstanceId:'codex',title:'C',role:'coordinator'},
    {actorId:'a',threadId:'original-a',providerInstanceId:'codex',title:'A',role:'executor'},{actorId:'b',threadId:'original-b',providerInstanceId:'codex',title:'B',role:'executor'}];
  const threads=new Map(actors.map(p=>[p.threadId,{id:p.threadId,projectId:scope.projectId,deletedAt:null,archivedAt:null,modelSelection:{instanceId:'codex',model:'controlled'},runtimeMode:'approval-required',interactionMode:'default',worktreePath:resolve(temp,'tree-'+p.actorId),branch:'codex/'+p.actorId}]));
  let nativeAuth=true,dispatches=0;
  const native=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(!nativeAuth){res.statusCode=401;res.end('{}');return;}
    res.end(JSON.stringify(req.url==='/api/auth/session'?{authenticated:true,scopes:['orchestration:read','orchestration:operate']}:req.url==='/.well-known/t3/environment'?scope:{}));});
  const management=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end('{}');});
  let mount;
  t.after(async()=>{await mount?.close();for(const s of [native,management]){s.closeAllConnections();if(s.listening)await new Promise(done=>s.close(done));}rmSync(temp,{recursive:true,force:true});});
  for(const s of [native,management]){s.listen(0,'127.0.0.1');await once(s,'listening');}
  const client={environmentDescriptor:async()=>scope,shellSnapshot:async()=>({projects:[{id:scope.projectId,workspaceRoot:temp,deletedAt:null}]}),threadSnapshot:async id=>({thread:structuredClone(threads.get(id))}),
    readReceipt:async()=>null,dispatch:async()=>{dispatches++;throw Error('no model dispatch in HTTP boundary trial');}};
  const gate={capability:()=>({environmentId:scope.environmentId}),targetCapability:async threadId=>({...scope,threadId,source:'t3',readonly:false,providerInstanceId:'codex',nativeSessionId:null})};
  const service=createDailyBoardService({directory:resolve(temp,'boards'),client,gate});
  mount=await startNativeReadMount({nativeOrigin:'http://127.0.0.1:'+native.address().port,managementOrigin:'http://127.0.0.1:'+management.address().port,
    nativeToken:'n'.repeat(64),managementToken:'m'.repeat(64),uiRoot:temp,nativeDist:temp,webSocket,executionGate:gate,independentBlackboardService:service,
    independentBlackboardReader:async scope=>{try{return{status:200,body:await service.read(scope)};}catch{return{status:404,body:{error:'board_unavailable'}};}}});
  service.setOrigin(mount.origin);
  const register=()=>fetch(mount.origin+'/api/independent-blackboard/register',{method:'POST',headers:{Authorization:'Bearer '+mount.token,Origin:mount.origin,'Content-Type':'application/json'},body:JSON.stringify({scope,participants:actors})});
  const registered=await register();assert.equal(registered.status,200);const publicRecord=await registered.json(),cookie=registered.headers.get('set-cookie').split(';')[0];
  const same=await fetch(mount.origin+'/api/independent-blackboard/register',{method:'POST',headers:{Cookie:cookie,Origin:mount.origin,'Content-Type':'application/json'},body:JSON.stringify({scope,participants:actors})});
  assert.equal(same.status,200);assert.deepEqual(await same.json(),publicRecord);
  assert.equal(publicRecord.dispatchEnabled,false);assert.equal(dispatches,0);
  const c=publicRecord.participants.find(p=>p.actorId==='c'),a=publicRecord.participants.find(p=>p.actorId==='a');
  const child=spawn(process.execPath,[resolve(root,'code/desktop-pet/workbench/independent-blackboard/client.mjs'),'--context',c.contextFile,'read','-'],{stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.end(JSON.stringify({operationId:'actual-cli-read',expectedRevision:0}));
  assert.equal((await once(child,'close'))[0],0,stderr);const cliRead=JSON.parse(stdout);assert.equal(cliRead.snapshot.revision,1);assert.equal(cliRead.operationId,'actual-cli-read');
  assert.equal(stdout.includes(readPrivateBoardJson(c.contextFile).capability),false);
  let read=await boardActorRequest(c.contextFile,'read');assert.equal(read.snapshot.revision,2);
  const result=await boardActorRequest(c.contextFile,'assign',{tasks:[{taskId:'ta',ownerActorId:'a',title:'A',instructions:'准确中文'.repeat(975)},{taskId:'tb',ownerActorId:'b',title:'B',instructions:'实际分工'.repeat(975)}]},{expectedRevision:read.snapshot.revision});
  assert.equal(result.snapshot.tasks[0].instructions,'准确中文'.repeat(975));assert.equal(result.snapshot.tasks[1].instructions,'实际分工'.repeat(975));
  await assert.rejects(boardActorRequest(a.contextFile,'assign',{tasks:[]},{expectedRevision:2}),/board_actor_rejected/);
  const header={'Content-Type':'application/json',Origin:mount.origin};
  assert.equal((await fetch(mount.origin+'/api/independent-blackboard/actor',{method:'POST',headers:header,body:'{}'})).status,401);
  const privateContext=readPrivateBoardJson(c.contextFile);
  assert.equal((await fetch(mount.origin+'/api/independent-blackboard/actor',{method:'POST',headers:{...header,Authorization:'Bearer '+privateContext.capability,Origin:'http://foreign.invalid'},body:'{}'})).status,403);
  const boardPath='/api/orchestration/projects/'+scope.projectId+'/independent-blackboard?environmentId='+scope.environmentId;
  assert.equal((await fetch(mount.origin+boardPath)).status,401);
  const visible=await fetch(mount.origin+boardPath,{headers:{Cookie:cookie}});assert.equal(visible.status,200);const board=await visible.json();assert.equal(board.relations.length,2);
  assert.equal(board.relations[0].sourceThreadId,'original-c');assert.equal(board.relations[0].targetThreadId,'original-a');assert.equal(JSON.stringify(board).includes(privateContext.capability),false);
  assert.equal((await fetch(mount.origin+boardPath.replace(scope.environmentId,'wrong-scope'),{headers:{Cookie:cookie}})).status,404);
  read=await boardActorRequest(c.contextFile,'read');await assert.rejects(boardActorRequest(c.contextFile,'dispatch',{taskId:'ta'},{expectedRevision:read.snapshot.revision}),/board_actor_rejected/);
  nativeAuth=false;assert.equal((await register()).status,409);assert.equal(dispatches,0);
});
