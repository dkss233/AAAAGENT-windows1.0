import nodeTest from 'node:test';
const test=(name,fn)=>nodeTest(name,async()=>{try{await fn();}catch(e){console.error(e.message);throw e;}});
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
assert.ok(process.env.PLAYWRIGHT_MODULE,'Use an existing Playwright module');
const {webkit}=await import(process.env.PLAYWRIGHT_MODULE);
const origin='http://127.0.0.1:55998';
const output=process.env.WORKSPACE_UI_EVIDENCE??'artifacts/W1/workspace-ui-integration-54/controlled';
await mkdir(output,{recursive:true});
const source=new URL('../../../../management/ui/',import.meta.url);
const modules=new Map(await Promise.all(['native-workbench-view.mjs','dom.mjs','style.css','appearance.mjs'].map(async n=>[n,await readFile(new URL(n,source),'utf8')])));
const harness=`<!doctype html><meta charset="utf-8"><script src="/modules/appearance.mjs"></script><link rel="stylesheet" href="/modules/style.css"><div id="app"></div><script type="module">
import {createNativeWorkbenchView} from '/modules/native-workbench-view.mjs';
window.calls=[];window.host={page:'overview',connection:'online',authEpoch:0,instanceId:'controlled',appearance:window.AAAAppearance,navigate(page){window.host.page=page;window.redraw();}};
const client={request:async(path,options)=>{window.calls.push({path,method:options.method});return {apiVersion:1,mode:'native-read',mountPath:'/native/',readonly:true,environmentId:'controlled',expiresAt:new Date(Date.now()+60000).toISOString()};}};
let view;window.redraw=()=>{view.sync();const main=document.createElement('main');main.className='main';if(window.host.page==='workbench')main.append(view.view());else{const h=document.createElement('h1');h.textContent=window.host.page;h.tabIndex=-1;main.append(h);const b=document.createElement('button');b.id='nav-workbench';b.textContent='进入工程工作台';b.onclick=()=>{window.host.page='workbench';redraw()};main.append(b);}document.querySelector('#app').replaceChildren(main);view.afterRender();};
view=createNativeWorkbenchView(client,redraw,()=>window.host);window.AAAAppearance.subscribe(()=>view.appearanceChanged());window.dispose=()=>view.dispose();redraw();
</script>`;
const child=`<!doctype html><meta charset="utf-8"><div id="root" class="aaa-workspace-shell"><button class="aaa-menu-trigger">受控菜单</button><textarea aria-label="受控草稿"></textarea><p>受控展示模块；无原服务数据</p></div><script>window.contextId=Math.random();window.emit=(type,fields={})=>parent.postMessage({source:'aaa-workspace-ui',version:1,type,...fields},location.origin);window.states=[];addEventListener('message',e=>{if(e.source===parent&&e.origin===location.origin)states.push(e.data)});emit('shell.ready');</script>`;
const browser=await webkit.launch({headless:true}),observations=[];
async function setup(options={}){
 const context=await browser.newContext({viewport:{width:1280,height:720},colorScheme:'light',...options}),page=await context.newPage(),errors=[],unexpected=[];
 page.on('console',m=>{if(m.type()==='error')console.error('Controlled console:',m.text());});page.setDefaultTimeout(8000);page.on('pageerror',e=>{errors.push(String(e));console.error('Controlled page error:',e.message);});
 await page.route('**/*',route=>{
  const u=new URL(route.request().url());if(u.origin!==origin||route.request().method()!=='GET'){unexpected.push({path:u.pathname,method:route.request().method()});return route.abort();}
  if(u.pathname==='/test')return route.fulfill({contentType:'text/html',body:harness});
  if(u.pathname.startsWith('/modules/')&&modules.has(u.pathname.slice(9)))return route.fulfill({contentType:u.pathname.endsWith('.css')?'text/css':'text/javascript',body:modules.get(u.pathname.slice(9))});
  if(u.pathname.startsWith('/native/'))return route.fulfill({contentType:'text/html',body:child});
  unexpected.push({path:u.pathname});return route.abort();
 });
 await page.goto(origin+'/test');try{await page.getByRole('button',{name:'进入工程工作台'}).waitFor();}catch(e){console.error(JSON.stringify({errors,unexpected,body:await page.locator('body').innerText(),ready:await page.evaluate(()=>({host:window.host,view:typeof window.redraw,appearance:!!window.AAAAppearance}))}));throw e;}
 const enter=async()=>{await page.getByRole('button',{name:'进入工程工作台'}).click();await page.waitForFunction(()=>document.querySelector('.native-workbench-state')?.hidden===true);};
 const frame=()=>page.frames().find(f=>f!==page.mainFrame());
 return {context,page,enter,frame,errors,unexpected};
}
async function finish(name,s,extra={}){assert.deepEqual(s.errors,[]);assert.deepEqual(s.unexpected,[]);observations.push({name,level:'controlled WebKit original UI module; no actual T3 data',...extra});await s.page.evaluate(()=>window.dispose());await s.context.close();}
try{
 await test('full viewport transition retains document, route, draft and focus through interruption',async()=>{
  const s=await setup(),p=s.page;await s.enter();const f=s.frame();await f.getByLabel('受控草稿').fill('受控临时草稿');await f.getByLabel('受控草稿').focus();await f.evaluate(()=>history.replaceState(null,'','/native/original-case'));
  const id=await f.evaluate(()=>window.contextId);
  await p.evaluate(()=>{window.host.page='memory';redraw();window.host.page='workbench';redraw();});
  await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.transition==='settled');
  assert.equal(await f.evaluate(()=>window.contextId),id);assert.equal(new URL(f.url()).pathname,'/native/original-case');assert.equal(await f.getByLabel('受控草稿').inputValue(),'受控临时草稿');assert.equal(await f.getByLabel('受控草稿').evaluate(e=>e===document.activeElement),true);
  assert.deepEqual(await p.locator('.native-workbench-portal').evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}}),{x:0,y:0,w:1280,h:720});
  assert.equal(await p.evaluate(()=>window.calls.length),1);
  await f.evaluate(()=>emit('management.navigate',{page:'memory'}));await p.waitForFunction(()=>window.host.page==='memory');await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').hidden);
  assert.equal(await p.locator('.native-workbench-portal').evaluate(e=>e.inert),true);await s.enter();assert.equal(await f.evaluate(()=>window.contextId),id);
  await p.setViewportSize({width:390,height:844});await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').getBoundingClientRect().width===390);
  await finish('interruptible-full-viewport-instance',s,{viewport:[1280,720,390,844],durationMs:260,mountRequests:1});
 });
 await test('same-origin exact source and version bridge; expired frame cannot navigate',async()=>{
  const s=await setup({reducedMotion:'reduce'}),p=s.page;await s.enter();
  await p.evaluate(()=>{const message={source:'aaa-workspace-ui',version:1,type:'management.navigate',page:'memory'};dispatchEvent(new MessageEvent('message',{origin:location.origin,source:window,data:message}));});assert.equal(await p.evaluate(()=>window.host.page),'workbench');
  await s.frame().evaluate(()=>parent.postMessage({source:'aaa-workspace-ui',version:2,type:'management.navigate',page:'memory'},location.origin));await p.waitForTimeout(30);assert.equal(await p.evaluate(()=>window.host.page),'workbench');
  await s.frame().evaluate(()=>emit('management.navigate',{page:'arbitrary-url'}));await p.waitForTimeout(30);assert.equal(await p.evaluate(()=>window.host.page),'workbench');
  await s.frame().goto(origin+'/native/pair');await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.phase==='expired');await s.frame().evaluate(()=>emit('management.navigate',{page:'memory'}));await p.waitForTimeout(30);assert.equal(await p.evaluate(()=>window.host.page),'workbench');
  await p.getByRole('button',{name:'返回管理',exact:true}).click();assert.equal(await p.evaluate(()=>window.host.page),'overview');
  await finish('bridge-identity-expiry-boundary',s);
 });
 await test('single appearance preference follows system, keeps explicit mode and original custom keys',async()=>{
  const s=await setup({reducedMotion:'reduce'}),p=s.page;
  await p.evaluate(()=>{localStorage.setItem('t3code:themes:v1','original-custom');localStorage.setItem('t3code:theme-halves:v1','original-halves');});
  assert.equal(await p.evaluate(()=>window.AAAAppearance.state().mode),'system');await p.emulateMedia({colorScheme:'dark'});await p.waitForFunction(()=>document.documentElement.dataset.appearance==='dark');assert.equal(await p.locator('html').getAttribute('data-appearance'),'dark');
  await p.evaluate(()=>window.AAAAppearance.set('light'));await p.emulateMedia({colorScheme:'dark'});assert.equal(await p.locator('html').getAttribute('data-appearance'),'light');
  await s.enter();await s.frame().evaluate(()=>emit('appearance.set',{mode:'dark'}));await p.waitForFunction(()=>document.documentElement.dataset.appearance==='dark');
  assert.equal(await p.evaluate(()=>localStorage.getItem('t3code:themes:v1')),'original-custom');assert.equal(await p.evaluate(()=>localStorage.getItem('t3code:theme-halves:v1')),'original-halves');
  assert.equal(await p.locator('.native-workbench-portal').evaluate(e=>e.getAnimations().length),0);
  await p.reload();assert.equal(await p.locator('html').getAttribute('data-appearance'),'dark');
  await finish('appearance-system-explicit-refresh-custom',s);
 });
 await test('denied appearance writes retain the in-memory selection and report unsaved',async()=>{
  const s=await setup({reducedMotion:'reduce'}),p=s.page;
  await p.evaluate(()=>{Storage.prototype.setItem=function(){throw new DOMException('Controlled storage denial','SecurityError')};window.AAAAppearance.set('dark');});
  assert.equal(await p.locator('html').getAttribute('data-appearance'),'dark');assert.deepEqual(await p.evaluate(()=>window.AAAAppearance.state()),{mode:'dark',resolved:'dark',saved:false});
  await finish('appearance-storage-denial',s);
 });
}finally{await writeFile(output+'/observations.json',JSON.stringify(observations,null,2)+'\n');await browser.close();}
