import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
assert.ok(process.env.PLAYWRIGHT_MODULE&&process.env.WORKSPACE_UI_SESSION_FILE,'Use the I-owned actual candidate; no new service');
const {webkit}=await import(process.env.PLAYWRIGHT_MODULE);
const session=JSON.parse(await readFile(process.env.WORKSPACE_UI_SESSION_FILE,'utf8'));
assert.equal(new URL(session.origin).hostname,'127.0.0.1');assert.equal(new URL(session.origin).port,'59914');
const output=process.env.WORKSPACE_UI_EVIDENCE??'artifacts/W1/workspace-ui-integration-54/real';await mkdir(output,{recursive:true});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const browser=await webkit.launch({headless:true}),context=await browser.newContext({viewport:{width:1280,height:720},colorScheme:'light'}),page=await context.newPage();
page.setDefaultTimeout(12000);
const errors=[],unexpected=[],requests=[],rpcTags=[],observations=[];
page.on('pageerror',e=>errors.push({name:e.name}));page.on('request',r=>requests.push({method:r.method(),path:new URL(r.url()).pathname}));
page.on('websocket',ws=>ws.on('framesent',({payload})=>{try{for(const f of [JSON.parse(String(payload))].flat())if(f?._tag==='Request')rpcTags.push(f.tag);}catch{}}));
await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===session.origin)return route.continue();unexpected.push({origin:u.origin,method:route.request().method()});return route.abort();});
await context.addInitScript(()=>{window.__w1DeviceCalls=0;if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{window.__w1DeviceCalls++;throw Error('Device tests not authorized');};});
const frame=()=>page.frames().find(f=>f!==page.mainFrame());
const editor=()=>frame().locator('[contenteditable=true]').first();
const cases=[{threadId:'55321ff5-339c-4654-b094-8eed93833125',projectId:'5659cde4-4f61-4748-807f-cef35b1aecf5',provider:'codex'},{threadId:'847088d1-ddb9-4fee-b38b-04588cf8a1ad',projectId:'84775d4b-a2b1-46ba-8e46-5fb62775df4b',provider:'dsh'}];
let environmentId,ready=false,marker;
async function enter(){await page.getByRole('button',{name:'进入工程工作台',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.native-workbench-state')?.hidden===true);await frame().locator('.aaa-workspace-shell').waitFor();}
async function navigateManagement(label){await frame().getByRole('button',{name:'AAAAGENT 菜单',exact:true}).click();await frame().getByRole('menuitem',{name:label,exact:true}).click();await page.waitForFunction(()=>document.querySelector('.native-workbench-portal').hidden);}
async function open(c){await frame().getByLabel('选择项目').selectOption(JSON.stringify([environmentId,c.projectId]));await frame().locator(`[data-thread-id="${c.threadId}"]`).getByRole('button',{name:`展开对话 ${c.threadId}`,exact:true}).click();await editor().waitFor();}
async function record(name,data={}){assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(await page.evaluate(()=>window.__w1DeviceCalls),0);if(frame())assert.equal(await frame().evaluate(()=>window.__w1DeviceCalls),0);observations.push({name,level:'actual AAA entry and existing original T3 data in WebKit',...data});}
async function visible(locator){const box=await locator.boundingBox();assert.ok(box&&box.x>=-1&&box.y>=-1&&box.x+box.width<=1281&&box.y+box.height<=721,'Control inside viewport');}
try{
 await test('actual unified workspace U01-U05 targeted checks',async t=>{
  await t.test('dedicated entry, one toolbar, full workspace and original identities',async()=>{
   try{await page.goto(session.url,{waitUntil:'domcontentloaded'});}catch{throw Error('Candidate entry unavailable; private URL omitted');}
   await page.getByRole('button',{name:'进入工程工作台',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'工程入口',exact:true}).count(),0);
   const durations=await page.getByRole('button',{name:'进入工程工作台'}).evaluate(b=>{b.click();return document.querySelector('.native-workbench-portal').getAnimations().map(a=>a.effect.getTiming().duration);});assert.deepEqual(durations,[260]);
   await page.waitForFunction(()=>document.querySelector('.native-workbench-state')?.hidden===true);await frame().locator('.aaa-flow-node').first().waitFor();
   assert.equal(await frame().locator('.aaa-workspace-bar').count(),1);assert.equal(await page.locator('.sidebar').isVisible(),false);
   const rect=await page.locator('.native-workbench-portal').evaluate(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}});assert.deepEqual(rect,{x:0,y:0,w:1280,h:720});
   const shell=await (await context.request.get(session.origin+'/api/orchestration/shell')).json();const descriptor=await (await context.request.get(session.origin+'/.well-known/t3/environment')).json();environmentId=descriptor.environmentId;
   for(const c of cases){const thread=shell.threads.find(v=>v.id===c.threadId);assert.equal(thread.projectId,c.projectId);assert.equal(thread.modelSelection.instanceId,c.provider);}
   assert.equal(await frame().evaluate(()=>!!window.__AAA_PREVIEW_TRANSPORT),false);marker=await frame().evaluate(()=>window.__w1Document=Math.random());
   await page.screenshot({path:output+'/workspace-light-1280.png'});await visible(frame().getByLabel('放大画布'));await record('U01-original-single-shell',{environmentId,projects:shell.projects.length,threads:shell.threads.length,rect,animationDurationMs:durations});ready=true;
  });
  await t.test('click menu stays on hover, closes on Escape and routes back; appearance across both surfaces',async sub=>{
   if(!ready){sub.skip('Entry prerequisite failed');return;}
   const trigger=frame().getByRole('button',{name:'AAAAGENT 菜单',exact:true});await trigger.click();await frame().getByRole('menu',{name:'管理页面'}).waitFor();await page.mouse.move(1200,680);assert.equal(await frame().getByRole('menu',{name:'管理页面'}).isVisible(),true);await trigger.press('Escape');assert.equal(await frame().getByRole('menu',{name:'管理页面'}).count(),0);assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
   const customBefore=await frame().evaluate(()=>({themes:localStorage.getItem('t3code:themes:v1'),halves:localStorage.getItem('t3code:theme-halves:v1')}));
   await frame().getByRole('button',{name:'深色',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.appearance==='dark');await frame().waitForFunction(()=>document.documentElement.classList.contains('dark'));
   assert.deepEqual(await frame().evaluate(()=>({themes:localStorage.getItem('t3code:themes:v1'),halves:localStorage.getItem('t3code:theme-halves:v1')})),customBefore);
   await page.screenshot({path:output+'/workspace-dark-1280.png'});await navigateManagement('模型与声音');await page.getByRole('heading',{name:'模型与声音',exact:true}).waitFor();assert.equal(await page.locator('html').getAttribute('data-appearance'),'dark');await page.screenshot({path:output+'/management-models-dark.png'});
   await page.getByLabel('外观',{exact:true}).selectOption('light');await frame().waitForFunction(()=>!document.documentElement.classList.contains('dark'));await enter();assert.equal(await frame().evaluate(()=>window.__w1Document),marker);
   await frame().getByRole('button',{name:'跟随系统',exact:true}).click();await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.appearance==='dark');await frame().waitForFunction(()=>document.documentElement.classList.contains('dark'));
   await frame().getByRole('button',{name:'米白',exact:true}).click();await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.appearance==='light');assert.equal(await frame().evaluate(()=>document.documentElement.classList.contains('dark')),false);
   await record('U03-shared-theme-menu-original-custom',{customThemeSha:digest(customBefore),systemAndExplicit:true,sameDocument:true});
  });
  await t.test('original Codex and DSH history, draft and view remain after management return and parent refresh',async sub=>{
   if(!ready){sub.skip('Entry prerequisite failed');return;}
   for(const c of cases){await open(c);assert.equal(decodeURIComponent(new URL(frame().url()).pathname),`/native/${environmentId}/${c.threadId}`);
    const raw=await (await context.request.get(session.origin+`/api/orchestration/threads/${c.threadId}`)).json(),thread=raw.thread??raw;assert.equal(thread.id,c.threadId);const message=thread.messages.find(m=>m.role==='user'&&typeof m.text==='string'&&m.text.trim());assert.ok(message);await frame().getByText(message.text.trim(),{exact:false}).first().waitFor();
    const draft=`界面整合只读草稿 ${c.provider}`;await editor().fill(draft);const route=new URL(frame().url()).pathname;
    assert.equal(await frame().getByRole('button',{name:'只读浏览：草稿保留，未发送',exact:true}).isDisabled(),true);assert.equal(await frame().getByRole('button',{name:'语音输入',exact:false}).isDisabled(),true);
    await navigateManagement('运行总览');await page.getByRole('button',{name:'刷新状态',exact:true}).click();await enter();assert.equal(await frame().evaluate(()=>window.__w1Document),marker);assert.equal(new URL(frame().url()).pathname,route);assert.match(await editor().innerText(),new RegExp(draft));
    await frame().locator('.aaa-home-link').click();await frame().locator(`[data-thread-id="${c.threadId}"]`).waitFor();await frame().getByLabel('放大画布').click();const canvas=frame().locator('.aaa-flow-canvas');await canvas.focus();await canvas.press('ArrowRight');const viewport=await canvas.getAttribute('data-viewport');const node=frame().locator(`[data-thread-id="${c.threadId}"]`);await node.focus();await node.press('ArrowRight');const style=await node.getAttribute('style');
    await navigateManagement('运行总览');await enter();assert.equal(await canvas.getAttribute('data-viewport'),viewport);assert.equal(await node.getAttribute('style'),style);
    await record(`U05-${c.provider}-original-state-preserved`,{threadId:c.threadId,projectId:c.projectId,historySha:digest(thread.messages),draftPreserved:true,viewport:JSON.parse(viewport),nodeStyle:style});
   }
  });
  await t.test('390px project drawer and toolbar remain usable; stored theme reload',async sub=>{
   if(!ready){sub.skip('Entry prerequisite failed');return;}
   await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.native-workbench-portal').getBoundingClientRect().width===390);await frame().getByRole('button',{name:'深色',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.appearance==='dark');
   await frame().getByRole('button',{name:'项目导航',exact:true}).click();await frame().getByRole('dialog').waitFor();await frame().getByRole('dialog').press('Escape');await page.screenshot({path:output+'/workspace-dark-390.png'});
   const tools=await frame().getByLabel('放大画布').boundingBox();assert.ok(tools&&tools.x+tools.width<=391&&tools.y+tools.height<=845);await frame().getByLabel('放大画布').click();await navigateManagement('运行总览');await page.reload();assert.equal(await page.locator('html').getAttribute('data-appearance'),'dark');
   await record('U04-narrow-drawer-theme-reload',{viewport:[390,844],realPhone:false});
  });
 });
}finally{
 await writeFile(output+'/observations.json',JSON.stringify({observations,errors,unexpected,requests,rpcTags,sourceRef:process.env.WORKSPACE_UI_SOURCE_REF??null,level:'actual candidate browser, no model/device/natural-use acceptance',rpcCaveat:'Client tags record attempts; I exact gateway audit determines forwarding and business writes.'},null,2)+'\n');await context.close();await browser.close();
}
