import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

// All requests are fulfilled from memory. This does not observe installed services or private data.
const root=resolve('../..'),ui=resolve('management/ui');
const evidence=resolve(process.env.RAW_ENTRY_EVIDENCE??'../../artifacts/W1/native-chat-history-54/raw-entry-controlled');
assert.ok(evidence.startsWith(join(root,'artifacts/W1/native-chat-history-54/'))||evidence.startsWith(join(root,'artifacts/W0-I/engine-pin-54/')));
assert.ok(process.env.PLAYWRIGHT_MODULE,'Use the existing browser runtime; install nothing');
const red=process.argv.includes('--red');
const modules=new Map(await Promise.all((await readdir(ui)).filter(n=>/\.(mjs|css|html)$/.test(n)).map(async n=>[n,await readFile(join(ui,n),'utf8')])));
if(red)for(const n of ['app.mjs','native-workbench-view.mjs','workbench-view.mjs'])modules.set(n,execFileSync('git',['show',`7d576ff2d9496a31e344b6eaa486c6d71f505a6d:code/desktop-pet/management/ui/${n}`],{cwd:root,encoding:'utf8'}));
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
async function setup({status=503,mode='original-management',frameOrigin=gateway,relationChange={},mountEnvironment='controlled-env',holdNative=false,holdOpen=false,initialGateway=false,initialPath='/native/',initialOriginal=false}={}){
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
 let instance='controlled-instance';
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
   if(url.pathname==='/api/self-setup'&&r.method()==='GET')return url.origin===original?route.fulfill({json:setupSnapshot}):route.fulfill({status:404,json:{error:{message:'controlled not configured'}}});
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
 const initialReceipt={version:'0.1.0',status:'ready',target:{kind:'home',environmentId:'controlled-env'},url:gateway+'/open#'+'A'.repeat(43),expiresAt:new Date(Date.now()+50000).toISOString(),originalManagementReturn:relation};
 await page.goto(initialGateway?gateway+'/?nativePath='+encodeURIComponent(initialPath):original+'/'+(initialOriginal?'#'+new URLSearchParams({token:'controlled-not-a-real-credential',nativeEntry:JSON.stringify(initialReceipt)}):''));await page.waitForFunction(()=>document.querySelector('#refresh')?.disabled===false);
 return {page,context,requests,errors,blocked,releaseNative:nativeRelease,releaseOpen:openRelease,changeInstance:()=>{instance='controlled-new-instance';},child:()=>page.frames().find(f=>new URL(f.url()).pathname.startsWith('/native/'))};
}
try{
 await test('original raw engineering button uses its original ticket endpoint without leaving the parent document',async()=>{
  const s=await setup();
  try{
   await s.page.locator('#nav-workbench').click();
   await s.page.waitForTimeout(100);
   observations.push({name:'raw endpoint selection',level:'controlled original app WebKit',requests:s.requests,errors:s.errors,blocked:s.blocked});
   await s.page.screenshot({path:join(evidence,red?'original-raw-entry-red.png':'raw-entry.png')});
   assert.equal(s.requests.filter(r=>r.path==='/api/workbench/native-open').length,1);
   assert.equal(s.requests.filter(r=>r.path==='/api/native-mount/session').length,0);
   assert.equal(await s.page.evaluate(()=>window.pageLeaves),0);
   assert.equal(s.page.url(),original+'/');assert.deepEqual(s.errors,[]);assert.deepEqual(s.blocked,[]);
  }finally{await s.context.close();}
 });
 if(!red){
  await test('desktop initial receipt consumes once inside the complete parent and returns to its original management pages',async()=>{
   const s=await setup({initialOriginal:true}),p=s.page;
   try{
    await p.waitForFunction(()=>document.querySelector('.native-workbench-portal')?.dataset.phase==='ready');
    assert.equal(p.url(),original+'/');assert.equal(s.requests.filter(r=>r.path==='/api/workbench/native-open').length,0);
    assert.equal(s.requests.filter(r=>r.path==='/launch').length,1);
    const native=s.child();assert.ok(native);await native.locator('#return').click();
    await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').hidden);
    await p.locator('#nav-models').click();await p.locator('#setup-key').waitFor();
    assert.equal(p.url(),original+'/');assert.equal(await p.locator('.main h1').innerText(),'模型与声音');
    assert.equal(s.requests.filter(r=>r.path==='/api/workbench/native-open').length,0);
    assert.equal(s.requests.filter(r=>r.path==='/launch').length,1);
    assert.deepEqual(s.errors,[]);assert.deepEqual(s.blocked,[]);
    observations.push({name:'desktop complete parent initial entry/Return/pages',passed:true,requests:s.requests});
   }finally{await s.context.close();}
  });
  await test('real original app and private setup retain form DOM, selected file, drafts, scroll and focus through nested native Return and reentry',async()=>{
   const s=await setup({status:200}),p=s.page;
   try{
    await p.locator('#nav-models').click();await p.locator('#setup-key').waitFor();await p.locator('#wake-keyword').waitFor();
    await p.locator('#setup-voice-label').fill('受控未保存音色');await p.locator('#setup-voice-text').fill('受控未保存试听文本');
    await p.locator('#setup-audio').setInputFiles({name:'controlled-reference.wav',mimeType:'audio/wav',buffer:Buffer.from('controlled file bytes; never decoded or uploaded')});
    await p.getByText('已选择：controlled-reference.wav',{exact:true}).waitFor();
    await p.locator('#setup-key').fill('controlled-unsaved-key');await p.locator('#setup-key').focus();
    const before=await p.evaluate(()=>{
     window.keptNodes=['setup-key','setup-audio','setup-voice-label','setup-voice-text'].map(id=>document.getElementById(id));
     window.keptApp=document.querySelector('#app').firstElementChild;
     const main=document.querySelector('.main');main.scrollTop=120;window.scrollTo(0,80);
     return {x:scrollX,y:scrollY,mainScroll:main.scrollTop,heading:main.querySelector('h1').textContent,focus:document.activeElement.id};
    });
    await p.evaluate(()=>document.getElementById('nav-workbench').click());
    await p.waitForFunction(()=>document.querySelector('.native-workbench-portal')?.dataset.phase==='ready');
    assert.equal(await p.locator('#app').evaluate(e=>e.inert),true);
    assert.equal(await p.locator('.main h1').innerText(),before.heading);
    const native=s.child();assert.ok(native);const contextId=await native.evaluate(()=>window.contextId);
    await native.getByLabel('受控原生草稿').fill('受控原会话草稿');
    // Readonly setup/wake polling must not reconstruct the original form while covered.
    await p.waitForTimeout(3400);
    assert.equal(await p.evaluate(()=>window.keptApp===document.querySelector('#app').firstElementChild&&window.keptNodes.every(node=>node===document.getElementById(node.id))),true);
    const outer=await p.locator('iframe.native-workbench-frame').first().elementHandle();
    for(const change of [{navigationId:'wrong'},{environmentId:'wrong'},{body:'unexpected'}])await p.evaluate(({change,relation,gateway})=>window.dispatchEvent(new MessageEvent('message',{origin:gateway,source:document.querySelector('iframe.native-workbench-frame').contentWindow,data:{source:'aaa-original-management-frame',version:'0.1.0',type:'return',navigationId:relation.navigationId,environmentId:relation.environmentId,...change}})),{change,relation,gateway});
    await p.evaluate(({relation,gateway})=>window.dispatchEvent(new MessageEvent('message',{origin:gateway,source:window,data:{source:'aaa-original-management-frame',version:'0.1.0',type:'return',navigationId:relation.navigationId,environmentId:relation.environmentId}})),{relation,gateway});
    assert.equal(await p.locator('.native-workbench-portal').isVisible(),true);
    await native.locator('#return').click();await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').hidden);
    const after=await p.evaluate(()=>({x:scrollX,y:scrollY,mainScroll:document.querySelector('.main').scrollTop,heading:document.querySelector('.main h1').textContent,focus:document.activeElement.id}));
    assert.deepEqual(after,before);assert.equal(await p.locator('#app').evaluate(e=>e.inert),false);
    assert.equal(await p.evaluate(()=>window.keptNodes.every(node=>node===document.getElementById(node.id))),true);
    assert.equal(await p.locator('#setup-key').inputValue(),'controlled-unsaved-key');assert.equal(await p.locator('#setup-voice-label').inputValue(),'受控未保存音色');assert.equal(await p.locator('#setup-voice-text').inputValue(),'受控未保存试听文本');
    assert.equal(await p.locator('#setup-upload').isEnabled(),true);await p.getByText('已选择：controlled-reference.wav',{exact:true}).waitFor();
    await p.screenshot({path:join(evidence,'original-private-forms-returned.png')});
    await p.evaluate(()=>document.getElementById('nav-workbench').click());await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.phase==='ready'&&!document.querySelector('.native-workbench-portal').hidden);
    assert.equal(await native.evaluate(()=>window.contextId),contextId);assert.equal(await native.getByLabel('受控原生草稿').inputValue(),'受控原会话草稿');assert.ok(await outer.evaluate(e=>e===document.querySelector('iframe.native-workbench-frame')));
    assert.equal(s.requests.filter(r=>r.origin===original&&r.path==='/api/workbench/native-open').length,1);assert.equal(s.requests.filter(r=>r.path==='/launch').length,1);
    assert.equal(await p.evaluate(()=>window.pageLeaves),0);assert.equal(p.url(),original+'/');assert.deepEqual(s.errors,[]);assert.deepEqual(s.blocked,[]);
    const stores=await p.evaluate(()=>Object.entries(sessionStorage));assert.equal(stores.length,1);assert.equal(stores[0][0],'pet-management-session-v1');
    observations.push({name:'original private forms, nested ready/Return/reentry',passed:true,level:'controlled original app + private self-setup + original landing + mounted outer controller WebKit; native child is a test document',originalDOMRetained:true,selectedFileVisibleAndUploadEnabled:true,unsavedKeyRetained:true,readonlyPollsDuringOverlay:s.requests.filter(r=>r.path==='/api/self-setup').length,requests:s.requests,errors:s.errors,blocked:s.blocked});
   }finally{s.releaseNative();s.releaseOpen();await s.context.close();}
  });
  await test('ticket and mount response completion do not report native readiness before the actual inner document loads',async()=>{
   const s=await setup({status:200,holdNative:true}),p=s.page;
   try{
    await p.locator('#nav-workbench').click();await p.waitForFunction(()=>document.querySelector('.native-workbench-portal')?.dataset.phase==='loading');
    await p.waitForTimeout(300);assert.equal(await p.locator('.native-workbench-portal').getAttribute('data-phase'),'loading');
    assert.ok(s.requests.some(r=>r.origin===gateway&&r.path==='/api/native-mount/session'));
    s.releaseNative();await p.waitForFunction(()=>document.querySelector('.native-workbench-portal')?.dataset.phase==='ready');
    await s.child().locator('#return').click();await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').hidden);
    assert.deepEqual(s.errors,[]);assert.deepEqual(s.blocked,[]);observations.push({name:'loaded inner document is readiness gate',passed:true,requests:s.requests});
   }finally{s.releaseNative();await s.context.close();}
  });
  await test('unknown entry, absent frame descriptor and malformed ticket relationship refuse without guessed routes',async()=>{
   for(const [name,options,expectedOpens] of [['unknown mode',{mode:'unknown'},0],['missing frame origin',{frameOrigin:null},0],['future relation',{status:200,relationChange:{version:'0.1.0'}},1],['wrong environment relation',{status:200,relationChange:{environmentId:'wrong-env'}},1]]){
    const s=await setup(options),p=s.page;
    try{
     await p.locator('#nav-workbench').click();await p.waitForFunction(()=>document.querySelector('.native-workbench-portal')?.dataset.phase==='error');
     assert.equal(s.requests.filter(r=>r.path==='/api/workbench/native-open').length,expectedOpens);assert.equal(s.requests.filter(r=>r.origin===gateway).length,0);
     await p.getByRole('button',{name:'返回管理',exact:true}).click();assert.equal(await p.locator('.main h1').innerText(),'运行总览');assert.equal(await p.evaluate(()=>window.pageLeaves),0);
     assert.deepEqual(s.errors,[]);assert.deepEqual(s.blocked,[]);observations.push({name,passed:true,requests:s.requests});
    }finally{await s.context.close();}
   }
  });
  await test('original API expiry, outage and actual mounted environment mismatch keep the original document available',async()=>{
   for(const [name,options,phase] of [['auth expired',{status:401},'expired'],['service offline',{status:503},'offline'],['mounted environment mismatch',{status:200,mountEnvironment:'other-env'},'error']]){
    const s=await setup(options),p=s.page;
    try{
     await p.locator('#nav-workbench').click();await p.waitForFunction(phase=>document.querySelector('.native-workbench-portal')?.dataset.phase===phase,phase);
     assert.equal(p.url(),original+'/');await p.getByRole('button',{name:'返回管理',exact:true}).click();assert.equal(await p.locator('.native-workbench-portal').isVisible(),false);
     assert.equal(await p.evaluate(()=>window.pageLeaves),0);assert.deepEqual(s.errors,[]);assert.deepEqual(s.blocked,[]);observations.push({name,passed:true,requests:s.requests});
    }finally{await s.context.close();}
   }
  });
  await test('a late old ticket cannot attach after the original runtime identity changes',async()=>{
   const s=await setup({status:200,holdOpen:true}),p=s.page;
   try{
    await p.locator('#nav-workbench').click();await p.waitForFunction(()=>document.querySelector('.native-workbench-portal')?.dataset.phase==='connecting');
    s.changeInstance();await p.evaluate(()=>document.getElementById('refresh').click());await p.waitForFunction(()=>document.querySelector('.native-workbench-portal')?.dataset.phase==='error');
    s.releaseOpen();await p.waitForTimeout(200);assert.equal(s.requests.filter(r=>r.origin===gateway).length,0);assert.equal(await p.locator('iframe.native-workbench-frame').count(),0);
    await p.getByRole('button',{name:'返回管理',exact:true}).click();assert.deepEqual(s.errors,[]);assert.deepEqual(s.blocked,[]);observations.push({name:'late old runtime receipt refused',passed:true,requests:s.requests});
   }finally{s.releaseOpen();await s.context.close();}
  });
  await test('direct mounted entry keeps its original exact task, Return to gateway management and unchanged frame draft without a raw relationship',async()=>{
   const s=await setup({initialGateway:true,initialPath:'/native/controlled-env/original-task'}),p=s.page;
   try{
    await p.waitForFunction(()=>document.querySelector('.native-workbench-state')?.hidden===true);
    const native=s.child(),contextId=await native.evaluate(()=>window.contextId);assert.equal(native.url(),gateway+'/native/controlled-env/original-task');assert.equal(p.url(),gateway+'/');
    await native.getByLabel('受控原生草稿').fill('受控直接入口原草稿');await native.locator('#return').click();
    await p.waitForFunction(()=>document.querySelector('.main h1')?.textContent==='运行总览'&&document.querySelector('.native-workbench-portal').hidden);
    await p.locator('#nav-workbench').click();await p.waitForFunction(()=>!document.querySelector('.native-workbench-portal').hidden);
    assert.equal(await native.evaluate(()=>window.contextId),contextId);assert.equal(await native.getByLabel('受控原生草稿').inputValue(),'受控直接入口原草稿');
    assert.equal(s.requests.filter(r=>r.path==='/api/native-mount/session').length,1);assert.equal(s.requests.filter(r=>r.path==='/api/workbench/native-open').length,0);assert.equal(s.requests.filter(r=>r.path==='/launch').length,0);
    assert.deepEqual(s.errors,[]);assert.deepEqual(s.blocked,[]);observations.push({name:'direct mounted task/Return/reentry unchanged',passed:true,requests:s.requests});
   }finally{await s.context.close();}
  });
 }
}finally{await writeFile(join(evidence,'observations.json'),JSON.stringify(observations,null,2)+'\n');await browser.close();}
