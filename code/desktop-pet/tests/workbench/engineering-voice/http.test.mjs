import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startNativeReadMount } from '../../../workbench/native-mount/server.mjs';
import { createEngineeringVoiceService } from '../../../workbench/engineering-voice/service.mjs';
import { pcm16Wav } from '../../../dist/media/wav.js';

test('original mounted cookie, origin and environment protect real HTTP ASR admission and cold receipt',async()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'aaa-voice-http-')));writeFileSync(join(dir,'index.html'),'<html></html>');
  const ws=await import(pathToFileURL(process.env.NATIVE_MOUNT_WS_MODULE).href), WebSocket=ws.default,WebSocketServer=ws.default.WebSocketServer;
  let operate=true,calls=0,turns=0;
  const native=createServer((req,res)=>{res.setHeader('Content-Type','application/json');assert.equal(req.headers.authorization,'Bearer '+'n'.repeat(64));
    if(req.url==='/api/auth/session')return res.end(JSON.stringify({authenticated:true,scopes:operate?['orchestration:read','orchestration:operate']:['orchestration:read']}));
    if(req.url==='/.well-known/t3/environment')return res.end(JSON.stringify({environmentId:'env'}));
    if(req.method==='POST')turns++;res.statusCode=404;res.end('{}');});
  const management=createServer((req,res)=>res.end('{}'));
  for(const server of [native,management]){server.listen(0,'127.0.0.1');await once(server,'listening');}
  const thread={id:'thread',projectId:'project',modelSelection:{instanceId:'codex',model:'gpt-6.1-sol'}};
  const client={environmentDescriptor:async()=>({environmentId:'env'}),shellSnapshot:async()=>({projects:[{id:'project',workspaceRoot:dir}],threads:[thread]}),threadSnapshot:async()=>({thread})};
  const gate={capability:()=>({environmentId:'env'}),targetCapability:async()=>({environmentId:'env',projectId:'project',source:'t3',readonly:false,providerInstanceId:'codex',nativeSessionId:'native'})};
  const voice=createEngineeringVoiceService({directory:join(dir,'receipts'),client,gate,asr:{model:'controlled-asr',transcribe:async()=>{calls++;return '原话 十二';}}});
  const mount=await startNativeReadMount({managementOrigin:'http://127.0.0.1:'+management.address().port,nativeOrigin:'http://127.0.0.1:'+native.address().port,
    managementToken:'m'.repeat(64),nativeToken:'n'.repeat(64),uiRoot:dir,nativeDist:dir,webSocket:{WebSocket,WebSocketServer},executionGate:gate,engineeringVoiceService:voice});
  try{
    const issue=()=>fetch(mount.origin+'/api/native-mount/session',{method:'POST',headers:{Authorization:'Bearer '+mount.token,Origin:mount.origin,'Content-Type':'application/json'},body:'{}'});
    const issued=await issue(),cookie=issued.headers.get('set-cookie').split(';')[0];assert.equal(issued.status,200);
    const target={environmentId:'env',projectId:'project',threadId:'thread',draftId:null,captureEpoch:1};
    const request={version:'0.1.0',inputId:randomUUID(),target,audio:{wavBase64:Buffer.from(pcm16Wav(new Float32Array(160),16000)).toString('base64')}};
    const submit=(body,headers={})=>fetch(mount.origin+'/api/native-mount/voice/transcribe',{method:'POST',headers:{Cookie:cookie,Origin:mount.origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal((await submit(request,{Cookie:''})).status,401);assert.equal((await submit(request,{Origin:'http://127.0.0.1:1'})).status,403);
    assert.equal((await submit({...request,target:{...target,environmentId:'other'}})).status,409);assert.equal(calls,0);
    assert.equal((await fetch(mount.origin+'/api/native-mount/voice/capabilities',{headers:{Cookie:cookie}})).status,200);assert.equal(calls,0);
    const response=await submit(request);assert.equal(response.status,200);const result=await response.json();assert.equal(result.transcript,'原话 十二');assert.deepEqual(result.target,target);
    const receipt=await fetch(mount.origin+'/api/native-mount/voice/receipts/'+request.inputId+'?target='+encodeURIComponent(JSON.stringify(target)),{headers:{Cookie:cookie}});assert.deepEqual(await receipt.json(),result);
    assert.deepEqual(await(await submit(request)).json(),result);assert.equal(calls,1);assert.equal(turns,0);
    operate=false;const readonlyCookie=(await issue()).headers.get('set-cookie').split(';')[0];assert.equal((await submit({...request,inputId:randomUUID()},{Cookie:readonlyCookie})).status,403);assert.equal(calls,1);
  }finally{await mount.close();for(const server of [native,management]){server.closeAllConnections();await new Promise(done=>server.close(done));}rmSync(dir,{recursive:true,force:true});}
});
