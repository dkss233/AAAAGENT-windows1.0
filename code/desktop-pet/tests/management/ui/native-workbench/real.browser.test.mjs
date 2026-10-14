import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
assert.ok(process.env.PLAYWRIGHT_MODULE&&process.env.NATIVE_MOUNT_SESSION_FILE,'Use the I-owned running candidate and existing browser runtime');
const {webkit}=await import(process.env.PLAYWRIGHT_MODULE);
const session=JSON.parse(await readFile(process.env.NATIVE_MOUNT_SESSION_FILE,'utf8'));
assert.equal(new URL(session.origin).hostname,'127.0.0.1');assert.equal(new URL(session.origin).port,'59913');
const output=process.env.NATIVE_MOUNT_REAL_EVIDENCE??'artifacts/W1/t3-native-mount-read-54/real-browser';
await mkdir(output,{recursive:true});
const cases=[
 {threadId:'55321ff5-339c-4654-b094-8eed93833125',projectId:'5659cde4-4f61-4748-807f-cef35b1aecf5',provider:'codex'},
 {threadId:'847088d1-ddb9-4fee-b38b-04588cf8a1ad',projectId:'84775d4b-a2b1-46ba-8e46-5fb62775df4b',provider:'dsh'},
];
const digest=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const browser=await webkit.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
const page=await context.newPage(),errors=[],unexpected=[],requests=[],rpcTags=[],observations=[];
let ready=false,historyPassed=false,refreshPassed=false;
page.on('pageerror',e=>errors.push({name:e.name}));
page.on('request',r=>requests.push({method:r.method(),path:new URL(r.url()).pathname}));
page.on('websocket',ws=>ws.on('framesent',({payload})=>{
 try{for(const frame of [JSON.parse(String(payload))].flat())if(frame?._tag==='Request')rpcTags.push(frame.tag);}catch{}
}));
await page.route('**/*',route=>{
 const u=new URL(route.request().url());if(u.origin===session.origin)return route.continue();
 unexpected.push({origin:u.origin,method:route.request().method()});return route.abort();
});
await page.addInitScript(()=>{
 window.__testDevices=0;
 if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{window.__testDevices++;throw Error('Device calls are outside this package');};
});
const frame=()=>page.frames().find(f=>f!==page.mainFrame());
const editor=()=>frame().locator('[contenteditable=true]').first();
async function open(c,environmentId){
 await frame().getByLabel('选择项目').selectOption(JSON.stringify([environmentId,c.projectId]));
 await frame().locator(`[data-thread-id="${c.threadId}"]`).getByRole('button',{name:`展开对话 ${c.threadId}`,exact:true}).click();
 await editor().waitFor();
 assert.equal(decodeURIComponent(new URL(frame().url()).pathname),`/native/${environmentId}/${c.threadId}`);
}
async function record(name,data={}){
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 assert.equal(await page.evaluate(()=>window.__testDevices),0);assert.equal(await frame().evaluate(()=>window.__testDevices),0);
 observations.push({name,level:'actual existing native data and original UI through AAA candidate',...data});
}
try{
 await test('actual AAA console and existing original T3 read-only conversations',async t=>{
  await t.test('actual console entry mounts original app and current registered identities',async()=>{
   try{await page.goto(session.url,{waitUntil:'domcontentloaded'});}catch{throw Error('Candidate entry unavailable; private URL omitted');}
   await page.getByRole('tab',{name:'工程入口',exact:true}).click();
   await page.locator('.native-workbench-frame').waitFor();await frame().locator('.aaa-flow-node').first().waitFor();
   assert.equal(await page.locator('.native-workbench-portal').getAttribute('data-phase'),'ready');
   assert.deepEqual(await frame().locator('.aaa-example-badge').allTextContents(),['真实项目 · 只读']);
   assert.equal(await frame().evaluate(()=>!!window.__AAA_PREVIEW_TRANSPORT),false);
   const response=await context.request.get(session.origin+'/api/orchestration/shell');assert.equal(response.status(),200);
   const shell=await response.json();assert.ok(Array.isArray(shell.projects)&&Array.isArray(shell.threads),'Original shell arrays required');
   const descriptor=await (await context.request.get(session.origin+'/.well-known/t3/environment')).json();
   for(const c of cases){const current=shell.threads.find(v=>v.id===c.threadId);assert.ok(current,'Registered thread must exist in current real shell');assert.equal(current.projectId,c.projectId);assert.equal(current.modelSelection.instanceId,c.provider);}
   page.__environmentId=descriptor.environmentId;
   for(const name of ['New project','New thread'])assert.equal(await frame().getByRole('button',{name,exact:true}).isDisabled(),true);
   await record('real-console-native-overview',{environmentId:descriptor.environmentId,projects:shell.projects.length,threads:shell.threads.length,registeredCases:cases});
   ready=true;
  });
  await t.test('Codex and DSH nodes open exact original history and return without sending',async sub=>{
   if(!ready){sub.skip('Real native entry prerequisite failed');return;}
   for(const c of cases){
    await open(c,page.__environmentId);
    const response=await context.request.get(`${session.origin}/api/orchestration/threads/${c.threadId}`);assert.equal(response.status(),200);
    const raw=await response.json(),thread=raw.thread??raw;
    assert.equal(thread.id,c.threadId);assert.equal(thread.projectId,c.projectId);assert.ok(thread.messages.length>0,'Existing trial history required');
    const message=thread.messages.find(m=>m.role==='user'&&typeof m.text==='string'&&m.text.trim());assert.ok(message,'Existing user message required');
    await frame().getByText(message.text.trim(),{exact:false}).first().waitFor();
    const draft=`本包只读草稿 ${c.provider}`;await editor().fill(draft);
    assert.equal(await frame().getByRole('button',{name:'只读浏览：草稿保留，未发送',exact:true}).isDisabled(),true);
    assert.equal(await frame().getByRole('button',{name:'语音输入',exact:false}).isDisabled(),true);
    assert.equal(await frame().getByRole('button',{name:'Add action',exact:true}).isDisabled(),true);
    assert.equal(await frame().getByRole('button',{name:'Open',exact:true}).isDisabled(),true);
    const before=requests.filter(r=>r.method!=='GET').length;
    await editor().press('Enter');await page.waitForTimeout(150);
    assert.equal(requests.filter(r=>r.method!=='GET').length,before);assert.match(await editor().innerText(),new RegExp(draft));
    const screenshot=frame().locator('.aaa-workspace-shell');await screenshot.screenshot({path:`${output}/${c.provider}-original-history.png`});
    await frame().getByRole('link',{name:/项目总览/}).click();await frame().locator(`[data-thread-id="${c.threadId}"]`).waitFor();
    await open(c,page.__environmentId);assert.match(await editor().innerText(),new RegExp(draft));
    await record(`${c.provider}-accurate-history-return`,{threadId:c.threadId,projectId:c.projectId,messages:thread.messages.length,originalHistorySha256:digest(thread.messages),draftPreserved:true,sendDisabled:true});
    await frame().getByRole('link',{name:/项目总览/}).click();await frame().locator('.aaa-flow-node').first().waitFor();
   }
   historyPassed=true;
  });
  await t.test('layout, theme, route and draft survive management refresh and page switching in the same original context',async sub=>{
   if(!historyPassed){sub.skip('Real history prerequisite failed');return;}
   const c=cases[0];await frame().getByLabel('选择项目').selectOption(JSON.stringify([page.__environmentId,c.projectId]));
   await frame().getByRole('button',{name:'放大画布',exact:true}).click();
   const layout=await frame().locator('.aaa-flow-canvas').getAttribute('data-viewport');
   await frame().getByRole('button',{name:'深色',exact:true}).click();await frame().waitForFunction(()=>document.documentElement.classList.contains('dark'));
   await open(c,page.__environmentId);await editor().fill('刷新后保留的原生只读草稿');
   await frame().evaluate(()=>window.__nativeContextMarker='same-original-context');
   const path=new URL(frame().url()).pathname,mountCount=requests.filter(r=>r.path==='/api/native-mount/session').length;
   await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.getByRole('button',{name:'刷新状态',exact:true}).waitFor();
   await page.getByRole('tab',{name:'运行总览',exact:true}).click();assert.equal(await page.locator('.native-workbench-portal').isVisible(),false);
   await page.getByRole('tab',{name:'工程入口',exact:true}).click();
   assert.equal(await frame().evaluate(()=>window.__nativeContextMarker),'same-original-context');assert.equal(new URL(frame().url()).pathname,path);assert.equal(await editor().innerText(),'刷新后保留的原生只读草稿');
   assert.equal(requests.filter(r=>r.path==='/api/native-mount/session').length,mountCount);
   assert.equal(await frame().evaluate(()=>document.documentElement.classList.contains('dark')),true);
   await frame().getByRole('link',{name:/项目总览/}).click();await frame().locator('.aaa-flow-canvas').waitFor();assert.deepEqual(JSON.parse(await frame().locator('.aaa-flow-canvas').getAttribute('data-viewport')),JSON.parse(layout));
   await open(c,page.__environmentId);await record('real-shell-refresh-route-draft-layout-theme',{path,sameOriginalContext:true,additionalMountRequests:0,layoutPreserved:true,draftPreserved:true,dark:true});
   refreshPassed=true;
  });
  await t.test('isolated browser cookie loss is visibly blocked and explicit reconnect restores the original route and draft',async sub=>{
   if(!refreshPassed){sub.skip('Real refresh prerequisite failed');return;}
   const path=new URL(frame().url()).pathname;await page.waitForTimeout(2100);
   await context.clearCookies();const authResponse=await frame().goto(session.origin+path,{waitUntil:'domcontentloaded'});
   const authDocument=await frame().evaluate(()=>{let code=null;try{const v=JSON.parse(document.querySelector('pre')?.textContent??document.body.textContent);code=typeof v.error==='string'?v.error:v.error?.code;}catch{}return {contentType:document.contentType,readyState:document.readyState,rootPresent:!!document.getElementById('root'),code};});
   const phase=await page.locator('.native-workbench-portal').getAttribute('data-phase');
   observations.push({name:'auth-loss-document-diagnostic',status:authResponse.status(),...authDocument,phase,cookieNames:(await context.cookies()).map(c=>c.name)});
   await page.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.phase==='expired',{},{timeout:6000});
   assert.equal(await page.locator('.native-workbench-frame-host').evaluate(e=>e.inert),true);
   await page.getByRole('button',{name:'重新连接原生工作台',exact:true}).click();await editor().waitFor();
   assert.equal(new URL(frame().url()).pathname,path);assert.equal(await editor().innerText(),'刷新后保留的原生只读草稿');
   await record('real-auth-loss-explicit-reconnect',{path,draftPreserved:true,isolatedBrowserCookiesOnly:true});
   assert.deepEqual(rpcTags.filter(s=>/dispatch|Command|terminal\.open|provider\.send/i.test(s)),[]);
   assert.ok(requests.filter(r=>r.method!=='GET').every(r=>['/api/native-mount/session','/api/auth/websocket-ticket'].includes(r.path)),'Only candidate session/ticket POSTs allowed');
  });
 });
}finally{
 const nonReads=requests.filter(r=>r.method!=='GET');
 await writeFile(`${output}/observations.json`,JSON.stringify({observations,errors,unexpected,requestCount:requests.length,nonReads,rpcTags:[...new Set(rpcTags)],disallowedRpcTags:rpcTags.filter(s=>/dispatch|Command|terminal\.open|provider\.send/i.test(s))},null,2)+'\n');
 await context.close();await browser.close();
}
