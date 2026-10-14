import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { startNativeReadMount } from '../../../workbench/native-mount/server.mjs';
import { managementEntryScript } from '../../../workbench/native-mount/management-entry.mjs';
const ws=await import(pathToFileURL(process.env.NATIVE_MOUNT_WS_MODULE).href);

test('landing retains bearer only in the current tab and refuses an external response',async()=>{
 async function land(response){
  const writes=[],removed=[],navigations=[],state={textContent:''};
  const origin='http://127.0.0.1:59916';
  runInNewContext(managementEntryScript,{URL,location:{origin,hash:'#controlled-ticket',replace:url=>navigations.push(url)},
   history:{replaceState(){}},sessionStorage:{setItem:(key,value)=>writes.push([key,value]),removeItem:key=>removed.push(key)},
   document:{getElementById:()=>state},fetch:async()=>({ok:true,json:async()=>response})});
  await new Promise(resolve=>setImmediate(resolve));return {writes,removed,navigations,state};
 }
 const response={url:'http://127.0.0.1:59916/?nativePath=%2Fnative%2Fexact-environment%2Foriginal-c',managementToken:'a'.repeat(64)};
 const valid=await land(response);assert.deepEqual(valid.writes,[['pet-management-session-v1',response.managementToken]]);assert.deepEqual(valid.navigations,[response.url]);
 assert.deepEqual(valid.removed,['aaa-original-management-return-v1']);
 const relation={version:'0.1.1',origin:'http://127.0.0.1:55737',path:'/',environmentId:'exact-environment',navigationId:'aece5ce3-b5c0-461a-9998-5a1c7b71e14b'};
 const returning=await land({...response,originalManagementReturn:relation});
 assert.deepEqual(returning.writes,[['aaa-original-management-return-v1',JSON.stringify(relation)],['pet-management-session-v1',response.managementToken]]);
 assert.deepEqual(returning.navigations,[response.url]);assert.equal(returning.removed.length,0);
 for(const invalid of [{...relation,origin:'https://evil.invalid'},{...relation,path:'/other'},{...relation,origin:'http://127.0.0.1:59916'},{...relation,navigationId:'bad'},{...relation,token:'never-copy'}]){
  const denied=await land({...response,originalManagementReturn:invalid});assert.equal(denied.writes.length,0);assert.equal(denied.navigations.length,0);
 }
 for(const url of ['http://evil.invalid/?nativePath=%2Fnative%2Fexact-environment%2Foriginal-c','http://127.0.0.1:59916/?nativePath=https%3A%2F%2Fevil.invalid%2Fnative%2Fa%2Fb']){
  const denied=await land({...response,url});assert.equal(denied.writes.length,0);assert.equal(denied.navigations.length,0);assert.match(denied.state.textContent,/任务不会重新派发/);
 }
});

for(const withOriginalReturn of [false,true])test('exact browser ticket opens original task without replay; original return='+withOriginalReturn,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'aaa-management-entry-'));
 await writeFile(join(dir,'index.html'),'<p>controlled original app</p>');
 const calls=[],targets=[];
 const native=createServer((req,res)=>{calls.push(['native',req.method,req.url]);res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(req.url==='/.well-known/t3/environment'?{environmentId:'exact-environment'}:{authenticated:true}));});
 const management=createServer((req,res)=>{calls.push(['management',req.method,req.url]);res.setHeader('Content-Type','application/json');res.end('{}');});
 for(const s of [native,management]){s.listen(0,'127.0.0.1');await once(s,'listening');}
 const mount=await startNativeReadMount({managementOrigin:'http://127.0.0.1:'+management.address().port,nativeOrigin:'http://127.0.0.1:'+native.address().port,
  managementToken:'m'.repeat(64),nativeToken:'n'.repeat(64),uiRoot:dir,nativeDist:dir,managementBrowserEntry:true,
  webSocket:{WebSocket:ws.default,WebSocketServer:ws.default.WebSocketServer},nativeBrowserTarget:async target=>{
   assert.deepEqual(target,{kind:'task',environmentId:'exact-environment',threadId:'original-c'});targets.push(target);return '/exact-environment/original-c';
  }});
 try{
  for(const path of ['/','/index.html']){
   const response=await fetch(mount.origin+path);assert.equal(response.status,200);
   const html=await response.text();assert.match(html,/<meta name="aaa-management-entry" content="mounted-readonly" data-version="0.1.0">/);
   assert.equal((html.match(/name="aaa-management-entry"/g)||[]).length,1);assert(!html.includes('content="original-management"'));
   assert(response.headers.get('content-security-policy').includes("frame-ancestors 'self' http://127.0.0.1:"+management.address().port));
   assert(!response.headers.get('content-security-policy').includes('*'));
  }
  const headers={Origin:mount.origin,'Content-Type':'application/json'},target={kind:'task',environmentId:'exact-environment',threadId:'original-c'};
  assert.equal((await fetch(mount.origin+'/api/native-mount/open-browser',{method:'POST',headers,body:JSON.stringify(target)})).status,401);
  const authorized={...headers,Authorization:'Bearer '+mount.token};
  for(const originalManagementReturn of ['http://evil.invalid/',{},false])assert.equal((await fetch(mount.origin+'/api/native-mount/open-browser',{method:'POST',headers:authorized,body:JSON.stringify({...target,originalManagementReturn})})).status,400);
  const issue=await fetch(mount.origin+'/api/native-mount/open-browser',{method:'POST',headers:authorized,body:JSON.stringify({...target,...(withOriginalReturn?{originalManagementReturn:true}:{})})});
  assert.equal(issue.status,200);const issued=await issue.json(),ticket=new URL(issued.url).hash.slice(1);
  const launch=await fetch(mount.origin+'/launch',{method:'POST',headers,body:JSON.stringify({ticket})});assert.equal(launch.status,200);
  const result=await launch.json(),url=new URL(result.url);assert.equal(url.origin,mount.origin);assert.equal(url.pathname,'/');assert.equal(url.hash,'');
  assert.equal(url.searchParams.get('nativePath'),'/native/exact-environment/original-c');assert.equal(result.managementToken,mount.token);
  if(withOriginalReturn){
   assert.deepEqual(result.originalManagementReturn,issued.originalManagementReturn);
   assert.equal(result.originalManagementReturn.origin,'http://127.0.0.1:'+management.address().port);
   assert.equal(result.originalManagementReturn.path,'/');assert.equal(result.originalManagementReturn.version,'0.1.1');
   assert.equal(result.originalManagementReturn.environmentId,'exact-environment');
   assert.match(result.originalManagementReturn.navigationId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  }else assert.equal(result.originalManagementReturn,undefined);
  globalThis.document={addEventListener(){},removeEventListener(){}};
  globalThis.window={addEventListener(){},removeEventListener(){}};
  const {nativeEntryTarget}=await import('../../../management/ui/native-workbench-view.mjs');
  assert.deepEqual(nativeEntryTarget(url.searchParams.get('nativePath'),mount.origin,'exact-environment'),
   {path:'/native/exact-environment/original-c',environmentId:'exact-environment'});
  assert.equal(nativeEntryTarget(url.searchParams.get('nativePath'),mount.origin,'different-environment'),null);
  assert(!result.url.includes(mount.token));assert.equal(targets.length,2);
  assert.equal((await fetch(mount.origin+'/launch',{method:'POST',headers,body:JSON.stringify({ticket})})).status,401);
  const cookie=launch.headers.get('set-cookie').split(';')[0];
  const framed=await fetch(mount.origin+'/native/',{headers:{Cookie:cookie}});assert.equal(framed.status,200);
  assert(framed.headers.get('content-security-policy').includes("frame-ancestors 'self' http://127.0.0.1:"+management.address().port));
  assert.equal((await fetch(mount.origin+'/api/snapshot',{headers:{Cookie:cookie}})).status,401);
  assert.equal((await fetch(mount.origin+'/api/snapshot',{headers:{Authorization:'Bearer '+result.managementToken}})).status,200);
  assert.equal((await fetch(mount.origin+'/api/orchestration/dispatch',{method:'POST',headers:{...headers,Cookie:cookie},body:'{}'})).status,403);
  const script=await(await fetch(mount.origin+'/open.js')).text();assert.match(script,/sessionStorage\.setItem/);assert.match(script,/u\.origin!==location\.origin/);
  assert(!script.includes(mount.token));assert(calls.every(c=>c[1]==='GET'));assert(!calls.some(c=>c[2].includes('dispatch')));
 }finally{await mount.close();for(const s of [native,management]){s.closeAllConnections();await new Promise(done=>s.close(done));}await rm(dir,{recursive:true,force:true});}
});
