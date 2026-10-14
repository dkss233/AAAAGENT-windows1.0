import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
assert.ok(process.env.PLAYWRIGHT_MODULE,'Use an existing Playwright module; this test installs nothing');
const {webkit}=await import(process.env.PLAYWRIGHT_MODULE);
const origin='http://127.0.0.1:55999';
const output=process.env.NATIVE_MOUNT_MODULE_EVIDENCE??'artifacts/W1/t3-native-mount-read-54/portal-controlled';
await mkdir(output,{recursive:true});
const source=new URL('../../../../management/ui/',import.meta.url);
const modules=new Map(await Promise.all(['native-workbench-view.mjs','workbench-view.mjs','project-memory-view.mjs','api.mjs','dom.mjs','style.css'].map(async n=>[n,await readFile(new URL(n,source),'utf8')])));
const harness=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/modules/style.css"><main id="app" class="main"></main><script type="module">
import {createNativeWorkbenchView} from '/modules/native-workbench-view.mjs';
window.host={connection:'online',authEpoch:0,instanceId:'host-a',page:'workbench'};
window.reply={apiVersion:1,mode:'native-read',mountPath:'/native/',readonly:true,environmentId:'environment-a',expiresAt:new Date(Date.now()+60000).toISOString()};
window.calls=[];
const client={request:async(path,options)=>{window.calls.push({path,method:options.method,credentials:options.credentials,body:options.body});return {...window.reply};}};
let view;
window.redraw=()=>{if(!view)return;view.sync();const content=document.createElement('div');content.className='page-content';content.append(window.host.page==='workbench'?view.view():document.createElement('div'));document.getElementById('app').replaceChildren(content);view.afterRender();};
view=createNativeWorkbenchView(client,window.redraw,()=>window.host);window.dispose=()=>view.dispose();window.redraw();
</script>`;
const child=`<!doctype html><meta charset="utf-8"><div id="root" class="aaa-workspace-shell"><p>受控模块测试：不是真实 T3 数据</p><textarea aria-label="受控草稿"></textarea></div><script>
window.contextId=Math.random();const key='module-test-draft:'+location.pathname;const draft=document.querySelector('textarea');draft.value=localStorage.getItem(key)||'';draft.addEventListener('input',()=>localStorage.setItem(key,draft.value));
</script>`;
const browser=await webkit.launch({headless:true}),observations=[];
async function setup(){
 const context=await browser.newContext({viewport:{width:1200,height:900},reducedMotion:'reduce'}),page=await context.newPage(),errors=[],unexpected=[],requests=[];let unauthorized=false,errorHtml=false;
 page.on('pageerror',e=>errors.push(String(e)));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());requests.push({method:request.method(),path:url.pathname});
  if(url.origin!==origin||request.method()!=='GET'){unexpected.push({method:request.method(),origin:url.origin});return route.abort();}
  if(url.pathname==='/test')return route.fulfill({contentType:'text/html',body:harness});
  if(url.pathname.startsWith('/modules/')&&modules.has(url.pathname.slice(9)))return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:modules.get(url.pathname.slice(9))});
  if(url.pathname==='/api/auth/session')return route.fulfill({status:unauthorized?401:200,contentType:'application/json',body:JSON.stringify({authenticated:!unauthorized})});
  if(url.pathname.startsWith('/native/'))return unauthorized?route.fulfill({status:401,contentType:errorHtml?'text/html':'application/json',body:errorHtml?'<!doctype html><p>Browser HTTP error document</p>':JSON.stringify({error:'native_auth_expired'})}):route.fulfill({contentType:'text/html',body:child});
  unexpected.push({path:url.pathname});return route.abort();
 });
 await page.goto(origin+'/test');await page.locator('.native-workbench-frame').waitFor();await page.frameLocator('.native-workbench-frame').getByLabel('受控草稿').waitFor();
 const frame=()=>page.frames().find(f=>f!==page.mainFrame());
 return {context,page,frame,errors,unexpected,requests,expire(html=false){unauthorized=true;errorHtml=html;}};
}
async function finish(name,s){
 assert.deepEqual(s.errors,[]);assert.deepEqual(s.unexpected,[]);
 observations.push({name,level:'controlled original module in WebKit; no actual native service/data',requests:s.requests,mountRequests:await s.page.evaluate(()=>window.calls),errors:s.errors});
 await s.page.evaluate(()=>window.dispose());await s.context.close();
}
try{
 await test('controlled real DOM native mount lifecycle',async t=>{
  await t.test('shell replacement and page switching keep the same iframe context, route, focus and draft',async()=>{
   const s=await setup(),p=s.page;
   assert.doesNotMatch(await p.locator('.native-workbench-state').textContent(),/\bfalse\b/);
   await s.frame().evaluate(()=>{history.replaceState(null,'','/native/thread/controlled-a');});
   const draft=s.frame().getByLabel('受控草稿');await draft.fill('仅模块测试草稿');await draft.focus();
   const id=await s.frame().evaluate(()=>window.contextId);
   await p.evaluate(()=>{window.redraw();window.redraw();});
   assert.equal(await s.frame().evaluate(()=>window.contextId),id);assert.equal(new URL(s.frame().url()).pathname,'/native/thread/controlled-a');assert.equal(await draft.inputValue(),'仅模块测试草稿');assert.equal(await draft.evaluate(e=>e===document.activeElement),true);
   await p.evaluate(()=>{window.host.page='other';window.redraw();});assert.equal(await p.locator('.native-workbench-portal').isVisible(),false);
   await p.evaluate(()=>{window.host.page='workbench';window.redraw();});assert.equal(await s.frame().evaluate(()=>window.contextId),id);assert.equal(await draft.inputValue(),'仅模块测试草稿');
   assert.equal(await p.evaluate(()=>window.calls.length),1);
   await p.setViewportSize({width:390,height:844});
   await p.waitForFunction(()=>{const b=document.querySelector('.native-workbench-portal').getBoundingClientRect();return b.left===0&&b.top===0&&b.width===innerWidth&&b.height===innerHeight;});
   await finish('shell-context-preserved',s);
  });
  await t.test('auth redirect hides stale iframe; explicit reconnect restores the last same-environment route',async()=>{
   const s=await setup(),p=s.page;
   await s.frame().goto(origin+'/native/thread/controlled-a');await s.frame().getByLabel('受控草稿').fill('重连后保留的模块草稿');
   await p.waitForTimeout(2100); // Let the original view observe the SPA route before an auth redirect.
   await s.frame().goto(origin+'/native/pair');
   await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.phase==='expired');
   assert.equal(await p.locator('.native-workbench-frame-host').evaluate(e=>e.inert),true);assert.equal(await p.locator('.native-workbench-frame-host').evaluate(e=>getComputedStyle(e).visibility),'hidden');
   await p.getByRole('button',{name:'重新连接原生工作台',exact:true}).click();
   await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.phase==='ready');
   await s.frame().waitForURL(origin+'/native/thread/controlled-a',{waitUntil:'load'});
   await p.frameLocator('.native-workbench-frame').getByLabel('受控草稿').waitFor();
   assert.equal(new URL(s.frame().url()).pathname,'/native/thread/controlled-a');assert.equal(await s.frame().getByLabel('受控草稿').inputValue(),'重连后保留的模块草稿');assert.equal(await p.evaluate(()=>window.calls.length),2);
   await finish('auth-expiry-explicit-reconnect',s);
  });
  await t.test('changing environment resets to its overview even when two session replies have the same expiry',async()=>{
   const s=await setup(),p=s.page;
   await s.frame().evaluate(()=>history.replaceState(null,'','/native/thread/old-environment-only'));
   const before=await s.frame().evaluate(()=>window.contextId);
   await p.evaluate(()=>{window.host.instanceId='host-b';window.host.authEpoch++;window.reply.environmentId='environment-b';window.redraw();});
   await p.waitForFunction(()=>document.querySelector('.native-workbench-frame')?.contentWindow.location.pathname==='/native/');
   await p.frameLocator('.native-workbench-frame').getByLabel('受控草稿').waitFor();
   assert.notEqual(await s.frame().evaluate(()=>window.contextId),before);assert.equal(await p.evaluate(()=>window.calls.length),2);assert.equal(await s.frame().getByLabel('受控草稿').inputValue(),'');
   await finish('environment-route-reset',s);
  });
  await t.test('a native gateway 401 document is explicitly classified as auth expiry',async()=>{
   const s=await setup();s.expire();await s.frame().goto(origin+'/native/');
   await s.page.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.phase==='expired');
   assert.equal(await s.page.locator('.native-workbench-frame-host').evaluate(e=>e.inert),true);
   await finish('gateway-auth-expiry',s);
  });
  await t.test('a browser HTML replacement of a 401 is classified using the public auth read',async()=>{
   const s=await setup();s.expire(true);await s.frame().goto(origin+'/native/');
   await s.page.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.phase==='expired');
   assert.ok(s.requests.some(r=>r.path==='/api/auth/session'&&r.method==='GET'));
   assert.equal(await s.page.locator('.native-workbench-frame-host').evaluate(e=>e.inert),true);
   await finish('browser-error-document-auth-read',s);
  });
 });
}finally{await writeFile(`${output}/observations.json`,JSON.stringify(observations,null,2)+'\n');await browser.close();}
