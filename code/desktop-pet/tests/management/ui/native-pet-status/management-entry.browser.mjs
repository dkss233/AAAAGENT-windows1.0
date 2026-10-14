import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Original management app and portal; every network request is served from memory.
// The child only exercises the existing shell message protocol, not real T3 UI.
const taskRoot=resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const option=name=>{const at=process.argv.indexOf(name);assert.ok(at>=0&&process.argv[at+1]);return resolve(process.argv[at+1]);};
const evidence=option('--evidence'),playwright=option('--playwright'),red=process.argv.includes('--red');
assert.ok(evidence.startsWith(join(taskRoot,'artifacts/W1/native-pet-status-54/')));
await mkdir(evidence,{recursive:true});
const ui=join(taskRoot,'code/desktop-pet/management/ui'),origin='http://management-entry.invalid';
const modules=new Map(await Promise.all((await readdir(ui)).filter(n=>/\.(mjs|css|html)$/.test(n)).map(async n=>[n,await readFile(join(ui,n),'utf8')])));
if(red)for(const n of ['app.mjs','native-workbench-view.mjs'])modules.set(n,execFileSync('git',['show',`ff481ca71d073845511cb0ae18318371fe6631f4:code/desktop-pet/management/ui/${n}`],{cwd:taskRoot,encoding:'utf8'}));
const snapshot={apiVersion:1,runtime:{online:true,characterId:'companion',instanceId:'controlled-instance',sourceRevision:'controlled-source',pid:0,startedAt:'2026-10-02T00:00:00Z',observedAt:'2026-10-02T00:00:00Z'},
 characters:[{id:'companion',label:'受控角色'}],settings:{revision:1,effectiveRevision:1,pending:false,saved:{providers:{}},effective:{providers:{}}},modules:[],balances:{providers:[]}};
const child=`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding-top:50px}header{position:fixed;top:0;padding:8px;background:white}main{height:1500px}textarea{margin-top:150px}</style>
<div id="root" class="aaa-workspace-shell"><header><button class="aaa-menu-trigger" id="return">受控返回管理</button><select aria-label="受控原生外观"><option value="light">浅色</option><option value="dark">深色</option></select></header><main><p>受控原生页面，仅验证父壳消息协议</p><textarea aria-label="受控原草稿"></textarea></main></div><script>
window.contextId=Math.random();window.shellStates=[];
addEventListener('message',event=>{if(event.origin===location.origin&&event.source===parent&&event.data?.type==='shell.state')window.shellStates.push(event.data);});
document.getElementById('return').onclick=()=>parent.postMessage({source:'aaa-workspace-ui',version:1,type:'management.navigate',page:'overview'},location.origin);
document.querySelector('select').onchange=event=>parent.postMessage({source:'aaa-workspace-ui',version:1,type:'appearance.set',mode:event.target.value},location.origin);
parent.postMessage({source:'aaa-workspace-ui',version:1,type:'shell.ready'},location.origin);
</script>`;
const {webkit}=await import(pathToFileURL(playwright).href),browser=await webkit.launch({headless:true});
const cases=[];let failure,lastSetup,diagnostics;
async function setup(path,{rawQuery,firstMountStatus=200}={}){
 const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage(),requests=[],errors=[],blocked=[];let mounts=0;
 page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(6000);
 await page.addInitScript(()=>{
  sessionStorage.setItem('pet-management-session-v1','controlled-tab-session');
  for(const n of ['WebSocket','EventSource'])window[n]=class{constructor(){throw Error('controlled blocks '+n);}};
  if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>Promise.reject(Error('controlled blocks device'));
 });
 await page.route('**/*',route=>{
  const r=route.request(),u=new URL(r.url()),method=r.method();
  requests.push({method,path:u.pathname+u.search});
  if(u.origin!==origin){blocked.push(u.origin);return route.abort();}
  if(u.pathname.startsWith('/api/')){
   assert.equal(r.headers().authorization,'Bearer controlled-tab-session');
   if(u.pathname==='/api/native-mount/session'&&method==='POST'){
    mounts++;assert.equal(r.postData(),'{}');
    if(mounts===1&&firstMountStatus!==200)return route.fulfill({status:firstMountStatus,json:{error:{message:'受控会话失效'}}});
    return route.fulfill({json:{apiVersion:1,mode:'native-read',mountPath:'/native/',readonly:true,environmentId:'controlled-env',expiresAt:new Date(Date.now()+60000).toISOString()}});
   }
   if(method!=='GET'){blocked.push(method+' '+u.pathname);return route.abort();}
   if(u.pathname==='/api/snapshot')return route.fulfill({json:snapshot});
   if(u.pathname==='/api/self-setup')return route.fulfill({status:404,json:{error:{message:'受控未配置'}}});
   blocked.push(u.pathname);return route.abort();
  }
  if(method!=='GET'){blocked.push(method+' '+u.pathname);return route.abort();}
  if(u.pathname.startsWith('/native/'))return route.fulfill({contentType:'text/html',body:child});
  const name=u.pathname==='/'?'index.html':u.pathname.slice(1);
  if(modules.has(name))return route.fulfill({contentType:name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'text/javascript',body:modules.get(name)});
  blocked.push(u.pathname);return route.abort();
 });
 const query=rawQuery??(path===null?'':'?nativePath='+encodeURIComponent(path));
 await page.goto(origin+'/'+query);await page.waitForFunction(()=>document.querySelector('#refresh')?.disabled===false);
 return lastSetup={context,page,requests,errors,blocked,mounts:()=>mounts,frame:()=>page.frames().find(f=>f!==page.mainFrame())};
}
async function finish(name,s,extra={}){
 assert.deepEqual(s.errors,[]);assert.deepEqual(s.blocked,[]);
 assert.ok(s.requests.filter(r=>r.method!=='GET').every(r=>r.method==='POST'&&r.path==='/api/native-mount/session'));
 cases.push({name,passed:true,requests:s.requests,mounts:s.mounts(),...extra});await s.context.close();
}
try{
 for(const [name,path] of (red?[['thread','/native/controlled-env/controlled-original-c']]:[['thread','/native/controlled-env/controlled-original-c'],['project','/native/?aaaProject=controlled-project&aaaEnvironment=controlled-env'],['home','/native/']])){
  const s=await setup(path),p=s.page;
  cases.push({name:'initial '+name,observedParentPath:new URL(p.url()).pathname+new URL(p.url()).search,heading:await p.locator('.main h1').innerText()});
  await p.screenshot({path:join(evidence,`${name}-initial.png`)});
  assert.equal(new URL(p.url()).search,'','one-time nativePath removed by the original app');
  assert.equal(await p.locator('.main h1').innerText(),'工程工作台');
  await p.locator('.native-workbench-frame').waitFor();await p.frameLocator('.native-workbench-frame').getByLabel('受控原草稿').waitFor();
  await p.waitForFunction(()=>document.querySelector('.native-workbench-state').hidden&&document.querySelector('.native-workbench-portal').dataset.transition==='settled');
  const f=s.frame(),expected=origin+path;assert.equal(f.url(),expected);
  const initial=await f.evaluate(()=>window.contextId);await f.getByLabel('受控原草稿').fill('受控草稿：返回后保持准确原任务');
  await f.evaluate(()=>scrollTo(0,150));const scroll=await f.evaluate(()=>scrollY);
  await f.getByLabel('受控原生外观').selectOption('dark');
  await f.waitForFunction(()=>window.shellStates?.some(s=>s.mode==='dark'));
  const returnButton=f.getByRole('button',{name:'受控返回管理',exact:true});await returnButton.focus();await returnButton.press('Enter');
  await p.waitForFunction(()=>document.querySelector('.main h1')?.textContent==='运行总览'&&document.querySelector('.native-workbench-portal').hidden);
  assert.equal(await p.locator('.appearance-control select').inputValue(),'dark');
  await p.locator('#refresh').click();await p.waitForFunction(()=>document.querySelector('#refresh').disabled===false);
  assert.equal(await f.evaluate(()=>window.contextId),initial);assert.equal(f.url(),expected);
  await p.locator('#nav-workbench').click();await p.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.transition==='settled'&&!document.querySelector('.native-workbench-portal').hidden);
  assert.equal(s.frame(),f);assert.equal(await f.evaluate(()=>window.contextId),initial);assert.equal(f.url(),expected);
  assert.equal(await f.getByLabel('受控原草稿').inputValue(),'受控草稿：返回后保持准确原任务');assert.equal(await f.evaluate(()=>scrollY),scroll);
  assert.equal(await f.getByRole('button',{name:'受控返回管理',exact:true}).evaluate(e=>e===document.activeElement),true);
  assert.equal(await f.evaluate(()=>window.contextId),initial);assert.equal(f.url(),expected);assert.equal(await p.evaluate(()=>window.AAAAppearance.state().mode),'dark');
  assert.equal(s.mounts(),1);assert.equal(s.requests.filter(r=>r.path.startsWith('/native/')).length,1);
  await p.screenshot({path:join(evidence,`${name}-returned-reopened.png`)});
  await finish(name+' exact route, Return, reopen, draft, viewport, focus, theme and refresh',s,{frameContext:initial,exactPath:path,childDocumentLoads:1});
 }
 if(!red){
  const rejected=[['external','https://external.invalid/native/controlled-env/c'],['credentials',origin.replace('http://','http://user:pass@')+'/native/controlled-env/c'],['hash','/native/controlled-env/c#private'],['pair','/native/pair'],['login','/native/login'],['encoded-login','/native/%6cogin/c'],['wrong-thread-environment','/native/other-env/c'],['wrong-project-environment','/native/?aaaProject=p&aaaEnvironment=other-env'],['credential-query','/native/controlled-env/c?token=controlled'],['malformed-path','/native/%/c']];
  for(const [name,path] of rejected){
   const s=await setup(path);await s.page.getByText('原任务入口无效或与当前环境不一致，请从桌宠重新打开。',{exact:true}).waitFor();
   assert.equal(new URL(s.page.url()).search,'');assert.equal(await s.page.locator('iframe').count(),0);assert.equal(s.requests.some(r=>r.path.startsWith('/native/')),false);
   assert.equal(s.mounts(),name.startsWith('wrong-')?1:0);assert.equal(await s.page.getByRole('button',{name:'重新连接原生工作台',exact:true}).count(),0);
   await finish('reject '+name+' without fallback or task request',s);
  }
  const duplicate=await setup(null,{rawQuery:'?nativePath=%2Fnative%2F&nativePath=%2Fnative%2Fcontrolled-env%2Fc'});
  await duplicate.page.getByText('原任务入口无效或与当前环境不一致，请从桌宠重新打开。',{exact:true}).waitFor();assert.equal(duplicate.mounts(),0);assert.equal(new URL(duplicate.page.url()).search,'');await finish('duplicate target rejected and removed once',duplicate);
  const ordinary=await setup(null);assert.equal(await ordinary.page.locator('.main h1').innerText(),'运行总览');assert.equal(await ordinary.page.locator('iframe').count(),0);
  await ordinary.page.locator('#nav-workbench').click();await ordinary.page.frameLocator('.native-workbench-frame').getByLabel('受控原草稿').waitFor();assert.equal(ordinary.frame().url(),origin+'/native/');await finish('ordinary management entry remains overview and manual native home',ordinary);
  const expired=await setup('/native/controlled-env/controlled-original-c',{firstMountStatus:401});
  await expired.page.getByRole('button',{name:'重新连接原生工作台',exact:true}).waitFor();assert.equal(await expired.page.locator('iframe').count(),0);
  await expired.page.getByRole('button',{name:'重新连接原生工作台',exact:true}).click();await expired.page.frameLocator('.native-workbench-frame').getByLabel('受控原草稿').waitFor();assert.equal(expired.frame().url(),origin+'/native/controlled-env/controlled-original-c');assert.equal(expired.mounts(),2);
  await finish('auth failure never falls back; explicit reconnect retains pending exact target',expired);
 }
}catch(error){failure=error;if(lastSetup)diagnostics={requests:lastSetup.requests,errors:lastSetup.errors,blocked:lastSetup.blocked,
 parent:await lastSetup.page.evaluate(()=>({appearance:window.AAAAppearance?.state(),phase:document.querySelector('.native-workbench-portal')?.dataset.phase,message:document.querySelector('.native-workbench-state')?.innerText})).catch(String),
 child:await lastSetup.frame()?.evaluate(()=>({contextId:window.contextId,shellStates:window.shellStates,theme:document.querySelector('select')?.value})).catch(String)};}
finally{await browser.close();}
await writeFile(join(evidence,'results.json'),JSON.stringify({cases,failure:failure?String(failure):null,diagnostics,
 sources:Object.fromEntries(['app.mjs','native-workbench-view.mjs'].map(n=>[n,createHash('sha256').update(modules.get(n)).digest('hex')])),
 boundary:'controlled original management app/portal in WebKit; original-shaped mount/snapshot from memory and protocol-only simulated child; no actual T3/native window or runtime acceptance',liveNetworkRequests:0,taskOperations:0,modelRequests:0,devices:0},null,2)+'\n');
if(failure)throw failure;
console.log(JSON.stringify({passedGroups:cases.filter(c=>c.passed).length,liveNetwork:0,taskOperations:0,models:0,devices:0}));
