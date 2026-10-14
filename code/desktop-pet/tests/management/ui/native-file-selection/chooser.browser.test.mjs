import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

// All requests are fulfilled from memory. This does not observe installed services or private data.
const root=resolve('../..'),ui=resolve('management/ui');
const evidence=resolve(process.env.RAW_ENTRY_EVIDENCE??'../../artifacts/W1/native-chat-history-54/file-selection-54/browser');
assert.ok(evidence.startsWith(join(root,'artifacts/W1/native-chat-history-54/')));
assert.ok(process.env.PLAYWRIGHT_MODULE,'Use the existing browser runtime; install nothing');
const red=process.env.FILE_SELECTION_RED==='1';
const modules=new Map(await Promise.all((await readdir(ui)).filter(n=>/\.(mjs|css|html)$/.test(n)).map(async n=>[n,await readFile(join(ui,n),'utf8')])));
if(red)for(const n of ['app.mjs','self-setup-view.mjs'])modules.set(n,execFileSync('git',['show',`e4caa0a4d1fc407d8e99195b5689e8037ce6c839:code/desktop-pet/management/ui/${n}`],{cwd:root,encoding:'utf8'}));
const original='http://127.0.0.1:55101',gateway='http://127.0.0.1:55102';
const relation={version:'0.1.1',origin:original,path:'/',environmentId:'controlled-env',navigationId:'12345678-abcd-abcd-abcd-123456789abc'};
const {managementEntryScript}=await import('../../../../workbench/native-mount/management-entry.mjs');
const child='<!doctype html><meta charset="utf-8"><div id="root" class="aaa-workspace-shell"><button id="return" class="aaa-menu-trigger">受控返回原管理</button><textarea aria-label="受控原生草稿"></textarea></div><script>window.contextId=Math.random();document.getElementById("return").onclick=()=>parent.postMessage({source:"aaa-workspace-ui",version:1,type:"management.navigate",page:"overview"},location.origin);</script>';
const providers=Object.fromEntries(['dialogue','perception','tts','memory_turn','summary','admission'].map(slot=>[slot,{model:'controlled-model',provider:'deepseek',adapterId:'controlled',credentialRef:'controlled-credential',endpoint:''}]));
const saved={providers,context:{maxRecentMessages:10,maxMemories:10,summaryLimit:2,summaryMinMessages:10,summaryMaxMessages:20,timeoutMs:1000}};
const settings={revision:1,effectiveRevision:1,pending:false,applyOn:'restart',saved,effective:saved,history:[]};
const snapshot={apiVersion:1,runtime:{online:true,characterId:'companion',instanceId:'controlled-instance',sourceRevision:'controlled-source',pid:0,startedAt:'2026-10-02T00:00:00Z',observedAt:'2026-10-02T00:00:00Z'},characters:[{id:'companion',label:'受控角色'}],settings,modules:[],adapters:[],balances:{providers:[]}};
const setupSnapshot={apiVersion:1,instanceId:'controlled-instance',mode:'runtime',credentialRevision:1,credentials:[],settings,adapters:[],references:[],operations:[],initialization:{blockers:[],completed:false},links:{}};
const {webkit}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser=await webkit.launch({headless:true}),observations=[];
await mkdir(evidence,{recursive:true});
async function setup({status=503,mode='original-management',frameOrigin=gateway,relationChange={},mountEnvironment='controlled-env',holdNative=false,holdOpen=false,initialGateway=false,initialPath='/native/'}={}){
 const context=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'reduce'}),page=await context.newPage(),requests=[],errors=[],blocked=[];
 page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(6000);
 await page.addInitScript(()=>{
  if(location.origin==='http://127.0.0.1:55101')sessionStorage.setItem('pet-management-session-v1','controlled-not-a-real-credential');window.pageLeaves=0;
  if(location.origin==='http://127.0.0.1:55102'&&!sessionStorage.getItem('pet-management-session-v1'))sessionStorage.setItem('pet-management-session-v1','a'.repeat(64));
  addEventListener('pagehide',()=>window.pageLeaves++);
  for(const name of ['WebSocket','EventSource'])window[name]=class{constructor(){throw Error('controlled blocks '+name);}};
  if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>Promise.reject(Error('controlled blocks device'));
 });
 let nativeRelease,openRelease;const nativeGate=new Promise(r=>nativeRelease=r),openGate=new Promise(r=>openRelease=r);
 let instance='controlled-instance',setupInstance='controlled-instance';
 await page.route('**/*',async route=>{
  const r=route.request(),url=new URL(r.url());requests.push({origin:url.origin,method:r.method(),path:url.pathname});
  if(![original,gateway].includes(url.origin)){blocked.push(url.origin+url.pathname);return route.abort();}
  if(url.origin===gateway&&url.pathname==='/open')return route.fulfill({contentType:'text/html',body:`<!doctype html><p id="state">受控已有landing</p><script>${managementEntryScript}</script>`});
  if(url.origin===gateway&&url.pathname==='/launch'){
   assert.equal(r.method(),'POST');assert.deepEqual(JSON.parse(r.postData()),{ticket:'A'.repeat(43)});
   return route.fulfill({json:{url:gateway+'/?nativePath='+encodeURIComponent('/native/'),managementToken:'a'.repeat(64),originalManagementReturn:{...relation,...relationChange}}});
  }
  if(url.origin===gateway&&url.pathname.startsWith('/native/')){if(holdNative)await nativeGate;return route.fulfill({contentType:'text/html',body:child});}
  if(url.pathname.startsWith('/api/')){
   assert.equal(r.headers().authorization,'Bearer '+(url.origin===original?'controlled-not-a-real-credential':'a'.repeat(64)));
   if(url.pathname==='/api/snapshot'&&r.method()==='GET')return route.fulfill({json:{...snapshot,runtime:{...snapshot.runtime,instanceId:instance}}});
   if(url.pathname==='/api/self-setup'&&r.method()==='GET')return url.origin===original?route.fulfill({json:{...setupSnapshot,instanceId:setupInstance}}):route.fulfill({status:404,json:{error:{message:'controlled not configured'}}});
   if(url.pathname==='/api/wake'&&r.method()==='GET')return route.fulfill({json:{version:'0.1.0',instanceId:instance,revision:1,settings:{keyword:'乐正绫',sensitivity:'standard',silenceMs:1500},available:false,session:{generation:0,enabled:false,phase:'off'}}});
   // The original raw server has no same-origin mounted-native endpoint.
   if(url.pathname==='/api/native-mount/session')return url.origin===original?route.fulfill({status:404,json:{error:{message:'controlled raw endpoint absent'}}}):route.fulfill({json:{apiVersion:1,mode:'native-read',mountPath:'/native/',readonly:true,environmentId:mountEnvironment,expiresAt:new Date(Date.now()+60000).toISOString()}});
   if(url.pathname==='/api/workbench/native-open'){
    assert.equal(url.origin,original);assert.equal(r.method(),'POST');assert.deepEqual(JSON.parse(r.postData()),{target:'home'});if(holdOpen)await openGate;
    return status===200?route.fulfill({json:{version:'0.1.0',status:'ready',target:{kind:'home',environmentId:'controlled-env'},url:gateway+'/open#'+'A'.repeat(43),expiresAt:new Date(Date.now()+50000).toISOString(),originalManagementReturn:{...relation,...relationChange}}}):route.fulfill({status,json:{error:{message:'controlled native unavailable'}}});
   }
   blocked.push(r.method()+' '+url.pathname);return route.abort();
  }
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(modules.has(name)){
   let body=modules.get(name);
   if(name==='index.html')body=body.replace('</head>',`<meta name="aaa-management-entry" data-version="0.1.0" content="${url.origin===gateway?'mounted-readonly':mode}">${frameOrigin===null?'':`<meta name="aaa-management-frame-origin" data-version="0.1.0" content="${frameOrigin}">`}</head>`);
   return route.fulfill({contentType:name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'text/javascript',body});
  }
  blocked.push(url.pathname);return route.abort();
 });
 await page.goto(initialGateway?gateway+'/?nativePath='+encodeURIComponent(initialPath):original+'/');await page.waitForFunction(()=>document.querySelector('#refresh')?.disabled===false);
 return {page,context,requests,errors,blocked,releaseNative:nativeRelease,releaseOpen:openRelease,changeInstance:()=>{instance='controlled-new-instance';},changeSetupInstance:()=>{setupInstance='controlled-new-setup-instance';},child:()=>page.frames().find(f=>new URL(f.url()).pathname.startsWith('/native/'))};
}

const selected={name:'controlled-reference.wav',mimeType:'audio/wav',buffer:Buffer.from('controlled selected bytes; never uploaded or decoded')};
async function prepare(s){
 const p=s.page;await p.locator('#nav-models').click();await p.locator('#setup-key').waitFor();await p.locator('#wake-keyword').waitFor();
 await p.locator('#setup-voice-label').fill('受控未保存音色');await p.locator('#setup-voice-text').fill('受控未保存试听文本');await p.locator('#setup-key').fill('controlled-unsaved-key');
}
async function choose(s,keyboard=false){
 const waiting=s.page.waitForEvent('filechooser');
 if(keyboard){await s.page.locator('#setup-audio').focus();await s.page.locator('#setup-audio').press('Enter');}
 else await s.page.locator('#setup-audio').click();
 return waiting;
}
async function assertSelected(s){
 const p=s.page;await p.getByText('已选择：'+selected.name,{exact:true}).waitFor();assert.equal(await p.locator('#setup-upload').isEnabled(),true);
 assert.equal(await p.locator('#setup-audio').evaluate(e=>e.files?.[0]?.name),selected.name);
 assert.equal(await p.locator('#setup-key').inputValue(),'controlled-unsaved-key');assert.equal(await p.locator('#setup-voice-label').inputValue(),'受控未保存音色');assert.equal(await p.locator('#setup-voice-text').inputValue(),'受控未保存试听文本');
}
async function finish(s,name,extra={}){
 assert.deepEqual(s.errors,[]);assert.deepEqual(s.blocked,[]);
 assert.ok(s.requests.filter(r=>r.method!=='GET').every(r=>(r.origin===original&&r.path==='/api/workbench/native-open')||(r.origin===gateway&&['/launch','/api/native-mount/session'].includes(r.path))));
 observations.push({name,passed:true,level:'controlled original app and real browser filechooser event; native OS sheet and actual installed services are not used',requests:s.requests,errors:s.errors,blocked:s.blocked,...extra});
}
try{
 await test('original chooser input stays connected across the real 2/3 second polls before delayed selection completes',async()=>{
  const s=await setup();
  try{
   await prepare(s);const chooser=await choose(s),input=chooser.element();
   await s.page.evaluate(()=>window.chooserRoot=document.querySelector('#app').firstElementChild);
   const before=s.requests.filter(r=>r.path==='/api/self-setup'||r.path==='/api/wake').length;
   await s.page.waitForTimeout(3400);
   const connected=await input.evaluate(e=>e.isConnected&&e===document.getElementById('setup-audio'));
   observations.push({name:'delayed chooser original target',red,connected,pollsDuringWait:s.requests.filter(r=>r.path==='/api/self-setup'||r.path==='/api/wake').length-before,level:'browser interception of original filechooser; not actual OS dialog'});
   await s.page.screenshot({path:join(evidence,red?'original-delayed-chooser-red.png':'delayed-chooser-target-retained.png')});
   assert.equal(connected,true,'the exact chooser target must remain in the original document while the user is choosing');
   assert.equal(await s.page.evaluate(()=>window.chooserRoot===document.querySelector('#app').firstElementChild),true,'the original form document must not be reconstructed while the picker is pending');
   await chooser.setFiles(selected);await assertSelected(s);
   await s.page.waitForTimeout(3400);assert.equal(await input.evaluate(e=>e===document.getElementById('setup-audio')),true);await assertSelected(s);
   await finish(s,'delayed choice completes and later readonly polls retain FileList/private file');
  }finally{await s.context.close();}
 });
 if(!red){
  await test('keyboard chooser uses the same retention guard and successful selection',async()=>{
   const s=await setup();try{await prepare(s);const chooser=await choose(s,true);await s.page.waitForTimeout(3400);assert.equal(await chooser.element().evaluate(e=>e.isConnected),true);await chooser.setFiles(selected);await assertSelected(s);await finish(s,'keyboard delayed chooser');}finally{await s.context.close();}
  });
  await test('cancelling another selection keeps the prior File and resumes normal rendering',async()=>{
   const s=await setup();try{
    await prepare(s);await (await choose(s)).setFiles(selected);await assertSelected(s);
    await s.page.evaluate(()=>{window.priorFile=document.getElementById('setup-audio').files[0];window.priorRoot=document.querySelector('#app').firstElementChild;});
    const chooser=await choose(s);await s.page.waitForTimeout(3400);assert.equal(await chooser.element().evaluate(e=>e.isConnected),true);
    await chooser.element().dispatchEvent('cancel');
    await s.page.waitForFunction(()=>window.priorRoot!==document.querySelector('#app').firstElementChild);
    await assertSelected(s);assert.equal(await s.page.evaluate(()=>window.priorFile===document.getElementById('setup-audio').files[0]),true);
    await finish(s,'controlled cancel event preserves prior exact File and releases render');
   }finally{await s.context.close();}
  });
  await test('explicit original-document interaction releases a chooser with no cancel notification without replacing the selected input',async()=>{
   const s=await setup();try{
    await prepare(s);await (await choose(s)).setFiles(selected);await assertSelected(s);const chooser=await choose(s);
    await s.page.evaluate(()=>window.priorRoot=document.querySelector('#app').firstElementChild);
    await s.page.locator('#setup-key').click();await s.page.waitForFunction(()=>window.priorRoot!==document.querySelector('#app').firstElementChild);
    assert.equal(await chooser.element().evaluate(e=>e.isConnected&&e===document.getElementById('setup-audio')),true);await assertSelected(s);
    await finish(s,'explicit document interaction fallback after controlled cancellation');
   }finally{await s.context.close();}
  });
  await test('changed setup identity clears the current File and rejects completion from the old chooser target',async()=>{
   const s=await setup();try{
    await prepare(s);await (await choose(s)).setFiles(selected);await assertSelected(s);const chooser=await choose(s),input=chooser.element();s.changeSetupInstance();
    await s.page.waitForFunction(()=>document.querySelector('#setup-key')?.value==='');assert.equal(await input.evaluate(e=>e.isConnected),false);
    await chooser.setFiles({...selected,name:'old-scope-stale.wav'});await s.page.waitForTimeout(100);
    assert.equal(await s.page.locator('#setup-audio').evaluate(e=>e.files.length),0);assert.equal(await s.page.locator('#setup-upload').isDisabled(),true);assert.equal(await s.page.getByText('已选择：old-scope-stale.wav',{exact:true}).count(),0);
    await finish(s,'changed setup instance retires old selector and late File');
   }finally{await s.context.close();}
  });
  await test('leaving the original settings page clears selection and old events cannot restore it on reentry',async()=>{
   const s=await setup();try{
    await prepare(s);await (await choose(s)).setFiles(selected);const chooser=await choose(s);
    await s.page.locator('#nav-overview').click();await s.page.locator('#nav-models').click();await s.page.locator('#setup-audio').waitFor();
    assert.equal(await chooser.element().evaluate(e=>e.isConnected),false);await chooser.setFiles({...selected,name:'stopped-scope-stale.wav'});await s.page.waitForTimeout(100);
    assert.equal(await s.page.locator('#setup-audio').evaluate(e=>e.files.length),0);assert.equal(await s.page.locator('#setup-upload').isDisabled(),true);
    await finish(s,'original stop/reentry retires old selector and rejects late File');
   }finally{await s.context.close();}
  });
  await test('successful delayed File remains the exact File/DOM through original native parent Return and reentry',async()=>{
   const s=await setup({status:200}),p=s.page;try{
    await prepare(s);const chooser=await choose(s);await p.waitForTimeout(3400);await chooser.setFiles(selected);await assertSelected(s);
    const before=await p.evaluate(()=>{window.priorFile=document.getElementById('setup-audio').files[0];window.priorInput=document.getElementById('setup-audio');document.querySelector('.main').scrollTop=120;return document.querySelector('.main').scrollTop;});
    await p.locator('#nav-workbench').click();await p.waitForFunction(()=>document.querySelector('.native-workbench-portal')?.dataset.phase==='ready');
    const child=s.child(),context=await child.evaluate(()=>window.contextId);await child.getByLabel('受控原生草稿').fill('受控同框草稿');await p.waitForTimeout(3400);
    await child.locator('#return').click();await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').hidden);await assertSelected(s);
    assert.equal(await p.evaluate(()=>window.priorInput===document.getElementById('setup-audio')&&window.priorFile===document.getElementById('setup-audio').files[0]),true);assert.equal(await p.locator('.main').evaluate(e=>e.scrollTop),before);assert.equal(await p.locator('.main h1').innerText(),'模型与声音');
    await p.screenshot({path:join(evidence,'selected-file-original-return.png')});await p.locator('#nav-workbench').click();await p.waitForFunction(()=>!document.querySelector('.native-workbench-portal').hidden);
    assert.equal(await child.evaluate(()=>window.contextId),context);assert.equal(await child.getByLabel('受控原生草稿').inputValue(),'受控同框草稿');assert.equal(s.requests.filter(r=>r.path==='/api/workbench/native-open').length,1);
    await finish(s,'delayed exact File and original native parent Return/reentry retained');
   }finally{await s.context.close();}
  });
 }
}finally{await writeFile(join(evidence,'observations.json'),JSON.stringify(observations,null,2)+'\n');await browser.close();}
