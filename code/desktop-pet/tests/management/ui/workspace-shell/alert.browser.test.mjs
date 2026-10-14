import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const {webkit}=await import(process.env.PLAYWRIGHT_MODULE),session=JSON.parse(await readFile(process.env.WORKSPACE_UI_SESSION_FILE,'utf8'));
assert.equal(new URL(session.origin).port,'59914');
const legacy=JSON.parse(await readFile(new URL('./fixtures/aaa-warm-4d.json',import.meta.url),'utf8'));
const output=process.env.WORKSPACE_UI_EVIDENCE??'artifacts/W1/workspace-ui-integration-54/real-alert-final';await mkdir(output,{recursive:true});
const browser=await webkit.launch({headless:true}),observations=[];
async function setup(kind){
 const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:'light',reducedMotion:'reduce'}),page=await context.newPage(),errors=[],unexpected=[];page.setDefaultTimeout(12000);
 let seeded;
 if(kind){
  const own=structuredClone(legacy),other={...structuredClone(legacy),id:'w1-existing-user-theme',label:'原用户主题控制',userMetadata:'preserve'};
  if(kind==='edited')own.variants.dark.warningForeground='#ffeebb';if(kind==='extra')own.userMetadata='用户保留字段';
  seeded={library:JSON.stringify([own,other]),selection:'aaaagent-warm',halves:'{"light":"w1-existing-user-theme","dark":"aaaagent-warm"}'};
  await context.addInitScript(value=>{if(sessionStorage.getItem('w1-alert-seeded'))return;sessionStorage.setItem('w1-alert-seeded','true');localStorage.setItem('t3code:themes:v1',value.library);localStorage.setItem('t3code:theme',value.selection);localStorage.setItem('t3code:theme-halves:v1',value.halves);},seeded);
 }
 await context.addInitScript(()=>{window.__w1Devices=0;if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{window.__w1Devices++;throw Error('Device call outside package');};});
 page.on('pageerror',e=>errors.push({name:e.name}));await page.route('**/*',r=>{if(new URL(r.request().url()).origin===session.origin)return r.continue();unexpected.push(new URL(r.request().url()).origin);return r.abort();});
 try{await page.goto(session.url,{waitUntil:'domcontentloaded'});}catch{throw Error('Candidate unavailable; private URL omitted');}
 await page.getByRole('button',{name:'进入工程工作台',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.native-workbench-state')?.hidden===true);const frame=page.frames().find(f=>f!==page.mainFrame());await frame.locator('.aaa-flow-node').first().waitFor();return {context,page,frame,errors,unexpected,seeded};
}
async function storage(s){return s.frame.evaluate(()=>({library:localStorage.getItem('t3code:themes:v1'),selection:localStorage.getItem('t3code:theme'),halves:localStorage.getItem('t3code:theme-halves:v1')}));}
async function finish(name,s,data){assert.deepEqual(s.errors,[]);assert.deepEqual(s.unexpected,[]);assert.equal(await s.page.evaluate(()=>window.__w1Devices),0);assert.equal(await s.frame.evaluate(()=>window.__w1Devices),0);observations.push({name,...data});await s.context.close();}
try{
 await test('actual original DSH warning is readable in light and dark at390',async()=>{
  const s=await setup(),{frame:f,page:p}=s;
  const env=(await (await s.context.request.get(session.origin+'/.well-known/t3/environment')).json()).environmentId;
  await f.getByLabel('选择项目').selectOption(JSON.stringify([env,'84775d4b-a2b1-46ba-8e46-5fb62775df4b']));await f.locator('[data-thread-id="847088d1-ddb9-4fee-b38b-04588cf8a1ad"]').getByRole('button',{name:'展开对话 847088d1-ddb9-4fee-b38b-04588cf8a1ad',exact:true}).click();
  const alert=f.locator('[data-slot=alert][data-variant=warning]').first();await alert.waitFor();const colors=[];
  for(const [mode,label] of [['light','米白'],['dark','深色']]){
   await f.getByRole('button',{name:label,exact:true}).click();await p.waitForFunction(expected=>document.documentElement.dataset.appearance===expected,mode);await f.waitForFunction(dark=>document.documentElement.classList.contains('dark')===dark,mode==='dark');
   const measured=await alert.evaluate(root=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const luminance=pixel=>pixel.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);
    const backgrounds=[];for(let e=root;e;e=e.parentElement)backgrounds.unshift(getComputedStyle(e).backgroundColor);
    const drawBackground=()=>{ctx.clearRect(0,0,1,1);ctx.fillStyle='white';ctx.fillRect(0,0,1,1);for(const bg of backgrounds){ctx.fillStyle=bg;ctx.fillRect(0,0,1,1);}};
    drawBackground();const surface=Array.from(ctx.getImageData(0,0,1,1).data),bgLum=luminance(surface);
    const entries=[root.querySelector('[data-slot=alert-title]'),root.querySelector('[data-slot=alert-description]')].filter(e=>e&&e.textContent.trim());
    const paletteStyle=getComputedStyle(document.documentElement);const statusPairs=['error','warning','update'].map(role=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=paletteStyle.getPropertyValue(`--${role}-surface`);ctx.fillRect(0,0,1,1);const statusSurface=Array.from(ctx.getImageData(0,0,1,1).data),surfaceLum=luminance(statusSurface);ctx.globalAlpha=.8;ctx.fillStyle=paletteStyle.getPropertyValue(`--${role}-foreground`);ctx.fillRect(0,0,1,1);ctx.globalAlpha=1;const foreground=Array.from(ctx.getImageData(0,0,1,1).data),foregroundLum=luminance(foreground);return {role,surface:statusSurface,foregroundAt80Percent:foreground,contrast:(Math.max(foregroundLum,surfaceLum)+.05)/(Math.min(foregroundLum,surfaceLum)+.05)};});
    return {surface,statusPairs,foregrounds:entries.map(e=>{drawBackground();const color=getComputedStyle(e).color;ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const pixel=Array.from(ctx.getImageData(0,0,1,1).data),fgLum=luminance(pixel);return {slot:e.dataset.slot,color,pixel,contrast:(Math.max(fgLum,bgLum)+.05)/(Math.min(fgLum,bgLum)+.05)};})};
   });
   assert.ok(measured.foregrounds.length);for(const value of measured.foregrounds)assert.ok(value.contrast>=4.5,`${mode} ${value.slot} contrast ${value.contrast}`);
   for(const pair of measured.statusPairs)assert.ok(pair.contrast>=4.5,`${mode} ${pair.role} semantic palette contrast ${pair.contrast}`);colors.push({mode,...measured});await p.screenshot({path:output+`/dsh-warning-${mode}-390.png`});
  }
  await finish('actual-original-warning-light-dark',s,{threadId:'847088d1-ddb9-4fee-b38b-04588cf8a1ad',colors,realPhone:false});
 });
 await test('only complete old automatic palette migrates; other user theme, selection and halves remain',async()=>{
  const s=await setup('legacy'),after=await storage(s),original=JSON.parse(s.seeded.library),updated=JSON.parse(after.library);
  assert.deepEqual(updated[1],original[1]);assert.equal(JSON.stringify(updated[1]),JSON.stringify(original[1]));assert.equal(after.selection,s.seeded.selection);assert.equal(after.halves,s.seeded.halves);
  for(const [label,before,now] of [['light',original[0].colors,updated[0].colors],['dark',original[0].variants.dark,updated[0].variants.dark]]){
   const changed=Object.keys(before).filter(key=>before[key]!==now[key]).sort();assert.deepEqual(changed,['errorForeground','updateForeground','warningForeground']);
  }
  await s.frame.getByRole('button',{name:'深色',exact:true}).click();assert.equal((await storage(s)).halves,s.seeded.halves);await finish('exact-old-auto-palette-migration',s,{changedOnlyForegrounds:true,otherDefinitionBytesKept:true,selectionAndHalvesBytesKept:true,level:'actual native app with isolated old-module palette seed'});
 });
 await test('same-ID user color edit or extra metadata is preserved through mode switch and reload',async()=>{
  for(const kind of ['edited','extra']){
   const s=await setup(kind);assert.deepEqual(await storage(s),s.seeded);await s.frame.getByRole('button',{name:'深色',exact:true}).click();assert.deepEqual(await storage(s),s.seeded);
   await s.page.reload();await s.page.getByRole('button',{name:'进入工程工作台',exact:true}).click();await s.page.waitForFunction(()=>document.querySelector('.native-workbench-state')?.hidden===true);s.frame=s.page.frames().find(f=>f!==s.page.mainFrame());await s.frame.locator('.aaa-workspace-bar').waitFor();assert.deepEqual(await storage(s),s.seeded);
   await finish(`same-id-${kind}-preserved`,s,{entireLibrarySelectionAndHalvesBytesKept:true,level:'actual native app with isolated user-edit seed'});
  }
 });
}finally{await writeFile(output+'/observations.json',JSON.stringify({sourceRef:process.env.WORKSPACE_UI_SOURCE_REF,observations,scope:'Only changed U03 warning and exact auto-palette migration. Seeded browser preference cases are controlled protection evidence; original DSH warning from actual service. No model/device/natural-use acceptance.'},null,2)+'\n');await browser.close();}
