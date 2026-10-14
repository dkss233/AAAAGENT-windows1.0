import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Use the existing Playwright installation');
assert.ok(process.env.MICROPHONE_POLICY_EVIDENCE, 'Provide an explicit evidence directory');
const playwright=await import(process.env.PLAYWRIGHT_MODULE);
const source=new URL('../../../../management/ui/', import.meta.url);
const output=process.env.MICROPHONE_POLICY_EVIDENCE;
await mkdir(output, {recursive:true});
const original=process.env.MICROPHONE_POLICY_RED_REVISION;
const viewSource=original?execFileSync('git',['show',`${original}:code/desktop-pet/management/ui/native-workbench-view.mjs`],{encoding:'utf8'}):await readFile(new URL('native-workbench-view.mjs',source),'utf8');
const observations=[],foreignObservations=[],requests=[];
let config={},outerOrigin,innerOrigin,foreignOrigin;
const environment='controlled-environment';
const navigationId='acbd1234-aaaa-4bbb-8ccc-123456789abc';
const relation=()=>({version:'0.1.1',origin:outerOrigin,path:'/',environmentId:environment,navigationId});
const receipt=()=>({version:'0.1.0',status:'ready',target:{kind:'home',environmentId:environment},expiresAt:new Date(Date.now()+30000).toISOString(),url:innerOrigin+'/open#'+'a'.repeat(43),originalManagementReturn:relation(),...(config.invalidReceipt?{originalManagementReturn:{...relation(),environmentId:'wrong-environment'}}:{})});
const outerHtml=()=>`<!doctype html><meta charset="utf-8"><meta name="aaa-management-entry" data-version="0.1.0" content="original-management"><meta name="aaa-management-frame-origin" data-version="0.1.0" content="${innerOrigin}"><main id="app"><button id="enter">打开</button><textarea aria-label="管理草稿"></textarea></main><script type="module">
import {createOriginalManagementFrameView} from '/modules/native-workbench-view.mjs';
window.host={connection:'online',authEpoch:0,instanceId:'controlled-host'};window.calls=[];
window.view=createOriginalManagementFrameView({request:async(path,options)=>{window.calls.push(path);return ${JSON.stringify(receipt())};}},()=>window.host);
document.getElementById('enter').onclick=()=>window.view.enter();window.view.sync();window.booted=true;
</script>`;
const innerHtml=standalone=>`<!doctype html><meta charset="utf-8"><main id="app"></main><script type="module">
import {createNativeWorkbenchView} from '/modules/native-workbench-view.mjs';
${standalone?'':`sessionStorage.setItem('aaa-original-management-return-v1',JSON.stringify(${JSON.stringify(relation())}));`}
window.host={connection:'online',authEpoch:0,instanceId:'controlled-host',page:'workbench'};window.calls=[];window.replyMode=${JSON.stringify(config.mode??'native-operate')};window.defer=${!!config.defer};
const client={request:async(path,options)=>{window.calls.push(path);if(window.defer)await new Promise(resolve=>window.resolveMount=resolve);return {apiVersion:1,mode:window.replyMode,mountPath:'/native/',readonly:window.replyMode==='native-read',environmentId:${JSON.stringify(config.mismatch?'wrong-environment':environment)},expiresAt:new Date(Date.now()+${config.expiry??60000}).toISOString()};}};
let view;window.redraw=()=>{if(!view)return;view.sync();const content=document.createElement('div');content.append(view.view());document.getElementById('app').replaceChildren(content);view.afterRender();};
view=createNativeWorkbenchView(client,window.redraw,()=>window.host);window.dispose=()=>view.dispose();window.redraw();window.booted=true;
</script>`;
const leafHtml=`<!doctype html><meta charset="utf-8"><div id="root" class="aaa-workspace-shell"><textarea aria-label="工作草稿"></textarea><button id="back">返回管理</button></div><script>
window.contextId=Math.random();const draft=document.querySelector('textarea'),key='controlled-policy-draft:'+location.pathname;draft.value=localStorage.getItem(key)||'';draft.oninput=()=>localStorage.setItem(key,draft.value);document.getElementById('back').onclick=()=>parent.postMessage({source:'aaa-workspace-ui',version:1,type:'management.navigate',page:'overview'},location.origin);
</script>`;
const policyScript=`const p=document.permissionsPolicy??document.featurePolicy;window.policy={available:!!p,microphone:p?.allowsFeature('microphone')??null,camera:p?.allowsFeature('camera')??null,autoplay:p?.allowsFeature('autoplay')??null};`;
async function server(kind){
 const s=http.createServer(async(req,res)=>{
  try{
   const u=new URL(req.url,'http://127.0.0.1');requests.push({kind,path:u.pathname,method:req.method});
   assert.equal(req.method,'GET','Only fixture page/module GETs are allowed');
   if(u.pathname==='/foreign-policy'){foreignObservations.push(JSON.parse(u.searchParams.get('value')));res.end('ok');return;}
   let body,type='text/html';
   if(u.pathname.startsWith('/modules/')){
    const name=u.pathname.slice(9);assert.match(name,/^[a-z0-9-]+\.mjs$/);
    body=name==='native-workbench-view.mjs'?viewSource:await readFile(new URL(name,source),'utf8');type='text/javascript';
   }else if(kind==='outer'&&u.pathname==='/test')body=outerHtml();
   else if(kind==='inner'&&['/open','/standalone'].includes(u.pathname))body=innerHtml(u.pathname==='/standalone');
   else if(kind==='inner'&&u.pathname.startsWith('/native/'))body=leafHtml;
   else if(kind==='inner'&&u.pathname==='/api/auth/session'){body=JSON.stringify({authenticated:true});type='application/json';}
   else if(kind==='foreign'&&u.pathname==='/landing')body=`<!doctype html><script>${policyScript}fetch('/foreign-policy?value='+encodeURIComponent(JSON.stringify(window.policy)));</script>`;
   else if(u.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
   else throw Error('Unexpected fixture route: '+u.pathname);
   res.writeHead(200,{'Content-Type':type});res.end(body);
  }catch(e){res.writeHead(500);res.end('fixture error');observations.push({serverError:String(e)});}
 });
 await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));return {s,origin:`http://127.0.0.1:${s.address().port}`};
}
const servers=[];
for(const kind of ['outer','inner','foreign'])servers.push(await server(kind));
[outerOrigin,innerOrigin,foreignOrigin]=servers.map(x=>x.origin);
async function setup(browser,settings={},standalone=false){
 config=settings;const context=await browser.newContext({reducedMotion:'reduce'}),page=await context.newPage(),errors=[],devices=[];
 await context.addInitScript(()=>{window.mediaAcquisitions=0;if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{window.mediaAcquisitions++;throw Error('Device acquisition forbidden in permission-policy test');};});
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error'&&/Device acquisition forbidden/.test(m.text()))devices.push(m.text());});
 await page.goto((standalone?innerOrigin+'/standalone':outerOrigin+'/test'));
 await page.waitForFunction(()=>window.booted===true);
 if(!standalone)await page.getByRole('button',{name:'打开',exact:true}).click();
 const frameUrl=f=>{try{return new URL(f.url());}catch{return {origin:null,pathname:''};}};
 const wrapper=()=>standalone?page.mainFrame():page.frames().find(f=>frameUrl(f).origin===innerOrigin&&frameUrl(f).pathname==='/open');
 const leaf=()=>page.frames().find(f=>frameUrl(f).origin===innerOrigin&&frameUrl(f).pathname.startsWith('/native/'));
 return {page,context,errors,devices,wrapper,leaf,async loaded(){await page.waitForFunction(()=>!!document.querySelector('iframe'));const until=Date.now()+10000;while(!leaf()&&Date.now()<until)await page.waitForTimeout(20);assert.ok(leaf(),'Native fixture did not load');await leaf().getByLabel('工作草稿').waitFor();},async close(name,extra={}){
  const counters=await Promise.all(page.frames().map(f=>f.evaluate(()=>window.mediaAcquisitions??0).catch(()=>0)));assert.ok(counters.every(x=>x===0));assert.deepEqual(devices,[]);assert.deepEqual(errors,[]);
  observations.push({name,...extra,deviceCalls:counters,errors});await context.close();
 }};
}
async function policy(frame){return frame.evaluate(script=>{(0,eval)(script);return window.policy;},policyScript);}
try{
 for(const engine of ['chromium','webkit']){
  const browser=await playwright[engine].launch({headless:true});
  try{
   await test(`${engine}: real nested original view modules, synthetic authentication, no devices/models`,async t=>{
    await t.test('operable leaf inherits microphone; camera and autoplay remain denied',async()=>{
     const x=await setup(browser);await x.loaded();const p=await policy(x.leaf());
     observations.push({name:'operate-policy-observed-'+engine,policy:p,deviceCalls:await Promise.all(x.page.frames().map(f=>f.evaluate(()=>window.mediaAcquisitions??0)))});
     if(engine==='chromium')assert.equal(p.available,true);
     if(p.available){assert.equal(p.microphone,true);assert.equal(p.camera,false);assert.equal(p.autoplay,false);}
     assert.equal(await x.page.locator('iframe').getAttribute('allow'),`camera 'none'; microphone ${innerOrigin}; autoplay 'none'`);
     assert.equal(await x.wrapper().locator('iframe').getAttribute('allow'),`camera 'none'; microphone ${innerOrigin}; autoplay 'none'`);
     await x.close('operate-'+engine,{policy:p});
    });
    if(original)return;
    await t.test('read-only leaf denies microphone across the same two-frame chain',async()=>{
     const x=await setup(browser,{mode:'native-read'});await x.loaded();const p=await policy(x.leaf());if(p.available)assert.equal(p.microphone,false);
     assert.match(await x.wrapper().locator('iframe').getAttribute('allow'),/microphone 'none'/);await x.close('readonly-'+engine,{policy:p});
    });
    await t.test('return/reopen keeps original leaf context and persistent draft',async()=>{
     const x=await setup(browser);await x.loaded();await x.leaf().getByLabel('工作草稿').fill('受控权限测试草稿');const id=await x.leaf().evaluate(()=>window.contextId);
     await x.leaf().getByRole('button',{name:'返回管理',exact:true}).click();await x.page.waitForFunction(()=>document.querySelector('.native-workbench-portal').hidden);
     await x.page.getByRole('button',{name:'打开',exact:true}).click();assert.equal(await x.leaf().evaluate(()=>window.contextId),id);assert.equal(await x.leaf().getByLabel('工作草稿').inputValue(),'受控权限测试草稿');await x.close('return-context-'+engine);
    });
    await t.test('session expiry removes both authorized frame documents',async()=>{
     const x=await setup(browser,{expiry:1500});await x.loaded();await x.page.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.phase==='expired');assert.equal(await x.page.locator('iframe').count(),0);await x.close('expiry-teardown-'+engine);
    });
    await t.test('outer auth loss removes operable descendants immediately',async()=>{
     const x=await setup(browser);await x.loaded();await x.page.evaluate(()=>{window.host.connection='locked';window.host.authEpoch++;window.view.sync();});assert.equal(await x.page.locator('iframe').count(),0);await x.close('outer-auth-teardown-'+engine);
    });
    await t.test('mismatched receipt never creates delegated frame',async()=>{
     const x=await setup(browser,{invalidReceipt:true});await x.page.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.phase==='error');assert.equal(await x.page.locator('iframe').count(),0);await x.close('receipt-mismatch-'+engine);
    });
    await t.test('mismatched authenticated environment never loads native leaf',async()=>{
     const x=await setup(browser,{mismatch:true});await x.page.waitForFunction(()=>document.querySelector('.native-workbench-portal').dataset.phase==='error');assert.equal(await x.page.locator('iframe').count(),0);assert.equal(x.leaf(),undefined);await x.close('session-environment-mismatch-'+engine);
    });
    await t.test('reconnect switches read/operate policy before navigation and preserves same-environment draft',async()=>{
     const x=await setup(browser,{mode:'native-read'},true);await x.loaded();await x.leaf().goto(innerOrigin+'/native/controlled-environment/thread-a');await x.leaf().getByLabel('工作草稿').fill('重新进入保留草稿');
     for(const mode of ['native-operate','native-read']){
      const id=await x.leaf().evaluate(()=>window.contextId);await x.page.evaluate(mode=>{window.host.connection='locked';window.redraw();window.replyMode=mode;window.host.connection='online';window.host.authEpoch++;window.redraw();},mode);
      await x.page.waitForFunction(id=>{const f=document.querySelector('iframe');return !!f?.contentWindow.contextId&&f.contentWindow.contextId!==id;},id);await x.leaf().getByLabel('工作草稿').waitFor();
      const p=await policy(x.leaf());if(p.available)assert.equal(p.microphone,mode==='native-operate');assert.equal(await x.leaf().getByLabel('工作草稿').inputValue(),'重新进入保留草稿');
     }
     await x.close('mode-reconnect-draft-'+engine);
    });
    await t.test('late authentication reply cannot restore an invalidated document',async()=>{
     const x=await setup(browser,{defer:true},true);await x.page.waitForFunction(()=>typeof window.resolveMount==='function');await x.page.evaluate(()=>{window.host.connection='locked';window.host.authEpoch++;window.redraw();window.defer=false;window.resolveMount();});await x.page.waitForTimeout(100);assert.equal(await x.page.locator('iframe').count(),0);await x.close('late-reply-'+engine);
    });
    await t.test('different-origin navigation never inherits delegated microphone',async()=>{
     const x=await setup(browser);await x.loaded();const before=foreignObservations.length;await x.leaf().goto(foreignOrigin+'/landing').catch(()=>{});
     for(let i=0;i<100&&foreignObservations.length===before;i++)await x.page.waitForTimeout(20);
     const p=foreignObservations[before];assert.ok(p);if(p.available)assert.equal(p.microphone,false);await x.close('foreign-origin-denied-'+engine,{policy:p});
    });
   });
  }finally{await browser.close();}
 }
}finally{
 await writeFile(output+'/observations.json',JSON.stringify({level:'Actual browser DOM and inherited permission policy; synthetic loopback authentication/native leaf; no original runtime, model, ASR or devices',sourceSha256:createHash('sha256').update(viewSource).digest('hex'),redRevision:original??null,observations,requests,foreignObservations},null,2)+'\n');
 await Promise.all(servers.map(({s})=>new Promise(resolve=>s.close(resolve))));
}
