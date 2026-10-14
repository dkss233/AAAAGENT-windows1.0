import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const {webkit}=await import(process.env.PLAYWRIGHT_MODULE);
const session=JSON.parse(await readFile(process.env.WORKSPACE_UI_SESSION_FILE,'utf8'));
assert.equal(new URL(session.origin).port,'59914');
const output=process.env.WORKSPACE_UI_EVIDENCE??'artifacts/W1/workspace-ui-integration-54/real-toolbar-fixed';await mkdir(output,{recursive:true});
const browser=await webkit.launch({headless:true}),context=await browser.newContext({viewport:{width:1280,height:720},colorScheme:'light',reducedMotion:'reduce'}),page=await context.newPage();
page.setDefaultTimeout(12000);const observations=[],errors=[],unexpected=[],requests=[];let phase='entry';
page.on('pageerror',e=>{let message=e.message;for(const value of [session.url,session.token].filter(Boolean))message=message.split(value).join('[private]');message=message.replace(/https?:\/\/[^\s]+/g,'[URL omitted]');errors.push({name:e.name,message,phase});});page.on('request',r=>requests.push({method:r.method(),path:new URL(r.url()).pathname}));
await page.route('**/*',r=>{if(new URL(r.request().url()).origin===session.origin)return r.continue();unexpected.push(new URL(r.request().url()).origin);return r.abort();});
if(process.env.WORKSPACE_UI_RESIZE_TRACE==='1')await context.addInitScript(()=>{
 const Native=ResizeObserver;window.__w1ResizeTrace=[];
 window.ResizeObserver=class extends Native{constructor(callback){const source=new Error().stack?.replace(/https?:\/\/[^\s)]+/g,'[asset URL omitted]');super((entries,observer)=>{window.__w1ResizeTrace.push({source,at:performance.now(),targets:entries.map(e=>({tag:e.target.tagName,classes:e.target.className,attrs:Array.from(e.target.attributes).filter(a=>a.name.startsWith('data-')).map(a=>[a.name,a.value]),width:e.contentRect.width,height:e.contentRect.height}))});if(window.__w1ResizeTrace.length>200)window.__w1ResizeTrace.shift();callback(entries,observer);});}};
});
await context.addInitScript(()=>{window.__w1Devices=0;if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{window.__w1Devices++;throw Error('Device calls outside package');};});
let frame,environmentId,documentMarker,ready=false;
const editor=()=>frame.locator('[contenteditable=true]').first();
const cases=[{provider:'codex',threadId:'55321ff5-339c-4654-b094-8eed93833125',projectId:'5659cde4-4f61-4748-807f-cef35b1aecf5'},{provider:'dsh',threadId:'847088d1-ddb9-4fee-b38b-04588cf8a1ad',projectId:'84775d4b-a2b1-46ba-8e46-5fb62775df4b'}];
async function enter(){await page.getByRole('button',{name:'进入工程工作台',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.native-workbench-state')?.hidden===true);frame=page.frames().find(f=>f!==page.mainFrame());await frame.locator('.aaa-workspace-bar').waitFor();}
async function management(){const viewport=await frame.evaluate(()=>[innerWidth,innerHeight]);await frame.getByRole('button',{name:'AAAAGENT 菜单',exact:true}).click();await frame.getByRole('menuitem',{name:'运行总览',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.native-workbench-portal').hidden);assert.deepEqual(await frame.evaluate(()=>[innerWidth,innerHeight]),viewport,'Collapsing portal must preserve the original internal viewport');}
async function bounds(locator,width,height){const b=await locator.boundingBox();assert.ok(b&&b.x>=-1&&b.y>=-1&&b.x+b.width<=width+1&&b.y+b.height<=height+1,'Control must fit viewport');return b;}
async function checkToolbar(width,height){
 await frame.waitForFunction(()=>{const bar=document.querySelector('.aaa-workspace-bar');return bar&&Number.parseFloat(bar.parentElement.style.getPropertyValue('--aaa-toolbar-height'))===bar.getBoundingClientRect().height;});
 assert.equal(await frame.locator('.aaa-workspace-bar').count(),1);assert.equal(await frame.locator('[data-chat-header]').count(),0,'Original second header must be removed, not only AAA counted');
 const bar=await bounds(frame.locator('.aaa-workspace-bar'),width,height);
 const controls=frame.locator('.aaa-workspace-bar [data-panel-layout-controls]');assert.equal(await controls.count(),1);
 await bounds(controls,width,height);await bounds(frame.getByRole('button',{name:'More header actions',exact:true}),width,height);
 const buttons=frame.locator('.aaa-workspace-bar button:visible');const boxes=[];
 for(const button of await buttons.all()){const b=await bounds(button,width,height);assert.ok(b.y>=bar.y&&b.y+b.height<=bar.y+bar.height+1);boxes.push(b);}
 for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)assert.ok(Math.min(boxes[i].x+boxes[i].width,boxes[j].x+boxes[j].width)-Math.max(boxes[i].x,boxes[j].x)<=1||Math.min(boxes[i].y+boxes[i].height,boxes[j].y+boxes[j].height)-Math.max(boxes[i].y,boxes[j].y)<=1,'Visible toolbar buttons must not overlap');
 return {bar,composer:await bounds(editor(),width,height),originalControlsInsideSharedBar:true,secondHeaderAbsent:true};
}
async function record(name,data){assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(await page.evaluate(()=>window.__w1Devices),0);assert.equal(await frame.evaluate(()=>window.__w1Devices),0);observations.push({name,...data});}
try{
 await test('real gesture-canvas outside click closes menu; hover and Escape remain',async()=>{
  try{await page.goto(session.url,{waitUntil:'domcontentloaded'});}catch{throw Error('Candidate unavailable; private URL omitted');}await enter();if(process.env.WORKSPACE_UI_PRESERVE_VIEWPORT_PROBE==='1')await page.locator('.native-workbench-frame-host').evaluate(e=>{e.style.width='100vw';e.style.height='100vh';});await frame.locator('.aaa-flow-node').first().waitFor();
  environmentId=(await (await context.request.get(session.origin+'/.well-known/t3/environment')).json()).environmentId;
  documentMarker=await frame.evaluate(()=>window.__w1Document=Math.random());
  const trigger=frame.getByRole('button',{name:'AAAAGENT 菜单',exact:true});await trigger.click();await page.mouse.move(936,586);assert.equal(await trigger.getAttribute('aria-expanded'),'true');
  assert.equal(await frame.evaluate(()=>!!document.elementFromPoint(936,586)?.closest('.aaa-flow-canvas')),true,'Click the actual canvas blank, as in independent failure evidence');
  await page.mouse.click(936,586);await frame.waitForFunction(()=>document.querySelector('.aaa-menu-trigger')?.getAttribute('aria-expanded')==='false');assert.equal(await frame.getByRole('menu',{name:'管理页面'}).count(),0);
  await trigger.click();await trigger.press('Escape');assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
  await page.screenshot({path:output+'/canvas-outside-closed-1280.png'});await record('actual-canvas-outside-click',{point:[936,586],hoverKept:true,escapeFocusRestored:true});ready=true;
 });
 for(const c of cases)await test(`actual ${c.provider} original controls, single toolbar and state at 1280/390`,async t=>{
  if(!ready){t.skip('Entry prerequisite failed');return;}
  await page.setViewportSize({width:1280,height:720});if(await editor().count())await frame.locator('.aaa-home-link').click();await frame.getByLabel('选择项目').selectOption(JSON.stringify([environmentId,c.projectId]));await frame.locator(`[data-thread-id="${c.threadId}"]`).getByRole('button',{name:`展开对话 ${c.threadId}`,exact:true}).click();await editor().waitFor();
  await frame.getByRole('button',{name:'深色',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.appearance==='dark');
  await frame.getByRole('button',{name:'More header actions',exact:true}).waitFor();const large=await checkToolbar(1280,720);
  phase='original-menu';await frame.getByRole('button',{name:'More header actions',exact:true}).click();await page.screenshot({path:output+`/${c.provider}-original-actions-open-1280.png`});await frame.locator('[role=menu][data-chat-header-actions]').waitFor();
  const locked=await frame.locator('[role=menu][data-chat-header-actions]').locator('[data-aaa-readonly-action=true]').count();assert.ok(locked>0,'Original write-action prevention remains on relocated menu');
  const menu=frame.locator('[role=menu][data-chat-header-actions]');await menu.press('Escape');
  phase='original-panel';const panel=frame.getByRole('button',{name:'Toggle right panel',exact:true});assert.equal(await panel.getAttribute('aria-pressed'),'false');await panel.click();await frame.waitForFunction(()=>document.querySelector('[aria-label="Toggle right panel"]')?.getAttribute('aria-pressed')==='true');await panel.click();await frame.waitForFunction(()=>document.querySelector('[aria-label="Toggle right panel"]')?.getAttribute('aria-pressed')==='false');
  await page.screenshot({path:output+`/${c.provider}-single-toolbar-dark-1280.png`});
  const raw=await (await context.request.get(session.origin+`/api/orchestration/threads/${c.threadId}`)).json(),thread=raw.thread??raw;assert.equal(thread.id,c.threadId);
  const message=thread.messages.find(m=>m.role==='user'&&typeof m.text==='string'&&m.text.trim());assert.ok(message);await frame.getByText(message.text.trim(),{exact:false}).first().waitFor();
  const draft=`单栏复核未发送草稿 ${c.provider}`;await editor().fill(draft);const route=new URL(frame.url()).pathname;
  assert.equal(await frame.getByRole('button',{name:'只读浏览：草稿保留，未发送',exact:true}).isDisabled(),true);
  assert.equal(await frame.getByRole('button',{name:'语音输入',exact:false}).isDisabled(),true);
  phase='management-return';await management();await page.getByRole('button',{name:'刷新状态',exact:true}).click();await enter();assert.equal(await frame.evaluate(()=>window.__w1Document),documentMarker);assert.equal(new URL(frame.url()).pathname,route);assert.equal(await editor().innerText(),draft);
  phase='resize390';await page.setViewportSize({width:390,height:844});await frame.waitForFunction(()=>innerWidth===390);const small=await checkToolbar(390,844);await page.screenshot({path:output+`/${c.provider}-single-toolbar-dark-390.png`});
  await frame.getByRole('button',{name:'AAAAGENT 菜单',exact:true}).click();await bounds(frame.getByRole('menu',{name:'管理页面'}),390,844);await page.screenshot({path:output+`/${c.provider}-menu-dark-390.png`});await frame.getByRole('menuitem',{name:'运行总览',exact:true}).press('Escape');
  assert.equal(await editor().innerText(),draft);await editor().fill('');await record(`single-toolbar-original-${c.provider}`,{threadId:c.threadId,historySha:createHash('sha256').update(JSON.stringify(thread.messages)).digest('hex'),large,small,lockedOriginalActions:locked,originalRightPanelToggle:true,sameDocument:true,draftPreserved:true,temporaryDraftCleared:true,realPhone:false});
  await frame.locator('.aaa-home-link').click();await frame.getByLabel('选择项目').waitFor();
 });
}finally{const resizeTrace=process.env.WORKSPACE_UI_RESIZE_TRACE==='1'&&frame?await frame.evaluate(()=>window.__w1ResizeTrace):undefined;await writeFile(output+'/observations.json',JSON.stringify({sourceRef:process.env.WORKSPACE_UI_SOURCE_REF,isolatedViewportCSSProbe:process.env.WORKSPACE_UI_PRESERVE_VIEWPORT_PROBE==='1',observations,errors,unexpected,requests,resizeTrace,scope:'Actual new-document candidate, U01 real canvas outside click, original React controls, 1280/390 composer and preserved drafts; no model, devices, writes, manual Safari or natural-use acceptance.'},null,2)+'\n');await context.close();await browser.close();}
