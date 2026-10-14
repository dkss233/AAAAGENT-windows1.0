// Run with PLAYWRIGHT_MODULE pointing at an existing local playwright/index.mjs.
import {fixture} from './feedback-fixture.mjs';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const baseline=process.argv.includes('--baseline'),out=resolve('../../artifacts/W1/companion-feedback-01'),report={baseline,checks:[]};
const server=await fixture(),browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:baseline?380:500,height:baseline?716:916},deviceScaleFactor:1});
try {
 await page.goto(server.url);await page.waitForFunction(()=>window.fixtureReady&&fixtureReports.some(x=>x.type==='model-loaded'));
 if(!baseline)await page.evaluate(()=>fixtureConfigure({drawerHeight:540}));
 await page.locator('#open').click();
 await page.evaluate(()=>fixtureReply('这一小段终于弹顺了，值得开心一下。先歇一会儿，想继续聊琴还是说说今天的心情？'.repeat(12)));
 await page.locator('#text').fill('今天有很多话想说，也希望能看清完整的回复。');
 await page.waitForTimeout(230);
 report.layout=await page.evaluate(()=>Object.fromEntries(['drawer','reply','form','text','send','voice','hotkey-settings'].map(id=>{const n=document.getElementById(id),r=n.getBoundingClientRect();return[id,{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight}]})));
 await page.screenshot({path:resolve(out,baseline?'before-panel.png':'after-panel.png')});
 await page.locator('#close').click();await page.waitForTimeout(230);await page.keyboard.press('Space');
 report.afterCloseSpace=await page.evaluate(()=>({active:document.activeElement.id,panelHidden:document.getElementById('drawer').hidden,focusVisible:[...document.querySelectorAll(':focus-visible')].map(n=>({id:n.id,outline:getComputedStyle(n).outline}))}));
 // The transparent model hit area retained pointer focus in the previous shell.
 await page.locator('#character').click({position:{x:150,y:100}});await page.locator('#close').click();await page.waitForTimeout(230);await page.keyboard.press('Space');
 report.afterModelCloseSpace=await page.evaluate(()=>({active:document.activeElement.id,focusVisible:[...document.querySelectorAll(':focus-visible')].map(n=>({id:n.id,outline:getComputedStyle(n).outline}))}));
 await page.screenshot({path:resolve(out,baseline?'before-focus.png':'after-focus.png')});
 report.model=await page.evaluate(()=>fixtureReports.find(x=>x.type==='model-loaded'));
 if(!baseline){
  const check=(name,result)=>{assert.ok(result,name);report.checks.push({name,passed:true})};
  check('default reading area is at least 260px',report.layout.reply.height>=260);
  check('send button fits entirely inside composer',report.layout.send.right<=report.layout.form.right&&report.layout.send.bottom<=report.layout.form.bottom);
  check('close plus unbound Space remains collapsed without a giant model focus target',report.afterCloseSpace.panelHidden&&await page.locator('#character').evaluate(n=>n.tabIndex===-1));
  await page.locator('#model-resize').focus();await page.keyboard.press('Space');
  check('hidden resize handle stays transparent under keyboard focus and Space',await page.locator('#model-resize').evaluate(n=>{const c=getComputedStyle(n);return c.outlineStyle==='none'&&c.backgroundColor==='rgba(0, 0, 0, 0)'&&document.getElementById('drawer').hidden}));
  await page.keyboard.press('Tab');
  check('Tab reaches visible chat button with keyboard focus indicator',await page.locator('#open').evaluate(n=>n===document.activeElement&&n.matches(':focus-visible')&&getComputedStyle(n).outlineStyle!=='none'));
  await page.keyboard.press('Space');await page.waitForTimeout(240);
  check('visible chat button remains keyboard operable',await page.locator('#drawer').isVisible());
  await page.locator('#close').click();await page.waitForTimeout(240);
  await page.evaluate(()=>{fixtureWire.length=0;petBridge.hotkeyConfig('Space')});
  await page.keyboard.down('Space');await page.keyboard.up('Space');
  check('collapsed focused Space PTT starts and early release cancels exactly once',await page.evaluate(()=>JSON.stringify(fixtureWire.map(x=>x.message.command?.type))===JSON.stringify(['start_voice','cancel'])));
  await page.evaluate(()=>petBridge.hotkeyConfig(null));
  await page.evaluate(()=>{document.getElementById('open').click();document.getElementById('close').click()});await page.waitForTimeout(250);
  check('rapid open/close invalidates delayed textarea focus',await page.evaluate(()=>document.getElementById('drawer').hidden&&document.activeElement.id!=='text'));
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#open').click();
  check('reduced motion opens with no animation',await page.evaluate(()=>document.getElementById('drawer').getAnimations().length===0));
  await page.locator('#text').fill('第一行');await page.keyboard.press('Shift+Enter');await page.keyboard.type('second line');
  check('Shift+Enter retains multiline draft',await page.locator('#text').inputValue()==='第一行\nsecond line');
  await page.evaluate(()=>{fixtureWire.length=0;const n=document.getElementById('text');n.dispatchEvent(new CompositionEvent('compositionstart',{data:'选字'}));n.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true,cancelable:true}));});
  check('IME confirmation does not submit draft',await page.evaluate(()=>fixtureWire.length===0));
  await page.evaluate(()=>document.getElementById('text').dispatchEvent(new CompositionEvent('compositionend')));
  await page.locator('#close').click();await page.locator('#open').click();
  check('collapse/reopen retains multiline draft',await page.locator('#text').inputValue()==='第一行\nsecond line');
  await page.waitForFunction(()=>document.activeElement.id==='text');
  await page.keyboard.press('Enter');
  check('Enter submits full multiline text once',await page.evaluate(()=>fixtureWire.length===1&&fixtureWire[0].message.command.text==='第一行\nsecond line'));
  await page.evaluate(()=>fixtureReply('长回复测试。'.repeat(100)));
  await page.locator('#reply').evaluate(n=>n.scrollTop=0);await page.evaluate(()=>fixtureReply('另一条正常回复。'));
  check('new status/reply does not force a reader away from earlier content',await page.locator('#reply').evaluate(n=>n.scrollTop===0&&n.scrollHeight>n.clientHeight));
  await page.locator('#reply').evaluate(n=>n.scrollTop=n.scrollHeight);
  check('long Chinese response is fully reachable at the bottom',await page.locator('#reply').evaluate(n=>n.scrollHeight-n.scrollTop-n.clientHeight<2));
  report.sizes=[];
  for(const [sw,sh,preferred] of [[1512,945,220],[1512,945,720],[800,560,360],[320,560,360],[320,300,360]]){
   const dh=Math.min(540,Math.max(0,sh-Math.min(170,sh*.25))),mw=Math.max(1,Math.min(preferred,Math.max(1,sw-20),Math.max(1,sh-dh-36)/(340/360))),mh=mw*340/360;
   const ww=Math.min(sw,Math.max(mw+20,500)),wh=Math.min(sh,mh+36+dh);
   await page.setViewportSize({width:Math.ceil(ww),height:Math.ceil(wh)});await page.evaluate(c=>fixtureConfigure(c),{drawerHeight:dh,modelWidth:mw,modelHeight:mh,preferredWidth:preferred});
   await page.locator('#text').fill('多行输入会自然长高。\n第二行也应该完整显示。\n第三行。');
   const size=await page.evaluate(()=>{const d=document.getElementById('drawer'),r=d.getBoundingClientRect(),ids=['form','text','send','voice','hotkey-settings'];return {width:innerWidth,height:innerHeight,drawerBottom:r.bottom,drawerScroll:d.scrollHeight>d.clientHeight,controls:ids.map(id=>{const n=document.getElementById(id),b=n.getBoundingClientRect();return{id,left:b.left,right:b.right,width:b.width}})}});
   check('screen fit '+sw+'x'+sh+' model '+preferred,size.drawerBottom<=wh+1&&size.controls.every(c=>c.left>=0&&c.right<=ww+1));report.sizes.push({screen:[sw,sh],preferred,...size});
   if(sw===320&&sh===560)await page.screenshot({path:resolve(out,'after-narrow.png')});
  }
  check('real supplied Cubism model still loads',report.model.parameters===244&&report.model.expressions===36);
 }
} finally {await browser.close();await server.close();await writeFile(resolve(out,baseline?'before-browser.json':'after-browser.json'),JSON.stringify(report,null,2)+'\n');}
