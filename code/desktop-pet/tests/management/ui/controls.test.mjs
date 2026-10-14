// Real production UI, isolated synthetic HTTP. No business DB, models, devices or WeChat.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMemoryDynamicsFixture} from '../memory-dynamics-fixture.mjs';
import {choose,choiceValue} from '../choice-helper.mjs';
const engines=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const output=resolve(process.env.MANAGEMENT_UI_OUTPUT);await mkdir(output,{recursive:true});
for(const engine of ['webkit','chromium'])test(engine+' shared controls survive refresh and preserve action scope',async t=>{
 const fixture=await createMemoryDynamicsFixture(),browser=await engines[engine].launch({headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(5000);
 const errors=[],checks=[],shots=[],writes=[];let external=0,gets=0,paused=false;
 let wechat={apiVersion:'0.2',replyMode:'follow_input',revision:1,status:'connected',enabled:true,boundUser:null,detail:'',qr:null,lastInputAt:null,lastOutputAt:null,lastDelivery:'none'};
 let rows=[{id:'synthetic-pending',intent:'forget',status:'failed',preview:'合成请求：仅用于确认框验证',createdAt:'2026-09-15T00:00:00Z'}],busy=false;
 page.on('pageerror',e=>errors.push(e.message));
 page.on('dialog',d=>{errors.push('Unexpected system dialog');void d.dismiss();});
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==new URL(fixture.url).origin){external++;return route.abort();}return route.continue();});
 await page.route('**/api/wechat',r=>{if(r.request().method()==='POST'){writes.push(r.request().postDataJSON());return r.fulfill({status:409,json:{error:{message:'synthetic conflict'}}});}gets++;return r.fulfill({status:paused?503:200,json:paused?{error:{message:'offline'}}:wechat});});
 await page.route('**/api/memory-pending**',r=>{if(r.request().method()==='POST')writes.push({path:new URL(r.request().url()).pathname,...r.request().postDataJSON()});return r.fulfill({json:{instanceId:fixture.state.controls.instanceId||'synthetic-memory-instance',requests:rows,busy}});});
 await page.route('**/api/tasks',r=>r.fulfill({json:{connection:{harness:'ready',codex:'compatible',preset:'ready'},requests:[]}}));
 await page.route('**/api/tasks/targets**',r=>r.fulfill({json:{items:[]}}));
 await page.route('**/api/projects**',r=>r.fulfill({json:{items:[],total:0,limit:20,offset:0}}));
 await page.route('**/api/presentation',r=>r.fulfill({json:{catalog:{modelId:'synthetic-no-assets',items:[{id:'synthetic-preset',label:'合成表情',category:'expression',source:'procedural',previewable:false,availability:'automatic'}]},policy:{revision:1,enabledIds:['synthetic-preset']}}}));
 await page.route('**/presentation-runtime/core.js',r=>r.fulfill({contentType:'text/javascript',body:'window.Live2DCubismCore={};'}));
 await page.route('**/presentation-preview.js',r=>r.fulfill({contentType:'text/javascript',body:'export async function createPresentationPreview(){return {resize(){},dispose(){}}}'}));
 await page.route('**/api/snapshot',async r=>{const response=await r.fetch(),s=await response.json();if(!s.runtime)return r.fulfill({response,json:s});
  s.settings.saved.providers.tts.voice=s.settings.effective.providers.tts.voice='synthetic-long-voice-identifier-'.repeat(6);
  s.adapters=[{id:'synthetic',label:'合成服务商',provider:'synthetic',slots:Object.keys(s.settings.saved.providers),status:'available',capabilities:{voice:true},models:['fixture-no-calls',...Array.from({length:25},(_,i)=>'synthetic-model-'+i)],endpoints:['https://example.invalid']}];
  return r.fulfill({response,json:s});});
 const click=id=>page.locator('#'+id).click();
 const refresh=async(id='refresh')=>{await page.evaluate(id=>document.getElementById(id).click(),id);await page.locator('#'+id+':not([disabled])').waitFor();};
 const ready=()=>page.locator('#wechat-refresh:not([disabled])').waitFor();
 const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const shot=async(name,selector)=>{const file=engine+'-'+name+'.png';await (selector?page.locator(selector):page).screenshot({path:resolve(output,file)});shots.push(file);};
 const check=async(name,fn)=>t.test(name,async()=>{await fn();checks.push(name);});
 try{
  await page.goto(fixture.url);await page.locator('#nav-wechat').waitFor();
  await check('pointer popup stays open through real poll; saved value, draft and active option are separate',async()=>{
   await click('nav-wechat');await ready();await choose(page,'#wechat-reply-mode','text');await click('wechat-reply-mode');
   await page.locator('[role=option][data-value=voice]').hover();const count=gets;
   await page.evaluate(()=>window.keptPopup=document.querySelector('[role=listbox]'));
   await page.waitForTimeout(2350);assert.ok(gets>count);
   assert.equal(await page.locator('#wechat-reply-mode').getAttribute('aria-expanded'),'true');
   assert.ok(await page.evaluate(()=>keptPopup===document.querySelector('[role=listbox]')));
   assert.equal(await page.locator('.choice-option.is-active').getAttribute('data-value'),'voice');
   assert.equal(await choiceValue(page.locator('#wechat-reply-mode')),'text');assert.match(await page.locator('#wechat-reply-current').innerText(),/跟随输入/);
   await shot('wechat-open-wide');await page.locator('[role=option][data-value=voice]').click();assert.equal(await choiceValue(page.locator('#wechat-reply-mode')),'voice');assert.equal(await page.locator('[role=listbox]').count(),0);assert.equal(writes.length,0);
  });
  await check('Escape, outside click, Tab and keyboard selection; offline and navigation clear popup',async()=>{
   await click('wechat-reply-mode');await page.locator('#wechat-reply-mode').press('Home');await page.locator('#wechat-reply-mode').press('Escape');assert.equal(await choiceValue(page.locator('#wechat-reply-mode')),'voice');
   await click('wechat-reply-mode');await page.locator('h1').click();assert.equal(await page.locator('[role=listbox]').count(),0);
   await click('wechat-reply-mode');await page.locator('#wechat-reply-mode').press('Tab');assert.equal(await page.locator('[role=listbox]').count(),0);
   await page.locator('#wechat-reply-mode').focus();await page.keyboard.press('Enter');await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await choiceValue(page.locator('#wechat-reply-mode')),'text');
   await click('wechat-reply-mode');paused=true;await refresh('wechat-refresh');assert.equal(await page.locator('[role=listbox]').count(),0);assert.equal(await choiceValue(page.locator('#wechat-reply-mode')),'text');paused=false;await refresh('wechat-refresh');
   await click('wechat-reply-mode');await click('nav-events');assert.equal(await page.locator('[role=listbox]').count(),0);await click('event-module');await page.keyboard.press('End');await page.keyboard.press('Enter');assert.equal(await choiceValue(page.locator('#event-module')),'retrieval');
  });
  await check('long model options retain highlight, scroll and typeahead; full IDs wrap and row buttons align',async()=>{
   await click('nav-models');await click('configure-tts');await click('model-tts');await page.keyboard.press('End');
   const before=await page.locator('[role=listbox]').evaluate(n=>n.scrollTop);assert.ok(before>0);await refresh();
   assert.equal(await page.locator('[role=listbox]').evaluate(n=>n.scrollTop),before);assert.equal(await page.locator('.is-active[role=option]').getAttribute('data-value'),'synthetic-model-24');
   await page.keyboard.press('Home');await page.keyboard.type('synthetic-model-2');assert.equal(await page.locator('.is-active[role=option]').getAttribute('data-value'),'synthetic-model-2');await page.keyboard.press('Escape');
   assert.ok(await page.locator('.primary-models>.card').evaluateAll(cards=>cards.every(c=>[...c.children].every(n=>n.getBoundingClientRect().right<=c.getBoundingClientRect().right))));
   const tops=await page.locator('.primary-models>.card').evaluateAll(cards=>cards.map(c=>({top:c.getBoundingClientRect().top,button:c.querySelector('button').getBoundingClientRect().bottom})));
   for(const c of tops)for(const d of tops)if(c.top===d.top)assert.equal(c.button,d.button);
   await page.evaluate(()=>scrollTo(0,0));await shot('models-wide');await noOverflow();
  });
  await check('memory controls, text draft/caret/scroll, confirmation cancel and frozen scope',async()=>{
   await click('nav-memory');await page.locator('#md-state').waitFor();await choose(page,'#md-state','all');await page.locator('#md-search:not([disabled])').waitFor();
   await click('memory-prompt');await page.locator('#prompt-text').waitFor();await page.locator('#prompt-text').fill('未保存的合成长草稿\n'.repeat(100));
   await page.locator('#prompt-text').evaluate(n=>{n.focus();n.setSelectionRange(8,15);n.scrollTop=120;});await refresh();
   assert.deepEqual(await page.locator('#prompt-text').evaluate(n=>[n.selectionStart,n.selectionEnd,n.scrollTop,n.value.length]),[8,15,120,1000]);
   await page.locator('[data-pending-retry]').click();await page.locator('#pending-memory-dialog[open]').waitFor();assert.equal(writes.length,0);await page.keyboard.press('Escape');assert.equal(await page.locator('#pending-memory-dialog').count(),0);assert.equal(await page.locator('[data-pending-retry]').evaluate(n=>n===document.activeElement),true);
   await page.locator('[data-pending-cancel]').click();await click('pending-memory-dialog-back');assert.equal(writes.length,0);
   await page.locator('[data-pending-retry]').click();await page.locator('#pending-memory-dialog-confirm').focus();await refresh();assert.equal(await page.locator('#pending-memory-dialog[open]').count(),1);assert.equal(await page.locator('#pending-memory-dialog-confirm').evaluate(n=>n===document.activeElement),true);
   rows=[{...rows[0],preview:'新内容不可用旧确认'}];await page.evaluate(()=>document.getElementById('pending-memory-refresh').click());await page.locator('#pending-memory-dialog').waitFor({state:'detached'});assert.equal(writes.length,0);
   await page.locator('[data-pending-retry]').click();fixture.state.controls.instanceId='synthetic-next';await refresh();assert.equal(await page.locator('#pending-memory-dialog').count(),0);assert.equal(writes.length,0);
   await click('pending-memory-refresh');await page.locator('[data-pending-cancel]').waitFor();await page.locator('[data-pending-cancel]').click();await shot('confirmation-wide');await click('pending-memory-dialog-confirm');await page.locator('#pending-memory-refresh:not([disabled])').waitFor();assert.deepEqual(writes,[{path:'/api/memory-pending/cancel',instanceId:'synthetic-next',id:'synthetic-pending'}]);
   await page.locator('[data-pending-retry]').click();await page.evaluate(()=>document.getElementById('nav-overview').click());await click('nav-memory');assert.equal(await page.locator('#pending-memory-dialog').count(),0);
  });
  await check('narrow page surfaces and popup bounds; reduced motion',async()=>{
   await page.setViewportSize({width:380,height:900});
   for(const id of ['overview','models','memory','projects','tasks','wechat','events','presentation']){await click('nav-'+id);await page.waitForTimeout(80);await noOverflow();}
   await page.locator('#enable-synthetic-preset').waitFor();assert.deepEqual(await page.locator('#enable-synthetic-preset').evaluate(n=>{const s=getComputedStyle(n);return [s.width,s.height,s.padding,n.checked]}),['16px','16px','0px',true]);
   await click('nav-wechat');await ready();await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await click('wechat-reply-mode');await page.locator('[role=option][data-value=text]').hover();await page.waitForTimeout(2200);await shot('wechat-open-380');
   assert.ok(await page.locator('[role=listbox]').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
   assert.equal(await page.locator('[role=listbox]').evaluate(n=>n.getAnimations().length),0);await page.keyboard.press('Escape');await click('nav-models');await shot('models-380');
  });
  // Dynamic catalog module probe reuses the real shared controls and render lifecycle.
  await check('removed or disabled options never commit stale values; page refresh keeps safe replacement',async()=>{
   await page.evaluate(async()=>{
    const d=await import('/dom.mjs');document.body.replaceChildren(d.el('main',{id:'probe'}));const root=document.getElementById('probe');window.commits=[];window.probeOptions=[{value:'a',label:'甲'},{value:'b',label:'乙'},{value:'c',label:'不可用',disabled:true}];
    window.redrawProbe=()=>{d.captureView(root);root.replaceChildren(d.select('合成选项','probe-choice','a',window.probeOptions,v=>commits.push(v)));d.restoreView(root,'probe');};redrawProbe();
   });
   await click('probe-choice');await page.keyboard.press('ArrowDown');await page.evaluate(()=>{probeOptions=[{value:'a',label:'甲'},{value:'b',label:'乙',disabled:true}];redrawProbe();});await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>commits),[]);
   await click('probe-choice');await page.evaluate(()=>{probeOptions=[];redrawProbe();});await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>commits),[]);await page.keyboard.press('Escape');
   await page.evaluate(async()=>{const d=await import('/dom.mjs'),root=document.getElementById('probe');window.redrawDialog=()=>{d.captureView(root);root.replaceChildren(d.el('dialog',{id:'probe-dialog'},d.select('弹窗内选项','dialog-choice','a',[{value:'a',label:'甲'},{value:'b',label:'乙'}],v=>commits.push(v))));d.restoreView(root,'probe-dialog');};redrawDialog();});
   await click('dialog-choice');await page.keyboard.press('ArrowDown');await page.evaluate(()=>redrawDialog());assert.equal(await page.locator('#probe-dialog [role=listbox]').count(),1);assert.equal(await page.locator('#dialog-choice').getAttribute('aria-expanded'),'true');await page.keyboard.press('Escape');assert.equal(await page.locator('[role=listbox]').count(),0);
  });
  assert.deepEqual(errors,[]);assert.equal(external,0);assert.equal(fixture.state.writes.length,0);
  assert.equal(checks.length,6);
  await writeFile(resolve(output,engine+'-controls.json'),JSON.stringify({checks,shots,engine,version:browser.version(),gets,writes,errors,external,realApiCalls:0,models:0,devices:0,boundary:'Production UI and synthetic HTTP. One synthetic pending cancel, no real settings or WeChat writes.'},null,2));
 }finally{await context.close();await browser.close();await fixture.close();}
});
