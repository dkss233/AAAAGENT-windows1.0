import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMemoryDynamicsFixture} from './memory-dynamics-fixture.mjs';
import {choose} from './choice-helper.mjs';

const {webkit}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const output=resolve(process.env.MANAGEMENT_UI_OUTPUT);await mkdir(output,{recursive:true});
const configuration={model:'synthetic-memory-model',endpointHost:'example.invalid',batchMessages:16,maxInputBytes:10000,maxOutputTokens:1000,concurrency:1,timeoutMs:30000,budgetMode:'unlimited',limitMicros:null,inputMicrosPerToken:2,outputMicrosPerToken:3,currency:'CNY',textExportFormat:'JSONL：每行 {"role":"user"或"assistant","text":"正文","createdAt":"含时区的ISO日期"}；只读原文件。'};
const stamp='2026-09-18T00:00:00.000Z';
const makeJob=(source,id='synthetic-job')=>({id,revision:1,characterId:'companion',source,sourceFingerprint:null,status:'discovering',createdAt:stamp,updatedAt:stamp,discoveredMessages:0,processedMessages:0,skippedMessages:0,totalBatches:0,completedBatches:0,importedMemories:0,estimatedCalls:0,estimatedMicros:null,actualCalls:0,accountedMicros:0,unknownCostCalls:0,failures:[],configuration});

test('historical import UI: synthetic HTTP only, no private source or models',async t=>{
 const fixture=await createMemoryDynamicsFixture(),browser=await webkit.launch({headless:true}),context=await browser.newContext({viewport:{width:1100,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(7000);
 let jobs=[],getMode='',postMode='',getDelay=0,postDelay=0,gets=0,external=0;
 const writes=[],checks=[],pageErrors=[];
 const instance=()=>fixture.state.controls.instanceId||'synthetic-memory-instance';
 page.on('pageerror',e=>pageErrors.push(e.message));
 await page.addInitScript(()=>{window.deviceCalls=0;navigator.mediaDevices.getUserMedia=()=>{window.deviceCalls++;throw Error('Devices forbidden');};});
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==new URL(fixture.url).origin){external++;return route.abort();}return route.continue();});
 await page.route('**/api/memory-import**',async route=>{
  const req=route.request();assert.equal(req.headers().authorization,'Bearer memory-dynamics-synthetic-session');
  if(req.method()==='GET'){
   gets++;const value=structuredClone({instanceId:instance(),configuration,jobs});
   if(getMode==='offline')return route.fulfill({status:503,json:{error:{code:'unavailable',message:'SECRET server diagnostic'}}});
   if(getMode==='old'&&value.jobs[0])value.jobs[0].revision=1;
   if(getMode==='foreign'&&value.jobs[0])value.jobs[0].characterId='retired';
   if(getMode==='instance')value.instanceId='wrong-instance';
   if(getDelay)await new Promise(r=>setTimeout(r,getDelay));
   return route.fulfill({json:value});
  }
  const body=req.postDataJSON(),action=new URL(req.url()).pathname.split('/').at(-1);writes.push({action,body});
  const original=jobs.find(j=>j.id===body.jobId);
  if(postDelay)await new Promise(r=>setTimeout(r,postDelay));
  if(postMode==='uncertain')return route.fulfill({status:503,json:{error:{message:'SECRET transcript text'}}});
  if(postMode==='conflict'){if(original)original.revision++;return route.fulfill({status:409,json:{error:{code:'version_conflict',message:'SECRET source content'}}});}
  let job;
  if(action==='start'){assert.equal(body.characterId,'companion');job=makeJob(body.source,'synthetic-'+writes.length);jobs.unshift(job);}
  else{assert.equal(body.expectedRevision,original.revision);job={...original,revision:original.revision+1,status:action==='pause'?'paused':'running'};jobs=jobs.map(j=>j.id===job.id?job:j);}
  return route.fulfill({json:job});
 });
 const click=id=>page.locator('#'+id).click();
 const ready=()=>page.locator('#import-refresh:not([disabled])').waitFor();
 const refresh=async()=>{await ready();const before=gets;await click('import-refresh');await page.waitForFunction(()=>!document.getElementById('import-refresh').disabled);assert.ok(gets>before);};
 const fill=async(name,path)=>{await page.locator('#import-project').fill(name);await page.locator('#import-path').fill(path);};
 const check=async(name,fn)=>{await t.test(name,async()=>{await fn();checks.push(name);});assert.ok(checks.includes(name),'Stopped after failed scenario: '+name);};
 try{
  await page.goto(fixture.url);await click('nav-memory');await click('memory-import');await ready();
  await check('reachable, initial read only, explicit source and configuration before start',async()=>{
   assert.equal(writes.length,0);assert.ok(await page.locator('#import-start').isDisabled());
   assert.match(await page.locator('#import-current-config').innerText(),/synthetic-memory-model.*不设本地费用上限/);
   await choose(page,'#import-kind','text-export');assert.match(await page.locator('.import-format').innerText(),/createdAt/);
   await fill('合成旧聊天','https://example.invalid/chat.jsonl');assert.ok(await page.locator('#import-start').isDisabled());
   await fill('合成旧聊天','/synthetic-only/chat.jsonl');assert.ok(await page.locator('#import-start').isEnabled());
  });
  await check('poll preserves caret, open configuration, dropdown and IME node; no browser persistence',async()=>{
   await page.locator('#import-config > summary').click();await page.locator('#import-project').focus();await page.locator('#import-project').evaluate(n=>n.setSelectionRange(1,3));
   const before=gets;await page.waitForTimeout(2150);assert.ok(gets>before);assert.equal(await page.locator('#import-project').inputValue(),'合成旧聊天');assert.deepEqual(await page.locator('#import-project').evaluate(n=>[document.activeElement===n,n.selectionStart,n.selectionEnd]),[true,1,3]);assert.equal(await page.locator('#import-config').evaluate(n=>n.open),true);
   await click('import-kind');await page.waitForTimeout(2100);assert.equal(await page.locator('#import-kind').getAttribute('aria-expanded'),'true');await page.keyboard.press('Escape');
   await page.locator('#import-project').evaluate(n=>{window.ime=n;n.dispatchEvent(new CompositionEvent('compositionstart'));n.value='合成输入中';n.dispatchEvent(new Event('input',{bubbles:true}));});await page.waitForTimeout(2100);assert.ok(await page.evaluate(()=>ime===document.getElementById('import-project')));await page.locator('#import-project').dispatchEvent('compositionend');
   assert.equal(await page.locator('#import-project').inputValue(),'合成输入中');assert.doesNotMatch(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage})),/合成输入中|synthetic-only/);
  });
  await check('double click starts once; same unfinished source blocked; live counts and unknown cost separated',async()=>{
   postDelay=80;await page.evaluate(()=>{document.getElementById('import-start').click();document.getElementById('import-start').click();});await ready();postDelay=0;
   assert.equal(writes.length,1);assert.match(writes[0].body.operationId,/^[a-f0-9-]+$/);assert.equal(writes[0].body.instanceId,instance());assert.ok(await page.locator('#import-start').isDisabled());
   jobs[0]={...jobs[0],revision:2,status:'running',discoveredMessages:40,processedMessages:16,skippedMessages:8,totalBatches:2,completedBatches:1,importedMemories:3,estimatedCalls:2,estimatedMicros:60000,actualCalls:1,accountedMicros:17000,unknownCostCalls:1};await refresh();
   const text=await page.locator('.import-job').innerText();assert.match(text,/批次 1 \/ 2/);assert.match(text,/0.06 元/);assert.match(text,/0.017 元/);assert.match(text,/1 次调用，未按零计入/);assert.match(text,/去重跳过/);
   await page.locator('#memory-import-panel').screenshot({path:resolve(output,'import-running-wide.png')});
  });
  await check('pause/resume uses current job revision; conflict refreshes without auto retry, safe failure codes',async()=>{
   await page.locator('[data-import-action=pause]').click();await ready();assert.equal(jobs[0].status,'paused');assert.equal(writes.at(-1).body.expectedRevision,2);
   postMode='conflict';const before=writes.length;await page.locator('[data-import-action=resume]').click();await ready();postMode='';assert.equal(writes.length,before+1);assert.match(await page.locator('#memory-import-panel').innerText(),/已在其他位置变化/);assert.doesNotMatch(await page.locator('#memory-import-panel').innerText(),/SECRET/);
   await page.locator('[data-import-action=resume]').click();await ready();assert.equal(writes.at(-1).body.expectedRevision,4);assert.equal(jobs[0].status,'running');
   jobs[0]={...jobs[0],revision:6,status:'failed',failures:[{item:'SECRET raw source',code:'provider_timeout'},{item:'private-file',code:'SECRET private code'}]};await refresh();
   assert.match(await page.locator('.import-job').innerText(),/记忆整理超时/);assert.doesNotMatch(await page.locator('#memory-import-panel').innerText(),/SECRET|private-file/);assert.ok(await page.locator('[data-import-action=resume]').isEnabled());
  });
  await check('stale/foreign/wrong-instance snapshots and offline status cannot authorize mutation',async()=>{
   const before=writes.length;
   for(const mode of ['old','foreign','instance','offline']){getMode=mode;await refresh();assert.ok(await page.locator('[data-import-action=resume]').isDisabled());assert.match(await page.locator('#memory-import-panel').innerText(),/进度可能已过期/);assert.doesNotMatch(await page.locator('#memory-import-panel').innerText(),/SECRET/);}
   assert.equal(writes.length,before);getMode='';await refresh();assert.ok(await page.locator('[data-import-action=resume]').isEnabled());
  });
  await check('changed model configuration blocks stale resume and permits explicit new same-source job',async()=>{
   const original=structuredClone(jobs[0]),before=writes.length;
   jobs[0]={...jobs[0],revision:jobs[0].revision+1,configuration:{...configuration,model:'older-synthetic-model',outputMicrosPerToken:1}};await refresh();
   assert.match(await page.locator('.import-job').innerText(),/模型或费用配置已变化/);
   assert.ok(await page.locator('[data-import-action=resume]').isDisabled());assert.ok(await page.locator('#import-start').isEnabled());
   assert.equal(writes.length,before);await click('import-start');await ready();
   assert.equal(writes.length,before+1);assert.equal(writes.at(-1).action,'start');assert.deepEqual(writes.at(-1).body.source,original.source);
   assert.equal(jobs[0].configuration.model,configuration.model);assert.equal(jobs[1].configuration.model,'older-synthetic-model');assert.equal(jobs[1].accountedMicros,original.accountedMicros);
   jobs=[{...original,revision:original.revision+2}];await refresh();
  });
  await check('uncertain start never auto retries; explicit retry retains operation identity',async()=>{
   await fill('另一个合成项目','/synthetic-only/second.jsonl');postMode='uncertain';const before=writes.length;await click('import-start');await ready();await page.waitForTimeout(2100);assert.equal(writes.length,before+1);assert.match(await page.locator('#memory-import-panel').innerText(),/不会自动重发/);
   const original=writes.at(-1).body;postMode='';await click('import-start');await ready();assert.deepEqual(writes.at(-1).body,original);assert.equal(jobs.length,2);
  });
  await check('navigation, restart and reload do not replay; late prior-instance receipt ignored',async()=>{
   const target=jobs[0];postDelay=300;await page.locator('#import-action-'+target.id).click();
   fixture.state.controls.instanceId='synthetic-restarted';jobs=[];await click('refresh');await page.locator('#refresh:not([disabled])').waitFor();await page.waitForTimeout(450);postDelay=0;await ready();
   // Fixture returned a prior-instance action late; reject that receipt, then use a fresh snapshot.
   jobs=[];await refresh();assert.equal(await page.locator('.import-job').count(),0);assert.equal(await page.locator('#import-project').inputValue(),'另一个合成项目');
   const before=writes.length;await click('nav-overview');await page.reload();await click('nav-memory');await click('memory-import');await ready();assert.equal(writes.length,before);assert.equal(await page.locator('#import-project').inputValue(),'');
  });
  await check('completed and paused history fits narrow page; zero private/device/model calls',async()=>{
   jobs=[{...makeJob({kind:'text-export',projectName:'合成历史项目',path:'/synthetic-only/long-path/'.repeat(8)+'chat.jsonl'},'completed'),status:'completed',revision:2,discoveredMessages:40,processedMessages:32,skippedMessages:8,totalBatches:2,completedBatches:2,importedMemories:7,estimatedMicros:60000,accountedMicros:40000,actualCalls:2}, {...makeJob({kind:'codex-project',projectName:'合成 Codex 项目',path:'/synthetic-only/project'},'paused'),status:'paused',revision:3}];await refresh();
   await page.setViewportSize({width:380,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.locator('#memory-import-panel').screenshot({path:resolve(output,'import-history-380.png')});
   assert.equal(await page.locator('[data-import-job=completed] button').count(),0);assert.equal(await page.evaluate(()=>window.deviceCalls),0);assert.equal(external,0);assert.deepEqual(pageErrors,[]);
   assert.equal(fixture.state.writes.length,0);assert.ok(writes.every(w=>['start','pause','resume'].includes(w.action)));
  });
  assert.equal(checks.length,9);await writeFile(resolve(output,'evidence.json'),JSON.stringify({checks,writes,gets,pageErrors,external,deviceCalls:0,paidCalls:0,realImportCalls:0,engine:browser.version(),boundary:'Real management UI in WebKit with synthetic HTTP only; no actual source discovery, memory model, product DB, devices, install or user acceptance.'},null,2));
 }finally{await context.close();await browser.close();await fixture.close();}
});
