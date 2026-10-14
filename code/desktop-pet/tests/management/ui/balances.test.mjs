import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMemoryDynamicsFixture} from '../memory-dynamics-fixture.mjs';
const {webkit}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
test('balance cards, currencies, honest states, private form and late-response protection in actual UI',async t=>{
 const fixture=await createMemoryDynamicsFixture();t.after(()=>fixture.close());const browser=await webkit.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1100,height:900}});page.setDefaultTimeout(4000);
 const state={providers:[{provider:'aliyun',status:'unconfigured',configured:false,credentialRevision:0,rows:[],updatedAt:null,checkedAt:'2026-09-16T04:00:00Z',stale:false,message:null},{provider:'deepseek',status:'ready',configured:true,credentialRevision:0,rows:[{currency:'CNY',amount:'137.98'},{currency:'USD',amount:'3.21'}],updatedAt:'2026-09-16T04:00:00Z',checkedAt:'2026-09-16T04:00:00Z',stale:false,message:null}]};
 let snapshotCalls=0,refreshCalls=0,saves=0,delay=0,instance='one';const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/snapshot',async route=>{snapshotCalls++;const upstream=await route.fetch(),data=await upstream.json();data.runtime.instanceId=instance;data.balances=structuredClone(state);await route.fulfill({json:data});});
 await page.route('**/api/balances**',async route=>{const request=route.request(),url=new URL(request.url()),frozen=structuredClone(state);
  if(url.pathname.endsWith('/refresh')){refreshCalls++;if(delay)await new Promise(r=>setTimeout(r,delay));return route.fulfill({json:frozen});}
  if(url.pathname.endsWith('/aliyun-credentials')){saves++;await new Promise(r=>setTimeout(r,250));const body=request.postDataJSON();assert.equal(body.accessKeyId,'synthetic-id');assert.equal(body.accessKeySecret,'synthetic-secret');state.providers[0]={...state.providers[0],configured:true,credentialRevision:1,status:'ready',rows:[{currency:'CNY',amount:'-12.00',availableCredit:'80.00'}],updatedAt:'2026-09-16T04:01:00Z',checkedAt:'2026-09-16T04:01:00Z'};return route.fulfill({json:state});}
  return route.fulfill({json:state});
 });
 await page.goto(fixture.url);await page.waitForSelector('#balance-deepseek');assert.match(await page.locator('#balance-deepseek').innerText(),/137.98/);assert.match(await page.locator('#balance-deepseek').innerText(),/USD/);assert.match(await page.locator('#balance-aliyun').innerText(),/待配置/);assert.doesNotMatch(await page.locator('body').innerText(),/已记费用|费用记录|最短间隔/);
 for(let i=0;i<3;i++){await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);}assert.equal(refreshCalls,0);assert.ok(snapshotCalls>=4);
 await page.locator('#balance-configure').click();await page.locator('#finance-key-id').fill('synthetic-id');await page.locator('#finance-secret').fill('synthetic-secret');assert.equal(await page.locator('#finance-secret').getAttribute('type'),'password');
 await page.locator('#nav-models').click();await page.locator('#nav-overview').click();await page.locator('#balance-configure').click();assert.equal(await page.locator('#finance-secret').inputValue(),'');
 await page.locator('#finance-key-id').fill('synthetic-id');await page.locator('#finance-secret').fill('synthetic-secret');await page.locator('#finance-save').click();assert.equal(await page.locator('#balance-refresh-aliyun').isDisabled(),true);assert.equal(await page.locator('#balance-refresh-deepseek').isDisabled(),true);await page.waitForFunction(()=>!document.querySelector('#finance-save'));assert.equal(saves,1);assert.match(await page.locator('#balance-aliyun').innerText(),/-12.00/);assert.match(await page.locator('#balance-aliyun').innerText(),/可用额度：CNY 80.00/);
 assert.ok(!(await page.evaluate(()=>JSON.stringify([sessionStorage,localStorage]))).includes('synthetic-secret'));assert.ok(!(await page.content()).includes('synthetic-secret'));
 // Old manual result from a previous instance cannot replace a new account snapshot.
 delay=350;await page.locator('#balance-refresh-deepseek').click();await page.waitForTimeout(30);instance='two';state.providers[1]={...state.providers[1],rows:[{currency:'CNY',amount:'99.00'}],checkedAt:'2026-09-16T04:02:00Z',updatedAt:'2026-09-16T04:02:00Z'};await page.locator('#refresh').click();await page.waitForTimeout(420);assert.match(await page.locator('#balance-deepseek').innerText(),/99.00/);assert.doesNotMatch(await page.locator('#balance-deepseek').innerText(),/137.98/);
 state.providers[1]={...state.providers[1],status:'error',stale:true,message:'暂时无法读取官方余额，请检查凭据、读取权限或网络后刷新。'};await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#balance-deepseek').textContent.includes('已过期'));assert.match(await page.locator('#balance-deepseek').innerText(),/99.00/);
 const out=resolve(process.env.MANAGEMENT_UI_OUTPUT);await mkdir(out,{recursive:true});await page.screenshot({path:resolve(out,'balances-wide.png')});await page.setViewportSize({width:380,height:900});await page.screenshot({path:resolve(out,'balances-narrow.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
});
