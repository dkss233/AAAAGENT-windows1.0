// Actual header HTML/CSS/entry in headless Chromium. Native, rendering and media
// are controlled; never opens the default browser or reads a management session.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const out=resolve('../../artifacts/W1/speech-control-02');await mkdir(out,{recursive:true});
const dir=await mkdtemp(join(out,'browser-fixture-')),report={boundary:'actual headless HTML/CSS/entry; native/model/media controlled',checks:[],layouts:[]};
let server,browser;
try {
 await build({entryPoints:['desktop/main.mjs'],bundle:true,format:'esm',outfile:join(dir,'renderer.js'),plugins:[{name:'controlled-adapters',setup(b){
  b.onResolve({filter:/cubism-renderer\.mjs|browser-playback\.ts|browser-capture\.ts/},a=>({path:a.path,namespace:'controlled'}));
  b.onLoad({filter:/.*/,namespace:'controlled'},a=>({contents:a.path.includes('cubism')?'export class JellyfishRenderer {async load(){} setFraming(){} reset(){} snapshot(){return {}} dispose(){} updateView(){}}':`export class ${a.path.includes('playback')?'BrowserPlaybackDriver':'BrowserCaptureDriver'} {open(){throw Error('fixture forbids devices')}}`}));
 }}]});
 const files={
  '/':(await readFile('desktop/index.html','utf8')).replace('<script src="vendor/cubism/Core/live2dcubismcore.min.js"></script>','<script src="fixture.js"></script>'),
  '/style.css':await readFile('desktop/style.css'),'/build/renderer.js':await readFile(join(dir,'renderer.js')),
  '/fixture.js':`window.fixtureShell=[];window.fixtureWire=[];
  window.fixtureConfigure=()=>petBridge.displayConfig({mode:'half',preferredWidth:360,modelWidth:220,modelHeight:208,drawerHeight:540,petLeft:10,petTop:0,petWidth:220,drawerLeft:10,drawerTop:244,drawerWidth:innerWidth-20});
  window.webkit={messageHandlers:{diagnostic:{postMessage(){}},desktop:{postMessage(v){fixtureWire.push(v)}},shell:{postMessage(v){fixtureShell.push(v);if(v.type==='ready')queueMicrotask(async()=>{petBridge.connectionChanged({generation:1,state:'connecting'});await petBridge.receive({channel:'backend_ready',bridgeVersion:'0.2.0',characterId:'companion',sessionId:'management-fixture'},1);fixtureConfigure();window.fixtureReady=true;});}}}};`
 };
 server=createServer((req,res)=>{const file=files[req.url];res.statusCode=file?200:404;res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(file??'')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:500,height:820}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.fixtureReady);
 await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#open').click();await page.locator('#text').fill('保留这段未发送的草稿。');
 const check=(name,ok)=>{assert.ok(ok,name);report.checks.push({name,passed:true})};
 const launches=()=>page.evaluate(()=>fixtureShell.filter(x=>x.type==='open_management'));
 async function layout(label){const value=await page.evaluate(()=>{const d=document.getElementById('drawer').getBoundingClientRect();return {drawer:{left:d.left,right:d.right},controls:['.panel-title strong','#management','#display-controls','#close'].map(s=>{const n=document.querySelector(s),r=n.getBoundingClientRect();return {selector:s,left:r.left,right:r.right,top:r.top,bottom:r.bottom,hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})}});report.layouts.push({label,...value});check(label+' header fits and hit targets remain distinct',value.controls.every((x,i)=>x.hit&&x.left>=value.drawer.left&&x.right<=value.drawer.right&&(i===0||x.left>=value.controls[i-1].right)));}
 check('startup never opens management',(await launches()).length===0);
 for(const width of [500,320]){
  await page.setViewportSize({width,height:820});await page.evaluate(()=>fixtureConfigure());await layout(width+' ready');
  await page.evaluate(()=>petBridge.hotkeyConfig('Space'));await page.locator('#management').focus();const before=(await launches()).length;await page.keyboard.press('Space');
  check(width+' Space opens exactly once without PTT',(await launches()).length===before+1&&await page.evaluate(()=>fixtureWire.length===0));
  await page.evaluate(()=>document.getElementById('management').click());check(width+' pending click is ignored',(await launches()).length===before+1);await layout(width+' pending');
  await page.evaluate(()=>petBridge.managementResult({ok:false,detail:'fixture-private-value'}));
  check(width+' failure is readable and retry enabled',await page.locator('#management-notice').isVisible()&&await page.locator('#management').isEnabled()&&!(await page.locator('#drawer').innerText()).includes('fixture-private-value'));await layout(width+' failed');
  await page.locator('#drawer').screenshot({path:join(out,'header-'+width+'.png')});
  await page.evaluate(()=>petBridge.hotkeyConfig('Enter'));await page.locator('#management').focus();await page.keyboard.press('Enter');
  check(width+' Enter retry emits the fixed intent only',JSON.stringify((await launches()).at(-1))===JSON.stringify({type:'open_management'})&&(await launches()).length===before+2&&await page.evaluate(()=>fixtureWire.length===0));
  await page.evaluate(()=>petBridge.managementResult({ok:true}));check(width+' success hides notice and keeps draft',!await page.locator('#management-notice').isVisible()&&await page.locator('#text').inputValue()==='保留这段未发送的草稿。');
 }
 check('no browser script errors',errors.length===0);report.errors=errors;report.passed=true;
} finally {await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});await writeFile(join(out,'management-browser.json'),JSON.stringify(report,null,2)+'\n');}
console.log(report.checks.length+' management browser checks passed');
