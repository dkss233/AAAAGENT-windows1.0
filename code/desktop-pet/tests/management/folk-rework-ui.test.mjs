// Bounded rework evidence: synthetic HTTP, actual Chromium/WebKit; no installed app or providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMemoryDynamicsFixture} from './memory-dynamics-fixture.mjs';
const engines=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const capture=process.env.MANAGEMENT_UI_CAPTURE!=='0';
const output=resolve(process.env.MANAGEMENT_UI_OUTPUT);await mkdir(output,{recursive:true});
for(const engine of ['chromium','webkit'])test(engine+' reading position, focus, motion and hidden scrollbars',async()=>{
 const fixture=await createMemoryDynamicsFixture();
 fixture.state.items[0].record.text=Array.from({length:35},(_,i)=>`合成阅读段落 ${i+1}：周末去公园拍照，记录光线与植物。这里只验证长内容滚动，不连接任何真实数据。`).join('\n');
 const browser=await engines[engine].launch({headless:true});
 const context=await browser.newContext({viewport:{width:1360,height:1000},locale:'zh-CN',recordVideo:capture&&!process.env.MANAGEMENT_UI_STYLE_ONLY&&engine==='chromium'?{dir:output,size:{width:1360,height:1000}}:undefined});
 const page=await context.newPage();page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const evidence={engine,version:browser.version(),synthetic:true,providerCalls:0,checks:[],screenshots:[]};
 const settled=()=>page.waitForTimeout(250);
 const refresh=async()=>{await page.evaluate(()=>document.querySelector('#refresh').click());await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);await page.waitForTimeout(350);};
 try{
 await page.goto(fixture.url);await page.locator('#nav-memory').click();await page.locator('[data-md-record="memory-missing"]').click();await settled();
 const list=page.locator('[data-scroll-key="memory-rows"]'),body=page.locator('[data-scroll-key="content-memory-missing"]');
 if(process.env.MANAGEMENT_UI_STYLE_ONLY){
   await page.setViewportSize({width:360,height:900});await settled();
   for(const [name,loc] of [['list',list],['text',body]]){
     await page.keyboard.press('Tab');await loc.focus();await page.keyboard.press('ArrowDown');await settled();const ring=await loc.evaluate(n=>({color:getComputedStyle(n).outlineColor,width:getComputedStyle(n).outlineWidth,style:getComputedStyle(n).outlineStyle}));assert.deepEqual(ring,{color:'rgb(139, 128, 102)',width:'1px',style:'solid'});
     await page.screenshot({path:resolve(output,engine+'-focus-'+name+'-meter.png'),fullPage:true});evidence.screenshots.push(engine+'-focus-'+name+'-meter.png');
   }
   assert.equal(await page.locator('.md-meter meter').first().evaluate(n=>getComputedStyle(n).appearance),'none');
   evidence.checks.push('theme 1px visible keyboard focus on list and text; meter appearance none, actual narrow screenshots for visual verification');return;
 }
 if(capture)await page.screenshot({path:resolve(output,engine+'-memory-long.png'),fullPage:true});evidence.screenshots.push(engine+'-memory-long.png');
 // Real pointer/wheel and keyboard input, with classic-scrollbar CSS checked in both engines.
 await list.hover();await page.mouse.wheel(0,340);await settled();assert.ok(await list.evaluate(n=>n.scrollTop)>100);
 await list.focus();const before=await list.evaluate(n=>n.scrollTop);await page.keyboard.press('PageDown');await settled();assert.ok(await list.evaluate(n=>n.scrollTop)>before);
 const listPosition=await list.evaluate(n=>n.scrollTop),windowPosition=await page.evaluate(()=>scrollY);await refresh();assert.equal(await page.evaluate(()=>scrollY),windowPosition);assert.equal(await list.evaluate(n=>n.scrollTop),listPosition);assert.equal(await list.evaluate(n=>n===document.activeElement),true);
 await page.keyboard.press('PageUp');await settled();assert.ok(await list.evaluate(n=>n.scrollTop)<listPosition);evidence.checks.push('wheel + keyboard; list focus/position survives refresh and continues scrolling');
 await body.focus();await page.keyboard.press('PageDown');await settled();const bodyPosition=await body.evaluate(n=>n.scrollTop);assert.ok(bodyPosition>0);await refresh();assert.equal(await body.evaluate(n=>n.scrollTop),bodyPosition);assert.equal(await body.evaluate(n=>n===document.activeElement),true);
 await page.keyboard.press('PageDown');await settled();assert.ok(await body.evaluate(n=>n.scrollTop)>bodyPosition);evidence.checks.push('long text focus/position survives refresh and continues keyboard scrolling');
 for(const loc of [list,body]){const size=await loc.evaluate(n=>({scroll:n.scrollHeight,client:n.clientHeight,gutter:n.offsetWidth-n.clientWidth,bar:getComputedStyle(n,'::-webkit-scrollbar').display}));assert.ok(size.scroll>size.client);assert.equal(size.gutter,0);assert.equal(size.bar,'none');}
 const disclosure=page.locator('.memory-metadata').first();await disclosure.locator('summary').click();const motion=await disclosure.locator('.disclosure-body').evaluate(n=>n.getAnimations().length);assert.ok(motion>0);await settled();await refresh();assert.equal(await disclosure.evaluate(n=>n.open),true);assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
 const reason=page.locator('#md-reason');await reason.fill('保留的合成草稿');await reason.evaluate(n=>n.setSelectionRange(2,5));await refresh();assert.equal(await reason.inputValue(),'保留的合成草稿');assert.deepEqual(await reason.evaluate(n=>[n===document.activeElement,n.selectionStart,n.selectionEnd]),[true,2,5]);assert.equal(await disclosure.evaluate(n=>n.open),true);assert.equal(await page.evaluate(()=>document.getAnimations().length),0);evidence.checks.push('draft, selection, focus and disclosure survive redraw; refresh starts no entrance motion');
 // Record visible hover, press, selection, disclosure and navigation in the actual product UI.
 await list.evaluate(n=>n.scrollTop=0);await page.locator('[data-md-record="memory-observed"]').hover();await page.waitForTimeout(300);await page.mouse.down();await page.waitForTimeout(140);await page.mouse.up();await settled();
 await page.locator('.memory-metadata').first().locator('summary').click();await settled();await page.locator('.memory-metadata').first().locator('summary').click();await settled();
 await page.locator('#memory-policy').click();await page.locator('#md-policy-refresh:not([disabled])').waitFor();await page.locator('#md-preview-run').hover();await page.waitForTimeout(400);await page.locator('#memory-dynamics').click();await settled();
 await page.evaluate(()=>scrollTo(0,0));if(capture)await page.screenshot({path:resolve(output,engine+'-memory-wide.png'),fullPage:true});evidence.screenshots.push(engine+'-memory-wide.png');
 await page.setViewportSize({width:360,height:900});await page.locator('[data-md-record="memory-missing"]').click();await settled();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(capture)await page.screenshot({path:resolve(output,engine+'-memory-narrow.png'),fullPage:true});evidence.screenshots.push(engine+'-memory-narrow.png');
 await page.evaluate(()=>scrollTo(0,0));await page.mouse.click(3,400);await page.mouse.wheel(0,260);await settled();const rootPosition=await page.evaluate(()=>scrollY);assert.ok(rootPosition>0);await page.keyboard.press('PageDown');await settled();assert.ok(await page.evaluate(()=>scrollY)>rootPosition);
 const root=await page.evaluate(()=>({gutter:innerWidth-document.documentElement.clientWidth,bar:getComputedStyle(document.documentElement,'::-webkit-scrollbar').display}));assert.deepEqual(root,{gutter:0,bar:'none'});evidence.checks.push('narrow page root wheel + keyboard scroll; global gutter zero and scrollbar hidden');
 await page.emulateMedia({reducedMotion:'reduce'});await page.locator('.memory-metadata').first().locator('summary').click();assert.equal(await page.evaluate(()=>document.getAnimations().length),0);await page.locator('#memory-policy').click();assert.equal(await page.evaluate(()=>document.getAnimations().length),0);evidence.checks.push('360px fits; reduced motion suppresses transitions and Web Animations');
 assert.deepEqual(errors,[]);assert.equal(fixture.state.writes.length,0);
 }finally{const video=page.video();await context.close();if(video){await video.saveAs(resolve(output,'chromium-interaction.webm'));await video.delete();evidence.video='chromium-interaction.webm';}await browser.close();await fixture.close();await writeFile(resolve(output,engine+'-interaction-evidence.json'),JSON.stringify(evidence,null,2)+'\n');}
});
