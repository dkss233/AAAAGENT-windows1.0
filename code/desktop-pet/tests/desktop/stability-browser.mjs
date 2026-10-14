import assert from 'node:assert/strict';import {writeFile,mkdir} from 'node:fs/promises';import {resolve} from 'node:path';import {stabilityFixture} from './stability-fixture.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),baseline=process.argv.includes('--baseline');
const out=resolve('../../artifacts/W1/panel-stability-01'),fixture=await stabilityFixture(baseline);await mkdir(resolve(out,'video'),{recursive:true});
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1280,height:720},deviceScaleFactor:2,recordVideo:{dir:resolve(out,'video'),size:{width:1280,height:720}}}),page=await context.newPage(),results=[],interactionChecks=[];
try{
 await page.goto(fixture.url);await page.waitForFunction(()=>reports.some(x=>x.type==='model-loaded')&&samples.filter(x=>x.kind==='draw').length>3);
 const cases=baseline?[{screen:[0,0,1280,720],width:360,anchor:[800,650],mode:'half'}]:[
  {screen:[0,0,1280,720],width:360,anchor:[990,650],mode:'half'},
  {screen:[-1440,-100,1440,900],width:220,anchor:[-1440,0],mode:'full'},
  {screen:[-1440,-100,1440,900],width:720,anchor:[0,800],mode:'half'},
  {screen:[0,0,800,560],width:720,anchor:[400,560],mode:'full'},
  {screen:[0,50,320,560],width:360,anchor:[160,610],mode:'half'}];
 for(const c of cases){
  await page.setViewportSize({width:c.screen[2],height:c.screen[3]});await page.evaluate(c=>setCase({...c,open:false}),c);await page.waitForTimeout(180);
  await page.evaluate(()=>samples.length=0);
  await page.evaluate(()=>child().document.getElementById('open').click());await page.waitForTimeout(320);
  await page.screenshot({path:resolve(out,(baseline?'before':'after')+'-'+results.length+'-open.png')});
  await page.evaluate(()=>child().document.getElementById('close').click());await page.waitForTimeout(320);
  await page.evaluate(async()=>{const d=child().document;for(let i=0;i<3;i++){d.getElementById('open').click();await new Promise(r=>setTimeout(r,45));d.getElementById('close').click();await new Promise(r=>setTimeout(r,45))}d.getElementById('open').click()});await page.waitForTimeout(280);
  await page.evaluate(()=>child().document.getElementById('close').click());await page.waitForTimeout(300);
  await page.evaluate(()=>settled());
  const r=await page.evaluate(()=>({samples,layouts:layouts.slice(-12),hidden:child().document.getElementById('drawer').hidden,frame:lastLayout.frame,pet:lastLayout.pet}));
  const first=r.samples.find(x=>x.kind==='frame').screenRect;
  const stable=r.samples.every(x=>x.screenRect.every((n,i)=>Math.abs(n-first[i])<.06));
  const resets=r.samples.filter(x=>x.kind==='buffer-reset'),draws=r.samples.filter(x=>x.kind==='draw'),empty=draws.filter(x=>!x.ink);
  results.push({input:c,stable,bufferResets:resets.length,draws:draws.length,emptyDraws:empty.length,...r});
  if(!baseline){assert.ok(stable,JSON.stringify(c)+' intermediate frame shifted');assert.equal(resets.length,0,'toggle reset actual canvas buffer');assert.ok(draws.length>10);assert.equal(empty.length,0);assert.ok(r.hidden);assert.deepEqual(r.frame,r.pet)}
 }
 if(baseline)assert.ok(!results[0].stable&&results[0].bufferResets>0,'original geometry and real buffer resets should reproduce');
 if(!baseline){
  const check=(name,value)=>{assert.ok(value,name);interactionChecks.push(name)},ui=page.frameLocator('iframe');
  await page.setViewportSize({width:1280,height:720});await page.evaluate(()=>setCase({screen:[0,0,1280,720],width:360,anchor:[990,650],open:false,mode:'half'}));
  await ui.locator('#open').click();await page.evaluate(()=>settled());await ui.locator('#text').fill('保留这行中文');await page.keyboard.press('Shift+Enter');await page.keyboard.type('draft');
  await ui.locator('#text').dispatchEvent('compositionstart',{data:'选字'});await ui.locator('#text').dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
  check('IME does not send from shifted viewport',await page.evaluate(()=>child().fixtureWire.length===0));await ui.locator('#text').dispatchEvent('compositionend');
  await ui.locator('#close').click();await page.waitForTimeout(240);await page.evaluate(()=>settled());await ui.locator('#open').click();await page.evaluate(()=>settled());
  check('hit-tested close/reopen retains multiline draft',await ui.locator('#text').inputValue()==='保留这行中文\ndraft');
  await ui.locator('#send').click();check('offset send control delivers exact text once',await page.evaluate(()=>child().fixtureWire.filter(x=>x.message.command?.type==='submit_text').length===1));
  await ui.locator('#view-full').click();await page.evaluate(()=>settled());check('display switch hit target stays aligned',await ui.locator('#view-full').getAttribute('aria-pressed')==='true');
  await page.emulateMedia({reducedMotion:'reduce'});await ui.locator('#close').click();await page.waitForTimeout(50);await page.evaluate(()=>settled());
  check('reduced motion closes back to pet native hit area',await page.evaluate(()=>JSON.stringify(lastLayout.frame)===JSON.stringify(lastLayout.pet)));
  await page.evaluate(()=>{child().petBridge.connectionChanged({generation:1,state:'connecting'});child().petBridge.receive({channel:'backend_ready',bridgeVersion:'0.2.0',characterId:'companion',sessionId:'stability'},1);child().petBridge.hotkeyConfig('Space');child().fixtureWire.length=0;child().document.body.focus()});
  await ui.locator('#open').focus();await page.keyboard.down('Space');await page.keyboard.up('Space');
  check('focused PTT routing survives viewport offset',await page.evaluate(()=>JSON.stringify(child().fixtureWire.map(x=>x.message.command?.type))===JSON.stringify(['start_voice','cancel'])));
  check('no viewport focus scrolling',await page.evaluate(()=>child().scrollX===0&&child().scrollY===0));
 }
}finally{await context.close();const video=await page.video().path();await browser.close();await fixture.close();await writeFile(resolve(out,baseline?'before-browser.json':'after-browser.json'),JSON.stringify({baseline,video,results,interactionChecks},null,2)+'\n');console.log(JSON.stringify(results.map(x=>({input:x.input,stable:x.stable,bufferResets:x.bufferResets,draws:x.draws,emptyDraws:x.emptyDraws}))));}
