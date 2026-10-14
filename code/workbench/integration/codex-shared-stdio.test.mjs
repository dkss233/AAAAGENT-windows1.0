import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { mkdtemp, mkdir, chmod, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codexSharedTransport } from './codex-shared-connection.mjs';
import { bridgeCodexSharedStdio } from './codex-shared-stdio.mjs';

const wsPath=process.env.NATIVE_MOUNT_WS_MODULE;
test('bridge preserves split UTF8, request IDs and server requests; closing it leaves the other peer alive',
  {skip:!wsPath,timeout:15000},async t=>{
  const {default:WebSocket,WebSocketServer}=await import(pathToFileURL(wsPath).href);
  const home=await mkdtemp('/private/tmp/aaa-stdio-'),route=codexSharedTransport(home);
  await mkdir(dirname(route.socketPath),{recursive:true,mode:0o700});
  const http=createServer(),server=new WebSocketServer({server:http}),peers=[];
  server.on('connection',peer=>{
    peers.push(peer);peer.on('message',bytes=>{
      const frame=JSON.parse(String(bytes));
      if(frame.method==='echo')peer.send(JSON.stringify({id:frame.id,result:frame.params}));
      else if(frame.id==='server-request')peer.send(JSON.stringify({method:'server/ack',params:frame.result}));
    });
  });
  http.listen(route.socketPath);await once(http,'listening');await chmod(route.socketPath,0o600);
  const controller=new AbortController(),input=new PassThrough(),output=new PassThrough();
  let desktop,finished;
  t.after(async()=>{
    controller.abort();input.destroy();desktop?.terminate();
    for(const peer of server.clients)peer.terminate();
    await finished?.catch(()=>{});
    await new Promise(resolve=>http.close(resolve));server.close();
    await rm(home,{recursive:true,force:true});
  });
  desktop=new WebSocket(route.desktopWebsocketUrl);await once(desktop,'open');
  const frames=[],waiters=[];let buffer='';
  output.on('data',bytes=>{
    buffer+=String(bytes);let end;
    while((end=buffer.indexOf('\n'))>=0){
      const frame=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);frames.push(frame);
      for(const wake of waiters.splice(0))wake();
    }
  });
  const next=async()=>{
    while(!frames.length)await new Promise(resolve=>waiters.push(resolve));
    return frames.shift();
  };
  finished=bridgeCodexSharedStdio({home,WebSocket,input,output,signal:controller.signal});
  // Attach rejection handling immediately; errors remain observable below.
  finished.catch(()=>{});
  const bytes=Buffer.from(JSON.stringify({id:'request-一',method:'echo',params:{text:'两端同步'}})+'\n');
  const split=bytes.indexOf(Buffer.from('两'))+1;
  input.write(bytes.subarray(0,split));input.write(bytes.subarray(split));
  assert.deepEqual(await next(),{id:'request-一',result:{text:'两端同步'}});
  assert.equal(peers.length,2);
  peers[1].send(JSON.stringify({id:'server-request',method:'approval/request',params:{tool:'fixture'}}));
  assert.deepEqual(await next(),{id:'server-request',method:'approval/request',params:{tool:'fixture'}});
  input.write(JSON.stringify({id:'server-request',result:{approved:false}})+'\n');
  assert.deepEqual(await next(),{method:'server/ack',params:{approved:false}});
  input.end();await finished;
  assert.equal(desktop.readyState,WebSocket.OPEN);
  const reply=once(desktop,'message');desktop.send(JSON.stringify({id:7,method:'echo',params:{stillConnected:true}}));
  assert.deepEqual(JSON.parse(String((await reply)[0])),{id:7,result:{stillConnected:true}});
  assert.equal(http.listening,true);
});
