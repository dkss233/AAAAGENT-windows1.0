import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {startNativeReadMount} from '../../../workbench/native-mount/server.mjs';
const ws=await import(pathToFileURL(process.env.NATIVE_MOUNT_WS_MODULE).href);
const webSocket={WebSocket:ws.default,WebSocketServer:ws.default.WebSocketServer};

test('renewed original lease keeps the cookie and live read stream; revoked authority cannot renew',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aaa-lease-renewal-'));await writeFile(join(dir,'index.html'),'<p>lease fixture</p>');
 let authorized=true,environmentId='exact-environment',rpcCalls=0;
 const native=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(!authorized){res.statusCode=401;res.end('{}');return;}
  res.end(JSON.stringify(req.url==='/api/auth/session'?{authenticated:true,scopes:['orchestration:read']}: {environmentId}));
 });
 const management=createServer((req,res)=>res.end('{}'));
 const upstream=new webSocket.WebSocketServer({server:native});
 upstream.on('connection',socket=>socket.on('message',data=>{rpcCalls++;const m=JSON.parse(data);socket.send(JSON.stringify({_tag:'Exit',requestId:m.id,exit:{_tag:'Success',value:{alive:true}}}));}));
 for(const s of[native,management]){s.listen(0,'127.0.0.1');await once(s,'listening');}
 const mount=await startNativeReadMount({managementOrigin:'http://127.0.0.1:'+management.address().port,nativeOrigin:'http://127.0.0.1:'+native.address().port,managementToken:'m'.repeat(64),nativeToken:'n'.repeat(64),uiRoot:dir,nativeDist:dir,webSocket,sessionTtlMs:1200});
 let socket;
 try{
  const issue=cookie=>fetch(mount.origin+'/api/native-mount/session',{method:'POST',headers:{Authorization:'Bearer '+mount.token,Origin:mount.origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:'{}'});
  const first=await issue();assert.equal(first.status,200);const original=await first.json(),cookie=first.headers.get('set-cookie').split(';')[0];
  socket=new webSocket.WebSocket(mount.origin.replace('http:','ws:')+'/ws',{headers:{Cookie:cookie,Origin:mount.origin}});await once(socket,'open');
  await new Promise(done=>setTimeout(done,700));
  const renewal=await issue(cookie);assert.equal(renewal.status,200);assert.equal(renewal.headers.get('set-cookie').split(';')[0],cookie);const renewed=await renewal.json();assert(Date.parse(renewed.expiresAt)>Date.parse(original.expiresAt));
  await new Promise(done=>setTimeout(done,600));assert.equal(socket.readyState,webSocket.WebSocket.OPEN);
  const reply=once(socket,'message');socket.send(JSON.stringify({_tag:'Request',id:'read-after-first-deadline',tag:'server.getConfig',payload:{},headers:[]}));assert.equal(JSON.parse((await reply)[0]).exit.value.alive,true);assert.equal(rpcCalls,1);
  environmentId='changed-environment';assert.equal((await issue(cookie)).status,503);
  authorized=false;assert.equal((await issue(cookie)).status,401);
  const [code]=await once(socket,'close');assert.equal(code,4401);
  assert.equal((await fetch(mount.origin+'/api/auth/session',{headers:{Cookie:cookie}})).status,401);
 }finally{
  socket?.terminate();await mount.close();for(const s of upstream.clients)s.terminate();upstream.close();
  for(const s of[native,management]){s.closeAllConnections();await new Promise(done=>s.close(done));}await rm(dir,{recursive:true,force:true});
 }
});
