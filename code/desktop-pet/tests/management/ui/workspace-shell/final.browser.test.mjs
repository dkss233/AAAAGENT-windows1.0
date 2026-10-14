import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const {webkit}=await import(process.env.PLAYWRIGHT_MODULE);
const session=JSON.parse(await readFile(process.env.WORKSPACE_UI_SESSION_FILE,'utf8'));
assert.equal(new URL(session.origin).port,'59914');
const output=process.env.WORKSPACE_UI_EVIDENCE??'artifacts/W1/workspace-ui-integration-54/real-final';await mkdir(output,{recursive:true});
const browser=await webkit.launch({headless:true}),observations=[];
async function setup(seed=false,denied=false){
 const context=await browser.newContext({viewport:{width:1280,height:720},colorScheme:'light',reducedMotion:'reduce'});
 if(seed)await context.addInitScript(()=>{if(!sessionStorage.getItem('w1-theme-seeded')){localStorage.removeItem('t3code:theme');localStorage.setItem('t3code:theme-halves:v1',JSON.stringify({light:'aaaagent-warm',dark:'aaaagent-warm'}));sessionStorage.setItem('w1-theme-seeded','true');}});
 if(denied)await context.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='t3code:theme-appearance-mode')throw new DOMException('Controlled appearance storage denial','SecurityError');return original.call(this,k,v);};});
 await context.addInitScript(()=>{window.__w1Devices=0;if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{window.__w1Devices++;throw Error('Device calls outside package');};});
 const page=await context.newPage(),errors=[],unexpected=[];page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push({name:e.name}));
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin===session.origin)return route.continue();unexpected.push(new URL(route.request().url()).origin);return route.abort();});
 try{await page.goto(session.url,{waitUntil:'domcontentloaded'});}catch{throw Error('Candidate unavailable; private URL omitted');}
 await page.getByRole('button',{name:'进入工程工作台',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.native-workbench-state')?.hidden===true);
 const frame=page.frames().find(f=>f!==page.mainFrame());await frame.locator('.aaa-flow-node').first().waitFor();return {context,page,frame,errors,unexpected};
}
async function finish(name,s,data={}){assert.deepEqual(s.errors,[]);assert.deepEqual(s.unexpected,[]);assert.equal(await s.page.evaluate(()=>window.__w1Devices),0);assert.equal(await s.frame.evaluate(()=>window.__w1Devices),0);observations.push({name,sourceRef:process.env.WORKSPACE_UI_SOURCE_REF,...data});await s.context.close();}
try{
 await test('actual initial project path, single brand, original details and 390 input/menu',async()=>{
  const s=await setup(),{page:p,frame:f}=s;
  const selected=await f.getByLabel('选择项目').inputValue(),[environmentId,projectId]=JSON.parse(selected);
  const shell=await (await s.context.request.get(session.origin+'/api/orchestration/shell')).json(),project=shell.projects.find(v=>v.id===projectId);
  await f.waitForFunction(title=>document.querySelector('.aaa-workspace-path')?.textContent===title,project.title);
  assert.equal(await f.getByRole('link',{name:'Go to threads',exact:true}).isVisible(),false);
  await p.screenshot({path:output+'/workspace-light-1280.png'});
  await f.getByRole('button',{name:'深色',exact:true}).click();await p.waitForFunction(()=>document.documentElement.dataset.appearance==='dark');await f.waitForFunction(()=>document.documentElement.classList.contains('dark'));
  await p.screenshot({path:output+'/workspace-dark-1280.png'});
  const caseId='55321ff5-339c-4654-b094-8eed93833125';await f.locator(`[data-thread-id="${caseId}"]`).getByRole('button',{name:`展开对话 ${caseId}`,exact:true}).click();await f.locator('[contenteditable=true]').first().waitFor();
  const input=f.locator('[contenteditable=true]').first(),box=await input.boundingBox();assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=1281&&box.y+box.height<=721);
  await p.screenshot({path:output+'/original-codex-dark-1280.png'});
  await p.setViewportSize({width:390,height:844});await f.waitForFunction(()=>innerWidth===390);const small=await input.boundingBox();assert.ok(small&&small.x>=0&&small.x+small.width<=391&&small.y+small.height<=845);
  await input.fill('390本包临时未发送草稿');await p.screenshot({path:output+'/original-codex-dark-390.png'});
  await f.getByRole('button',{name:'AAAAGENT 菜单',exact:true}).click();await f.getByRole('menu',{name:'管理页面'}).waitFor();const menuBox=await f.getByRole('menu').boundingBox();assert.ok(menuBox.x>=0&&menuBox.x+menuBox.width<=391&&menuBox.y+menuBox.height<=845);await p.screenshot({path:output+'/menu-dark-390.png'});await f.getByRole('menuitem',{name:'运行总览',exact:true}).press('Escape');
  await f.locator('.aaa-home-link').click();await f.getByRole('button',{name:'列表',exact:true}).click();await p.screenshot({path:output+'/workspace-list-dark-390.png'});
  await finish('U01-U04-final-display-and-original-input',s,{environmentId,projectId,projectTitle:project.title,singleBrand:true,composer1280:box,composer390:small,menu390:menuBox,realPhone:false});
 });
 await test('existing original theme halves without theme selection survive initialization and mode toggle',async()=>{
  const s=await setup(true),{frame:f,page:p}=s;
  const expected=JSON.stringify({light:'aaaagent-warm',dark:'aaaagent-warm'});
  assert.equal(await f.evaluate(()=>localStorage.getItem('t3code:theme-halves:v1')),expected);
  await f.getByRole('button',{name:'深色',exact:true}).click();await p.waitForFunction(()=>document.documentElement.dataset.appearance==='dark');assert.equal(await f.evaluate(()=>localStorage.getItem('t3code:theme-halves:v1')),expected);
  await finish('U03-original-native-halves-protection',s,{level:'actual native app and original data, isolated browser theme seed',themeHalvesPreserved:true});
 });
 await test('denied preference writes still change both actual surfaces and show unsaved state',async()=>{
  const s=await setup(false,true),{page:p,frame:f}=s;
  await f.getByRole('button',{name:'深色',exact:true}).click();await p.waitForFunction(()=>document.documentElement.dataset.appearance==='dark');await f.waitForFunction(()=>document.documentElement.classList.contains('dark'));
  assert.equal(await p.evaluate(()=>window.AAAAppearance.state().saved),false);assert.ok((await f.locator('.aaa-appearance').innerText()).includes('暂时无法保存'));
  await finish('U03-original-hook-denied-write',s,{level:'actual native app with isolated browser storage-denial injection',inMemoryBothSurfaces:true,saved:false});
 });
}finally{await writeFile(output+'/observations.json',JSON.stringify({observations,sourceRef:process.env.WORKSPACE_UI_SOURCE_REF,scope:'Only final changed display/appearance and previously uncovered actual composer; original f54 state-return evidence remains separate.'},null,2)+'\n');await browser.close();}
