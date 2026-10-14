import {DESKTOP_BRIDGE_VERSION} from '../../dist/contracts/desktop-bridge.js';
// Production main/HTML/CSS in real browsers; only model and device adapters replaced.
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';

const engines=await import(process.env.PLAYWRIGHT_MODULE),out=resolve('../../artifacts/W1/work-records-23/browser');await mkdir(out,{recursive:true});const temp=await mkdtemp(join(out,'build-'));let server,browser;
try{
 await build({entryPoints:['desktop/main.mjs'],bundle:true,format:'esm',outfile:join(temp,'main.js'),plugins:[{name:'no-model-or-devices',setup(b){b.onResolve({filter:/cubism-renderer\.mjs|browser-playback\.ts|browser-capture\.ts/},a=>({path:a.path,namespace:'isolated'}));b.onLoad({filter:/.*/,namespace:'isolated'},a=>({contents:a.path.includes('cubism')?`export class JellyfishRenderer {ready=true;async load(){}setAutomaticPolicy(){}setFraming(){}reset(){}beginAttention(){}updateView(){}snapshot(){return {}}dispose(){}}`:a.path.includes('playback')?`export class BrowserPlaybackDriver {async open(){window.forbiddenCalls++;throw Error('No playback in UI fixture')}}`:`export class BrowserCaptureDriver {async open(){window.syntheticCaptureOpens++;return {stop(){}}}}`}));}}]});
 const html=(await readFile('desktop/index.html','utf8')).replace(/<script[\s\S]*?<\/script>/g,'').replace('</body>','<script type="module" src="main.js"></script></body>');
 server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://local').pathname;const data=path==='/'?html:path==='/main.js'?await readFile(join(temp,'main.js')):path==='/style.css'?await readFile('desktop/style.css'):null;if(data===null){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',path==='/'?'text/html; charset=utf-8':path==='/style.css'?'text/css':'text/javascript');res.end(data);}catch{res.statusCode=500;res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const engine='webkit',width=380;browser=await engines.webkit.launch({headless:true});
 const page=await browser.newPage({viewport:{width,height:940},locale:'zh-CN'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.wires=[];window.forbiddenCalls=0;window.syntheticCaptureOpens=0;window.webkit={messageHandlers:Object.fromEntries(['desktop','shell','diagnostic'].map(name=>[name,{postMessage(value){wires.push({name,value})}}]))};if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{forbiddenCalls++;throw Error('Devices forbidden')};});
 await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.petBridge);
 const recv=m=>page.evaluate(m=>petBridge.receive(m,1),m);await page.evaluate(()=>petBridge.connectionChanged({generation:1,state:'connecting'}));await recv({channel:'backend_ready',bridgeVersion:DESKTOP_BRIDGE_VERSION,characterId:'companion',sessionId:'s1'});
 const phases=['unknown','unknown','completed','completed','completed','unavailable','unavailable','awaiting_confirmation','awaiting_confirmation'];
 const titles=['页面整理','日期核对','项目摘要','来源检查','文档整理','历史请求一','历史请求二','待确认安排一','待确认安排二'];
 const requests=phases.map((phase,i)=>({id:'synthetic-'+i,version:1,phase,executor:'codex',plan:{title:titles[i]},text:'合成任务正文，未发送给任何执行器。',confirmedAt:phase==='awaiting_confirmation'?undefined:'2026-09-15T00:00:00Z',result:phase==='completed'?'合成完成回执。':undefined,createdAt:''}));let sequence=0;
 const state=extra=>recv({channel:'work_state',state:{sequence:++sequence,stage:'idle',focus:'work',pendingCount:2,requests,...extra}});
 const actions=()=>page.evaluate(()=>wires.filter(w=>w.name==='desktop'&&w.value.message.channel==='work_action').map(w=>w.value.message.action));
 const geometry=()=>page.evaluate(()=>Object.fromEntries(['pet','character','drawer','conversation','form'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return[id,{x:r.x,y:r.y,width:r.width,height:r.height}]})));
 await state({});const before=await actions();await page.locator('#work-badge').click();await page.waitForTimeout(250);
 assert.equal(await page.locator('#work-records-dialog').evaluate(n=>n.open),true);assert.equal(await page.locator('#work-card').isVisible(),false);assert.equal(await page.locator('#work-card').textContent(),'');assert.deepEqual(await actions(),before);assert.equal(await page.evaluate(()=>document.activeElement.id),'work-records-close');
 assert.equal(await page.locator('#work-records-content>.work-record').count(),9);assert.match(await page.locator('#work-records-feedback').innerText(),/9 条记录.*待核对 2 项/);
 for(const label of ['待确认','已完成','结果待核实','本次未完成'])assert.ok((await page.locator('#work-records-content').innerText()).includes(label));
 assert.equal(await page.locator('#work-reopen').count(),0);assert.equal(await page.locator('#reply').innerText(),'');const originalGeometry=await geometry();
 await page.locator('#work-records-refresh').click();assert.match(await page.locator('#work-records-feedback').innerText(),/正在查询/);assert.deepEqual((await actions()).at(-1),{type:'refresh'});await state({});assert.match(await page.locator('#work-records-feedback').innerText(),/已收到更新.*9 条/);
 await page.locator('#work-records-dialog').screenshot({path:join(out,'webkit-records-380.png')});
 await page.locator('#work-record-synthetic-0>summary').click();await page.locator('#work-record-refresh-synthetic-0').click();assert.deepEqual((await actions()).at(-1),{type:'refresh',id:'synthetic-0'});await state({});assert.equal(await page.locator('#work-record-synthetic-0').evaluate(n=>n.open),true);
 await page.locator('#work-records-content').evaluate(n=>n.scrollTop=n.scrollHeight);assert.ok(await page.locator('#work-records-content').evaluate(n=>n.scrollTop)>0);assert.deepEqual(await geometry(),originalGeometry);
 for(let i=0;i<4;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.querySelector('#work-records-dialog').contains(document.activeElement)),true);}
 await page.keyboard.press('Escape');assert.equal(await page.locator('#work-records-dialog').evaluate(n=>n.open),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'work-badge');assert.equal(await page.locator('#work-card').isVisible(),false);
 const draft={id:'d',version:1,text:'合成原始请求',projects:[],targets:[]};await state({stage:'confirming',draft,confirmation:requests[7]});await page.locator('#work-badge').click();assert.equal(await page.locator('#work-confirm').isVisible(),true);assert.equal(await page.locator('#work-records-dialog').evaluate(n=>n.open),false);assert.equal((await actions()).at(-1).type,'focus');
 assert.ok((await actions()).every(a=>['refresh','focus'].includes(a.type)));assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>forbiddenCalls+syntheticCaptureOpens),0);
 await writeFile(join(out,'webkit.json'),JSON.stringify({engine,version:browser.version(),width,checks:['idle badge directly opens9 real DOM records with pending2; no focus/no empty card','refresh query and newer snapshot feedback; per-ID refresh preserves disclosure','scroll and focus contained, Escape restores badge, geometry unchanged','valid confirmation keeps processing path, no dispatch'],actions:await actions(),errors,realDevicesModelsTaskSends:0,boundary:'Production main/HTML/CSS in WebKit380 with synthetic bridge rows. Model/device adapters replaced. One screenshot; no user task/QR data.'},null,2)+'\n');
 console.log('WebKit380: direct9-record entry, refresh, scroll/focus and confirmation path passed');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}
