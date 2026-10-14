import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {startNativeReadMount} from '../../../workbench/native-mount/server.mjs';
import {nativeRecoveryTarget,nativeRecoveryScript} from '../../../workbench/native-mount/management-entry.mjs';
const ws=await import(pathToFileURL(process.env.NATIVE_MOUNT_WS_MODULE).href);
const webSocket={WebSocket:ws.default,WebSocketServer:ws.default.WebSocketServer};

test('recovery selects only bounded document targets',()=>{
 const origin='http://127.0.0.1:51234';
 assert.deepEqual(nativeRecoveryTarget('/native/exact-env/exact-thread',origin),{path:'/native/exact-env/exact-thread',environmentId:'exact-env'});
 assert.deepEqual(nativeRecoveryTarget('/native/?aaaProject=exact-project&aaaEnvironment=exact-env',origin),{path:'/native/?aaaProject=exact-project&aaaEnvironment=exact-env',environmentId:'exact-env'});
 assert.deepEqual(nativeRecoveryTarget('/native/',origin),{path:'/native/',environmentId:null});
 for(const path of ['https://evil.invalid/native/a/b','//evil.invalid/native/a/b','/native/pair','/native/login/target','/native/assets/app.js','/native/a/%2fsecret','/native/a/b?next=https://evil.invalid','/native/a/b#token','/native/a/b/c','/native/?aaaProject=p&aaaEnvironment=e&aaaEnvironment=another','/native/a/..'])assert.equal(nativeRecoveryTarget(path,origin),null,path);
});

test('expired navigation renews using existing tab authority and exact target; APIs stay gated and drafts untouched',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aaa-session-recovery-'));
 await writeFile(join(dir,'index.html'),'<p>authorized native app</p>');
 let authorized=true,environmentId='exact-env';const calls=[];
 const native=createServer((req,res)=>{
  calls.push(['native',req.method,req.url]);res.setHeader('Content-Type','application/json');
  if(!authorized){res.statusCode=401;res.end('{}');return;}
  res.end(JSON.stringify(req.url==='/api/auth/session'?{authenticated:true,scopes:['orchestration:read']}:{environmentId}));
 });
 const management=createServer((req,res)=>{calls.push(['management',req.method,req.url]);res.end('{}');});
 for(const server of [native,management]){server.listen(0,'127.0.0.1');await once(server,'listening');}
 const mount=await startNativeReadMount({managementOrigin:'http://127.0.0.1:'+management.address().port,nativeOrigin:'http://127.0.0.1:'+native.address().port,managementToken:'m'.repeat(64),nativeToken:'n'.repeat(64),uiRoot:dir,nativeDist:dir,webSocket,sessionTtlMs:80});
 let cookie;
 try{
  const first=await fetch(mount.origin+'/api/native-mount/session',{method:'POST',headers:{Authorization:'Bearer '+mount.token,Origin:mount.origin,'Content-Type':'application/json'},body:'{}'});
  assert.equal(first.status,200);cookie=first.headers.get('set-cookie').split(';')[0];await first.json();
  await new Promise(done=>setTimeout(done,100));
  const path='/native/exact-env/exact-thread';
  const denied=await fetch(mount.origin+'/api/auth/session',{headers:{Cookie:cookie,Accept:'text/html'}});
  assert.equal(denied.status,401);assert.match(denied.headers.get('content-type'),/charset=utf-8/);assert.equal((await denied.json()).message,'本机会话已失效，请从控制台重新连接。');
  assert.equal((await fetch(mount.origin+'/native/assets/app.js',{headers:{Cookie:cookie,Accept:'text/html'}})).status,401);
  const doc=await fetch(mount.origin+path,{headers:{Cookie:cookie,Accept:'text/html'}}),html=await doc.text();
  assert.equal(doc.status,200);assert.match(doc.headers.get('content-type'),/text\/html; charset=utf-8/);
  assert.match(html,/恢复工程连接/);assert.match(html,/native-session-recovery.js/);assert(!html.includes(mount.token));assert(!html.includes('authorized native app'));
  const script=await fetch(mount.origin+'/native-session-recovery.js');assert.match(script.headers.get('content-type'),/charset=utf-8/);assert.equal(await script.text(),nativeRecoveryScript);
  const draft='下午好呀';
  async function recover(token=mount.token){
   const storage=new Map([['pet-management-session-v1',token],['existing-draft',draft]]),navigations=[],requests=[];
   let finish;const finished=new Promise(done=>finish=done),state={textContent:''},retry={addEventListener(){}};
   Object.defineProperty(retry,'disabled',{set:value=>{if(!value)finish();}});
   runInNewContext(nativeRecoveryScript,{URL,Date,AbortSignal,location:{origin:mount.origin,pathname:path,search:'',replace:url=>navigations.push(url)},
    sessionStorage:{getItem:key=>storage.get(key)},document:{getElementById:id=>id==='state'?state:retry},
    fetch:async(url,options)=>{requests.push([url,options.method]);const response=await fetch(mount.origin+url,{...options,headers:{...options.headers,Origin:mount.origin,Cookie:cookie}});if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response;}});
   await finished;assert.equal(storage.get('existing-draft'),draft);return {navigations,requests,message:state.textContent};
  }
  const missing=await recover('');assert.deepEqual(missing.navigations,[]);assert.deepEqual(missing.requests,[]);assert.match(missing.message,/缺少续接授权/);
  const recovered=await recover();assert.deepEqual(recovered.navigations,[path]);assert.deepEqual(recovered.requests,[['/api/native-mount/session','POST']]);
  assert.match(await(await fetch(mount.origin+path,{headers:{Cookie:cookie,Accept:'text/html'}})).text(),/authorized native app/);
  environmentId='another-env';const changed=await recover();assert.deepEqual(changed.navigations,[]);assert.match(changed.message,/无法恢复/);
  authorized=false;const revoked=await recover();assert.deepEqual(revoked.navigations,[]);
  assert.equal((await fetch(mount.origin+'/api/orchestration/dispatch',{method:'POST',headers:{Origin:mount.origin,Accept:'text/html'},body:'{}'})).status,401);
  assert(calls.every(([,method])=>method==='GET'));assert(!calls.some(([, ,url])=>/dispatch|turn/.test(url)));
 }finally{
  await mount.close();for(const server of [native,management]){server.closeAllConnections();await new Promise(done=>server.close(done));}await rm(dir,{recursive:true,force:true});
 }
});
