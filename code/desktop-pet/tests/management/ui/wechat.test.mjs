import {choose,choiceValue} from '../choice-helper.mjs';
// Production UI, isolated HTTP snapshots only. Never connect to WeChat or save QR/code data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMemoryDynamicsFixture} from '../memory-dynamics-fixture.mjs';
const {webkit}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const output=resolve(process.env.MANAGEMENT_UI_OUTPUT);await mkdir(output,{recursive:true});
test('WeChat management: synthetic HTTP lifecycle and narrow production UI',async t=>{
 const fixture=await createMemoryDynamicsFixture(),browser=await webkit.launch({headless:true}),context=await browser.newContext({viewport:{width:380,height:900},reducedMotion:'reduce'}),page=await context.newPage();
 let snapshot={apiVersion:'0.2',replyMode:'follow_input',revision:1,status:'disconnected',enabled:false,boundUser:null,detail:'',qr:null,lastInputAt:null,lastOutputAt:null,lastDelivery:'none'};
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
 const qr=()=>({imageDataUrl:png,expiresAt:new Date(Date.now()+60000).toISOString()});
 const update=patch=>snapshot={...snapshot,revision:snapshot.revision+1,...patch};
 let gets=0,posts=0,mode='',delay=0,verified=false,external=0;const errors=[],actions=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==new URL(fixture.url).origin){external++;return route.abort();}return route.continue();});
 await page.route('**/api/wechat',async route=>{
  const req=route.request();assert.equal(req.headers().authorization,'Bearer memory-dynamics-synthetic-session');assert.ok(!req.headers()['cache-control']?.includes('max-age'));
  const reply=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(req.method()==='GET'){
   gets++;const data=structuredClone(snapshot);if(delay)await new Promise(r=>setTimeout(r,delay));
   if(mode==='offline')return reply(503,{error:{message:'synthetic private error must not render'}});
   if(mode==='auth')return reply(401,{error:{message:'synthetic private auth must not render'}});
   if(mode==='malformed')return reply(200,{...data,revision:'bad'});
   return reply(200,data);
  }
  posts++;const body=req.postDataJSON();actions.push({action:body.action,expectedRevision:body.expectedRevision,...(body.action==='set_reply_mode'?{replyMode:body.replyMode}:{})});
  if(mode==='conflict'){update(body.action==='set_reply_mode'?{replyMode:'text'}:{status:'paused',enabled:false,qr:null});return reply(409,{error:{message:'conflict'}});}
  assert.equal(body.expectedRevision,snapshot.revision);
  if(body.action==='set_reply_mode')update({replyMode:body.replyMode});
  if(body.action==='login')update({status:'waiting_scan',enabled:true,qr:qr()});
  if(body.action==='verify'){verified=body.code==='synthetic-only-code';update({status:'connected',enabled:true,qr:null,boundUser:{userId:'synthetic-user',botId:'synthetic-bot'}});}
  if(body.action==='stop')update({status:'paused',enabled:false,qr:null});
  if(body.action==='start')update({status:'connected',enabled:true});
  if(body.action==='disconnect')update({status:'disconnected',enabled:false,boundUser:null,qr:null});
  if(delay)await new Promise(r=>setTimeout(r,delay));
  if(mode==='drop')return route.abort();
  return reply(200,snapshot);
 });
 const click=id=>page.locator('#'+id).click();
 const status=text=>page.waitForFunction(text=>document.querySelector('#wechat-status')?.innerText.includes(text),text);
 const ready=()=>page.waitForFunction(()=>document.querySelector('#wechat-refresh')&&!document.querySelector('#wechat-refresh').disabled);
 const refresh=async()=>{await ready();await click('wechat-refresh');await page.waitForFunction(()=>document.querySelector('#session')||!document.querySelector('#wechat-refresh')?.disabled);};
 const bodyText=()=>page.locator('body').innerText();
 try{
  await page.goto(fixture.url);await page.waitForSelector('#nav-wechat');await page.waitForFunction(()=>document.body.innerText.includes('管理服务已连接'));
  await t.test('lazy visible polling and explicit QR login, no external renderer',async()=>{
   assert.equal(gets,0);await click('nav-wechat');await status('未连接');assert.equal(gets,1);assert.equal(posts,0);
   await click('wechat-login');await status('等待扫码');await page.waitForSelector('#wechat-qr');assert.equal(await page.locator('#wechat-qr').getAttribute('src'),png);assert.deepEqual(actions[0],{action:'login',expectedRevision:1});
   const before=gets;await page.waitForTimeout(2150);assert.ok(gets>before);assert.ok(gets<=before+2);
   update({status:'scanned'});await refresh();await status('已扫码');assert.ok((await bodyText()).includes('希望聊天或发指令的微信扫码'));checks.push('lazy page GET; visible 2s poll; versioned explicit login; server data image only; scanned status');
  });
  await t.test('local expiry and refresh, starting state, verification clears on submit',async()=>{
   update({status:'waiting_scan',qr:{...qr(),expiresAt:new Date(Date.now()-1000).toISOString()}});await refresh();await status('二维码已过期');assert.equal(await page.locator('#wechat-qr').count(),0);
   await click('wechat-login');await status('等待扫码');assert.equal(actions.at(-1).action,'login');
   update({status:'starting',qr:null});await refresh();await status('正在连接');
   update({status:'need_verification'});await refresh();await page.waitForSelector('#wechat-code');assert.equal(await page.locator('#wechat-code').getAttribute('type'),'password');
   await page.locator('#wechat-code').fill('synthetic-only-code');await page.locator('#wechat-code').focus();await page.evaluate(()=>document.querySelector('#wechat-refresh').click());await ready();
   assert.equal(await page.locator('#wechat-code').inputValue(),'synthetic-only-code');assert.ok(await page.locator('#wechat-code').evaluate(n=>n===document.activeElement));
   delay=180;await page.evaluate(()=>{document.querySelector('#wechat-verify').click();document.querySelector('#wechat-verify')?.click()});assert.equal(await page.locator('#wechat-code').inputValue(),'');await status('已连接');await ready();delay=0;
   assert.ok(verified);assert.equal(actions.filter(x=>x.action==='verify').length,1);assert.equal(await page.locator('#wechat-qr,#wechat-code').count(),0);checks.push('expired image removed; manual refresh; starting; password input survives poll focus; code cleared before one verify POST');
  });
  await t.test('bound user and honest delivery state, stop/start/disconnect actions',async()=>{
   update({lastDelivery:'accepted',lastInputAt:'2026-09-15T04:00:00Z',lastOutputAt:'2026-09-15T04:00:01Z'});await refresh();assert.ok((await bodyText()).includes('微信服务已接受，尚未确认用户收到'));assert.ok((await bodyText()).includes('synthetic-user'));
   await click('wechat-stop');await status('已暂停');await ready();await click('wechat-start');await status('已连接');await ready();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await click('wechat-disconnect');await status('未连接');await ready();assert.equal(await page.locator('.wechat-account:not(#wechat-reply-settings)').count(),0);assert.deepEqual(actions.slice(-3).map(x=>x.action),['stop','start','disconnect']);checks.push('bound user and accepted != received; stop/start/disconnect; 380px no horizontal overflow; screenshot contains no QR/code');
  });
  await t.test('older revision cannot revive connection; conflict re-reads without replay',async()=>{
   const latest=structuredClone(snapshot);snapshot={...snapshot,revision:1,status:'waiting_scan',qr:qr()};await refresh();await status('未连接');assert.equal(await page.locator('#wechat-qr').count(),0);snapshot=latest;
   mode='conflict';const n=posts;await click('wechat-login');await status('已暂停');await ready();assert.equal(posts,n+1);mode='';assert.equal(await page.locator('#wechat-qr').count(),0);
   mode='drop';await click('wechat-disconnect');await status('未连接');await ready();mode='';assert.equal(posts,n+2);checks.push('older revision ignored; conflict GET without automatic POST; lost action response reconciles state without resend');
  });
  await t.test('hidden and navigated pages stop polling and discard QR/code, delayed GET ignored',async()=>{
   await click('wechat-login');await status('等待扫码');await ready();await click('nav-overview');const n=gets;await page.waitForTimeout(2150);assert.equal(gets,n);assert.equal(await page.locator('#wechat-qr').count(),0);
   update({status:'need_verification',qr:null});await click('nav-wechat');await page.waitForSelector('#wechat-code');await page.locator('#wechat-code').fill('discard-on-hidden');
   await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))});const hiddenGets=gets;await page.waitForTimeout(2150);assert.equal(gets,hiddenGets);assert.equal(await page.locator('#wechat-code').count(),0);
   await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))});await page.waitForSelector('#wechat-code');assert.equal(await page.locator('#wechat-code').inputValue(),'');
   delay=200;await click('wechat-refresh');await click('nav-overview');await page.waitForTimeout(250);delay=0;assert.equal(await page.locator('#wechat-code,#wechat-qr').count(),0);checks.push('navigation/hidden stops polling and clears secrets; late read cannot restore hidden UI');
  });
  await t.test('errors, unsafe image, auth and instance changes fail closed and recover',async()=>{
   update({status:'error',qr:null});await click('nav-wechat');await status('连接遇到问题');await ready();
   mode='offline';await refresh();assert.ok((await bodyText()).includes('暂时无法读取微信状态'));assert.ok(await page.locator('#wechat-login').isDisabled());assert.ok(!(await bodyText()).includes('synthetic private'));
   mode='malformed';await refresh();assert.ok(await page.locator('#wechat-login').isDisabled());mode='';
   const saved=structuredClone(snapshot);snapshot={...snapshot,qr:{imageDataUrl:'https://example.invalid/qr',expiresAt:new Date(Date.now()+60000).toISOString()}};await refresh();assert.equal(await page.locator('#wechat-qr').count(),0);snapshot=saved;await refresh();
   mode='auth';await refresh();await page.waitForSelector('#session');assert.equal(await page.locator('#wechat-code,#wechat-qr').count(),0);mode='';
   snapshot={...snapshot,revision:0,status:'disconnected'};fixture.state.controls.instanceId='wechat-new-synthetic-instance';await page.locator('#session').fill('memory-dynamics-synthetic-session');await page.locator('#session').evaluate(n=>n.form.requestSubmit());await status('未连接');await ready();
   await click('wechat-login');await status('等待扫码');assert.equal(actions.at(-1).expectedRevision,0);await click('nav-overview');
   const stored=await page.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)].join(' '));assert.ok(!stored.includes('data:image'));assert.ok(!stored.includes('synthetic-only-code'));assert.ok(!stored.includes('discard-on-hidden'));assert.ok(!stored.includes('synthetic-user'));checks.push('safe error text and disabled writes; malformed/external QR rejected; expired auth clears secrets; new instance resets revision; no WeChat secret storage');
  });
  await t.test('reply policy persists via snapshots, preserves drafts and never reconnects or scans',async()=>{
   update({status:'connected',enabled:true,boundUser:{userId:'synthetic-user',botId:'synthetic-bot'},qr:null});await click('nav-wechat');await ready();
   const select=page.locator('#wechat-reply-mode'),saved=page.locator('#wechat-reply-current'),count=posts;
   assert.equal(await choiceValue(select),'follow_input');await select.click();assert.deepEqual(await page.locator('[role=option]>.choice-value,[role=option]>span:first-child').allTextContents(),['跟随输入','始终文字','始终语音']);await select.press('Escape');
   await choose(page,'#wechat-reply-mode','voice');await select.focus();await page.evaluate(()=>document.querySelector('#wechat-refresh').click());await ready();assert.equal(await choiceValue(select),'voice');assert.ok(await select.evaluate(n=>n===document.activeElement));assert.match(await saved.innerText(),/跟随输入/);assert.equal(posts,count);
   const expected=snapshot.revision;delay=150;await page.evaluate(()=>{document.querySelector('#wechat-reply-save').click();document.querySelector('#wechat-reply-save').click()});assert.match(await saved.innerText(),/跟随输入/);await ready();delay=0;assert.deepEqual(actions.at(-1),{action:'set_reply_mode',expectedRevision:expected,replyMode:'voice'});assert.equal(posts,count+1);assert.match(await saved.innerText(),/始终语音/);
   await click('nav-overview');await page.reload();await page.waitForFunction(()=>document.body.innerText.includes('管理服务已连接'));await click('nav-wechat');await ready();assert.equal(await choiceValue(select),'voice');
   await choose(page,'#wechat-reply-mode','text');await click('wechat-reply-save');await ready();assert.match(await saved.innerText(),/始终文字/);await choose(page,'#wechat-reply-mode','follow_input');await click('wechat-reply-save');await ready();
   await choose(page,'#wechat-reply-mode','voice');mode='conflict';await click('wechat-reply-save');await ready();mode='';assert.equal(await choiceValue(select),'voice');assert.match(await saved.innerText(),/始终文字/);assert.ok(await page.locator('#wechat-reply-save').isDisabled());await click('wechat-reply-review');await click('wechat-reply-save');await ready();
   const latest=structuredClone(snapshot);snapshot={...snapshot,revision:0,replyMode:'follow_input'};await refresh();assert.match(await saved.innerText(),/始终语音/);snapshot=latest;
   await choose(page,'#wechat-reply-mode','text');mode='offline';await refresh();assert.equal(await choiceValue(select),'text');assert.ok(await page.locator('#wechat-reply-save').isDisabled());mode='';await refresh();await click('wechat-reply-save');await ready();
   update({status:'waiting_scan',qr:qr()});await refresh();const image=await page.locator('#wechat-qr').getAttribute('src');await choose(page,'#wechat-reply-mode','voice');await click('wechat-reply-save');await ready();assert.equal(await page.locator('#wechat-qr').getAttribute('src'),image);
   update({status:'need_verification',qr:null});await refresh();await page.locator('#wechat-code').fill('policy-keeps-code');await choose(page,'#wechat-reply-mode','follow_input');await click('wechat-reply-save');await ready();assert.equal(await page.locator('#wechat-code').inputValue(),'policy-keeps-code');
   update({status:'connected',qr:null});await refresh();assert.ok(actions.slice(-1*(posts-count)).every(a=>a.action==='set_reply_mode'));assert.equal(snapshot.boundUser.userId,'synthetic-user');
   await page.locator('#wechat-reply-settings').screenshot({path:resolve(output,'webkit-reply-policy-380.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   checks.push('API0.2 three modes; exact versioned save; draft/focus survives poll; response-only saved state; reload/conflict/stale/offline; setting never reconnects/scans and preserves QR/code; one380 policy screenshot');
  });
  assert.deepEqual(errors,[]);assert.equal(external,0);assert.equal(fixture.state.writes.length,0);
  // A filtered run may skip all subtests; it must not replace full-run evidence.
  if(checks.length!==7)return;
  await writeFile(resolve(output,'evidence.json'),JSON.stringify({engine:'webkit',version:browser.version(),width:380,checks,gets,posts,actions,errors,externalRequests:external,realWeChatCalls:0,modelCalls:0,deviceCalls:0,realTaskSends:0,boundary:'Production UI with synthetic HTTP states; one reply-policy screenshot, no QR or verification code captured.'},null,2));
 }finally{await context.close();await browser.close();await fixture.close();}
});
