// Isolated real-browser component check; synthetic data only, no business API.
import {createServer} from 'node:http';
import{readFile,mkdir,writeFile}from'node:fs/promises';
import{resolve,join}from'node:path';
import assert from 'node:assert/strict';
const{chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const out=resolve('../../artifacts/W0-I/voice-feedback-03');await mkdir(out,{recursive:true});
const html=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><main id="app"></main><script type="module">
import{createPendingMemoryView}from'/pending-memory-view.mjs';
window.writes=[];window.s={connection:'online',snapshot:{runtime:{instanceId:'synthetic-instance'}}};window.rows=[{id:'synthetic-private-id',intent:'forget',status:'failed',preview:'<img src=x onerror=alert(1)> 忘记合成的红茶偏好',createdAt:'2026-09-12T08:00:00Z'}];
const client={async request(url,opts){if(opts){writes.push({url,...opts});if(url.endsWith('/cancel'))rows=[];return{status:url.endsWith('/retry')?'queued':'cancelled'};}return{instanceId:s.snapshot.runtime.instanceId,requests:rows,busy:false};}};
const view=createPendingMemoryView(client,()=>{document.querySelector('#app').replaceChildren(view.view())},()=>s);window.view=view;document.querySelector('#app').replaceChildren(view.view());await view.load();window.ready=true;
</script>`;
const server=createServer(async(req,res)=>{try{res.setHeader('Content-Type',req.url?.endsWith('.mjs')?'text/javascript':req.url?.endsWith('.css')?'text/css':'text/html');const names=new Set(['/pending-memory-view.mjs','/dom.mjs','/style.css']);res.end(names.has(req.url)?await readFile(resolve('management/ui','.'+req.url)):html);}catch{res.statusCode=404;res.end();}});
let browser;const results=[];
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1000,height:720}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.ready);
 assert.equal(await page.locator('main img').count(),0);assert.ok((await page.locator('main').innerText()).includes('<img src=x'));assert.ok(!(await page.locator('main').innerText()).includes('synthetic-private-id'));results.push('original request preview rendered as plain text; no UUID shown');
 assert.equal(await page.evaluate(()=>writes.length),0);results.push('loading and rendering never submit a request');
 let accepted=false;const dialogs=[];page.on('dialog',async d=>{dialogs.push(d.message());accepted?await d.accept():await d.dismiss();});
 await page.locator('[data-pending-retry]').click();assert.equal(await page.evaluate(()=>writes.length),0);results.push('dismissing retry confirmation leaves original request unchanged');
 accepted=true;await page.locator('[data-pending-retry]').click();await page.waitForFunction(()=>writes.length===1);assert.match(dialogs.at(-1),/费用计入原累计预算/);assert.deepEqual(await page.evaluate(()=>writes[0].body),{instanceId:'synthetic-instance',id:'synthetic-private-id'});results.push('explicit retry submits only request identity and instance once');
 await page.screenshot({path:join(out,'pending-memory-ui.png')});
 accepted=false;await page.locator('[data-pending-cancel]').click();assert.equal(await page.evaluate(()=>writes.length),1);assert.match(dialogs.at(-1),/尚未删除的个人资料可能重新用于回复/);assert.match(dialogs.at(-1),/已经遗忘的内容不会恢复/);results.push('cancel explanation states release boundary and dismiss has no effect');
 accepted=true;await page.locator('[data-pending-cancel]').click();await page.waitForFunction(()=>writes.length===2);await page.getByText('当前没有未完成的记忆请求。').waitFor();results.push('explicit cancel refreshes completed UI without repeating source');
 assert.deepEqual(errors,[]);results.push('no browser script errors');await writeFile(join(out,'pending-memory-ui.json'),JSON.stringify({passed:results.length,failed:0,results,modelCalls:0,deviceCalls:0,realUserData:false},null,2)+'\n');console.log(JSON.stringify({passed:results.length,failed:0}));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
