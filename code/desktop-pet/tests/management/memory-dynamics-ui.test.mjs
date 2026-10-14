import {choose,choiceValue} from './choice-helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createMemoryDynamicsFixture} from './memory-dynamics-fixture.mjs';
import {fixtureReport} from './ui/context-budget/fixture-budget.mjs';
const playwrightPath=process.env.PLAYWRIGHT_MODULE;
if(!playwrightPath)throw new Error('Set PLAYWRIGHT_MODULE to the existing Playwright installation; this test never downloads a browser.');
const {chromium}=await import(pathToFileURL(playwrightPath));
const output=process.env.MANAGEMENT_UI_OUTPUT?resolve(process.env.MANAGEMENT_UI_OUTPUT):resolve(fileURLToPath(new URL('../../../../',import.meta.url)),'artifacts/W1/memory-dynamics-01');
await mkdir(output,{recursive:true});
const evidence={sourceFingerprints:{},kind:'isolated synthetic HTTP + real headless Chromium UI',realDatabase:false,providerCalls:0,deviceTests:false,cases:[],screenshots:[]};

for(const file of ['management/ui/dom.mjs','management/ui/app.mjs','management/ui/views.mjs','management/ui/style.css','management/ui/memory-dynamics-view.mjs','management/ui/context-budget-view.mjs','tests/management/memory-dynamics-fixture.mjs','tests/management/memory-dynamics-ui.test.mjs'])evidence.sourceFingerprints[file]=createHash('sha256').update(await readFile(new URL('../../'+file,import.meta.url))).digest('hex');

test('memory dynamics UI: versioned reads, honest traces, guarded writes and narrow layout',async t=>{
 const fixture=await createMemoryDynamicsFixture(),browser=await chromium.launch({headless:true});
 evidence.browserVersion=browser.version();
 const context=await browser.newContext({viewport:{width:1360,height:1000},locale:'zh-CN'}),page=await context.newPage();
 page.setDefaultTimeout(6000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const shown=async text=>{await page.getByText(text,{exact:false}).first().waitFor();};
 const open=async(section='dynamics')=>{fixture.reset();errors.length=0;await page.goto('about:blank');await page.goto(fixture.url);await page.locator('#nav-memory').click();await page.locator('[data-md-record="memory-missing"]').waitFor();if(section!=='dynamics'){await page.locator('#memory-'+section).click();await page.waitForFunction(()=>!document.querySelector('.memory-dynamics')?.textContent.includes('读取中…'));} };
 const policyReady=async()=>{await page.locator('#memory-policy').click();await page.locator('#md-policy-refresh:not([disabled])').waitFor();};
 const shot=async name=>{await page.waitForTimeout(250);await page.screenshot({path:resolve(output,name),fullPage:true});evidence.screenshots.push(name);};
 const check=async(name,fn)=>t.test(name,async()=>{await fn();assert.deepEqual(errors,[]);evidence.cases.push({name,status:'passed'});});
 try{
 await check('read/search/pagination preserve state and distinguish missing, invalid and observed zero',async()=>{
   await open();const fingerprint=JSON.stringify(fixture.state.items);
   await page.locator('[data-md-record="memory-missing"]').click();await shown('暂无有效情绪信息');assert.equal(await page.locator('.md-meter').filter({hasText:'情绪影响'}).locator('strong').innerText(),'—');assert.equal(await page.locator('.md-meter').filter({hasText:'情绪影响'}).locator('meter').count(),0);await shown('source-park · v1');assert.doesNotMatch(await page.locator('.memory-dynamics').innerText(),/\bnull\b/);
   await page.locator('[data-md-record="memory-observed"]').click();await shown('有强度观测：0.0%');assert.equal(await page.locator('.md-meter').filter({hasText:'情绪影响'}).locator('strong').innerText(),'0.0%');assert.equal(await page.locator('.md-meter').filter({hasText:'情绪影响'}).locator('meter').evaluate(n=>n.value),0);
   await page.locator('[data-md-record="memory-invalid"]').click();await shown('情绪信息无效');assert.equal(await page.locator('.md-meter').filter({hasText:'情绪影响'}).locator('strong').innerText(),'—');assert.equal(await page.locator('.md-meter').filter({hasText:'情绪影响'}).locator('meter').count(),0);
   await page.locator('#md-records-next').click();await page.locator('[data-md-record="memory-extra-18"]').waitFor();
   await page.locator('#md-records-prev').click();await page.locator('[data-md-record="memory-missing"]').waitFor();
   await page.locator('#md-query').fill('公园');await page.locator('#md-search').click();await page.waitForFunction(()=>document.querySelectorAll('[data-md-record]').length===4);
   assert.equal(fixture.state.writes.length,0);assert.equal(JSON.stringify(fixture.state.items),fingerprint);assert.equal(await page.evaluate(()=>window.unsafeRendered),undefined);
 });
 await check('source fragments keep raw correction and no unsupported forget/restore actions',async()=>{
   await open('fragments');await page.locator('[data-md-record="source-park"]').click();await shown('该内容没有记忆动态评估');assert.equal(await page.locator('#md-record-action').count(),0);
   await page.locator('#md-edit-record').click();await page.locator('#record-text').waitFor();assert.match(await page.locator('#record-text').inputValue(),/合成来源原文/);
   await page.locator('#memory-prompt').click();await page.locator('#prompt-text').waitFor();
   await page.locator('#memory-context').click();await shown('当前上下文试算 · 非实际历史');assert.equal(fixture.state.writes.length,0);
 });
 await check('cross-page source lookup checks exact ID and reports changed or missing versions',async()=>{
   await open();const memory=fixture.state.items.find(i=>i.record.id==='memory-missing');memory.record.sources=[{id:'memory-extra-18',version:1}];fixture.state.items.find(i=>i.record.id==='memory-extra-18').record.version=2;fixture.state.items.find(i=>i.record.id==='memory-extra-18').dynamics.recordVersion=2;
   await page.locator('#md-search').click();await page.locator('[data-md-record="memory-missing"]').click();await page.locator('[data-md-source="memory-extra-18"]').click();await shown('引用的是版本 1，当前可读版本为 2');assert.equal(await page.locator('[data-md-record="memory-extra-18"]').count(),1);
   assert.ok(fixture.state.requests.some(r=>r.path==='/api/memory/dynamics'&&r.search.includes('query=memory-extra-18')&&r.search.includes('state=all')));
   await open();fixture.state.items.find(i=>i.record.id==='memory-missing').record.sources=[{id:'unavailable-source',version:1}];fixture.state.items[2].record.text='其他正文只是提及 unavailable-source';
   await page.locator('#md-search').click();await page.locator('[data-md-record="memory-missing"]').click();await page.locator('[data-md-source="unavailable-source"]').click();await shown('没有取得该标识的来源记录');assert.equal(await page.locator('#md-record-action').count(),0);assert.equal(fixture.state.writes.length,0);
 });
 await check('actual trace statuses and frozen versions are distinct from current prediction',async()=>{
   await open('traces');await shown('已组装 · 未确认用于模型输入');await shown('已用于模型输入');await shown('已失效 · 不再代表有效上下文');
   await page.locator('.memory-dynamics details summary').first().click();await shown('排序分 P');await shown('0.828');
   assert.match(await page.locator('.memory-dynamics').innerText(),/7 \/ 1/);
   await shot('actual-traces-desktop.png');
   await page.locator('#md-traces-next').click();await shown('trace-11');assert.equal(fixture.state.writes.length,0);
 });
 await check('budget reports retain actual turns and methods; legacy traces stay unavailable',async()=>{
   await open('traces');
   const report=fixtureReport(fixture.budget),tokenizer={...structuredClone(report),counting:{method:'model_tokenizer',estimated:false,model:'synthetic-matching-model',version:'synthetic-tokenizer-v1'}};
   for(const [i,b] of [[0,report],[1,tokenizer]])Object.assign(fixture.state.traces[i],{contextBudget:b,countedInputTokens:b.countedInputTokens,inputTokenBudget:b.effectiveInputTokens});
   fixture.state.traces[2].candidates[1].omission='limit';
   await page.locator('#md-traces-refresh').click();await page.locator('[data-context-budget]').first().waitFor();
   assert.equal(await page.locator('[data-context-budget]').count(),2);
   const first=page.locator('.memory-dynamics .card').filter({hasText:'trace-0'}).first();
   assert.match(await first.innerText(),/48 \/ 24/);assert.match(await first.innerText(),/3 \/ 8/);assert.match(await first.innerText(),/轮次 turn-0/);
   await first.locator('[data-context-budget] details').first().locator('summary').click();await shown('估算（UTF-8 字节上界）');await shown('whole-request-utf8-v1');
   await first.locator('[data-context-budget] > details').nth(1).locator(':scope > summary').click();await shown('近期完整轮次超出剩余预算');await shown('仍有未读取的近期历史');
   const second=page.locator('.memory-dynamics .card').filter({hasText:'trace-1'}).first();await second.locator('[data-context-budget] details').first().locator('summary').click();await shown('synthetic-tokenizer-v1');
   await shown('该记录未提供预算明细');await shown('历史计数 / 容量（方法未记录）');
   const third=page.locator('.memory-dynamics .card').filter({hasText:'trace-2'}).first();await third.locator(':scope > details').locator(':scope > summary').click();await shown('历史条数限制');
   await shot('budget-traces-desktop.png');await page.setViewportSize({width:360,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('budget-traces-narrow.png');await page.setViewportSize({width:1360,height:1000});assert.equal(fixture.state.writes.length,0);
 });
 await check('malformed actual budget metadata is rejected without inventing counts',async()=>{
   await open('traces');const report=fixtureReport(fixture.budget);report.layers.required++;
   Object.assign(fixture.state.traces[0],{contextBudget:report,countedInputTokens:report.countedInputTokens,inputTokenBudget:report.effectiveInputTokens});
   await page.locator('#md-traces-refresh').click();await shown('实际召回轨迹格式或归属不匹配');assert.equal(await page.locator('[data-context-budget]').count(),0);assert.equal(fixture.state.writes.length,0);
 });
 await check('future preview is pure and invalidates immediately when input changes',async()=>{
   await open();await policyReady();const fingerprint=JSON.stringify({items:fixture.state.items,traces:fixture.state.traces,policy:fixture.state.policy});
   await page.locator('#md-preview-query').fill('公园');await page.locator('#md-preview-run').click();await page.locator('#md-preview-result').waitFor();await shown('冻结的数据 / 策略版本');
   const request=fixture.state.requests.find(r=>r.path==='/api/memory/preview');assert.ok(Date.parse(request.body.evaluatedAt)>Date.now()+6*86400000);assert.equal(request.body.expectedDataRevision,8);
   await shot('policy-preview-desktop.png');
   await page.locator('#md-policy-baseHalfLifeDays').fill('40');assert.equal(await page.locator('#md-preview-result').count(),0);
   await page.locator('#md-preview-run').click();await page.locator('#md-preview-result').waitFor();
   await page.locator('#md-preview-query').fill('课程');assert.equal(await page.locator('#md-preview-result').count(),0);
   await choose(page,'#md-preview-horizon','now');await page.locator('#md-preview-run').click();await page.locator('#md-preview-result').waitFor();assert.equal(fixture.state.requests.filter(r=>r.path==='/api/memory/preview').at(-1).body.evaluatedAt,'now');
   assert.equal(fixture.state.writes.length,0);assert.equal(JSON.stringify({items:fixture.state.items,traces:fixture.state.traces,policy:fixture.state.policy}),fingerprint);
 });
 await check('late preview and mismatched frozen version never become a displayed result',async()=>{
   await open();await policyReady();fixture.state.controls.delayPreview=300;
   await page.locator('#md-preview-query').fill('公园');await page.locator('#md-preview-run').click();await page.locator('#md-preview-query').fill('课程');
   await page.waitForTimeout(400);assert.equal(await page.locator('#md-preview-result').count(),0);
   fixture.state.controls.delayPreview=0;fixture.state.controls.previewWrongVersion=true;
   await page.locator('#md-preview-run').click();await shown('试算回执版本或时点不匹配');assert.equal(await page.locator('#md-preview-result').count(),0);
 });
 await check('invalid policy is blocked locally; save creates a forward-effective version',async()=>{
   await open();await policyReady();await page.locator('#md-policy-baselineWeight').fill('0.60');assert.equal(await page.locator('#md-policy-save').isDisabled(),true);assert.equal(await page.locator('#md-preview-run').isDisabled(),true);
   await page.locator('#md-policy-baselineWeight').fill('0.55');await page.locator('#md-policy-baseHalfLifeDays').fill('40');
   await page.locator('#md-policy-save').click();await shown('策略已保存为版本 3');assert.equal(fixture.state.policy.policy.baseHalfLifeDays,40);assert.equal(fixture.state.writes.length,1);assert.equal(fixture.state.items[0].dynamics.activation,.81);
   assert.equal(await page.locator('#md-policy-save').isDisabled(),true);
 });
 await check('policy conflict retains draft and requires comparison before saving latest revision',async()=>{
   await open();await policyReady();await page.locator('#md-policy-baseHalfLifeDays').fill('40');fixture.state.controls.policyConflict=true;
   await page.locator('#md-policy-save').click();await page.locator('#md-policy-review:not([disabled])').waitFor();assert.equal(fixture.state.writes.length,0);assert.equal(await page.locator('#md-policy-baseHalfLifeDays').inputValue(),'40');assert.equal(await page.locator('#md-policy-save').isDisabled(),true);await shown('最新版本 3');
   await page.locator('#md-policy-review').click();await page.locator('#md-policy-save').click();await shown('策略已保存为版本 4');assert.equal(fixture.state.writes[0].body.expectedRevision,3);
 });
 await check('rollback is explicit, produces a new policy version and never restores deleted memory',async()=>{
   await open();await policyReady();await page.locator('#md-policy-baseHalfLifeDays').fill('40');await page.locator('[data-md-rollback="1"]').click();assert.equal(fixture.state.writes.length,0);
   await page.locator('#md-confirm-rollback').click();await shown('生成新版本 3');assert.equal(fixture.state.policy.restoredFromRevision,1);assert.equal(fixture.state.policy.policy.baseHalfLifeDays,25);assert.equal(fixture.state.items.find(i=>i.record.id==='memory-deleted').record.state,'deleted');
 });
 await check('shared-source rejection has zero writes and no successful forgotten display',async()=>{
   await open();await page.locator('[data-md-record="memory-shared"]').click();await page.locator('#md-reason').fill('合成测试');await page.locator('#md-record-action').click();assert.equal(fixture.state.writes.length,0);
   await page.locator('#md-confirm-record').click();await shown('共享混合来源暂不支持遗忘');assert.equal(fixture.state.writes.length,0);assert.doesNotMatch(await page.locator('.memory-dynamics').innerText(),/遗忘已确认/);assert.equal(fixture.state.items.find(i=>i.record.id==='memory-shared').record.state,'active');
 });
 await check('confirmed forgetting and restore use record versions and explicit reason',async()=>{
   await open();await page.locator('[data-md-record="memory-missing"]').click();await page.locator('#md-reason').fill('合成测试遗忘');await page.locator('#md-record-action').click();await page.locator('#md-confirm-record').click();await shown('遗忘已确认');await page.waitForFunction(()=>!document.querySelector('[data-md-record="memory-missing"]'));
   await choose(page,'#md-state','all');await page.locator('[data-md-record="memory-missing"]').waitFor();await page.locator('[data-md-record="memory-missing"]').click();await shown('恢复这条内容');await page.locator('#md-reason').fill('合成测试恢复');await page.locator('#md-record-action').click();await page.locator('#md-confirm-record').click();await shown('恢复已确认');
   assert.deepEqual(fixture.state.writes.map(w=>w.body.expectedVersion),[1,2]);assert.deepEqual(fixture.state.writes.map(w=>w.body.reason),['合成测试遗忘','合成测试恢复']);
 });
 await check('failed and malformed save acknowledgments never claim success',async()=>{
   await open();await policyReady();await page.locator('#md-policy-baseHalfLifeDays').fill('40');fixture.state.controls.failWrite=true;await page.locator('#md-policy-save').click();await shown('合成失败：策略未保存');assert.equal(fixture.state.writes.length,0);assert.doesNotMatch(await page.locator('.memory-dynamics').innerText(),/策略已保存为版本/);
   fixture.state.controls.failWrite=false;await page.locator('#md-policy-refresh').click();await page.locator('#md-policy-save:not([disabled])').waitFor();fixture.state.controls.badAck=true;await page.locator('#md-policy-save').click();await shown('保存回执不匹配');assert.doesNotMatch(await page.locator('.memory-dynamics').innerText(),/策略已保存为版本/);assert.equal(await page.locator('#md-policy-save').isDisabled(),true);
 });
 await check('changed data requires refresh before preview; older/foreign snapshots fail closed',async()=>{
   await open();await policyReady();fixture.state.dataRevision++;await page.locator('#md-preview-run').click();await shown('试算依据已变化');assert.equal(await page.locator('#md-preview-run').isDisabled(),true);
   await page.locator('#md-policy-refresh').click();await page.locator('#md-preview-run:not([disabled])').waitFor();fixture.state.controls.oldRevision=true;await page.locator('#md-policy-refresh').click();await shown('读到了较旧的记忆版本');assert.equal(await page.locator('#md-policy-save').isDisabled(),true);
   await open();fixture.state.controls.foreign=true;await page.locator('#md-search').click();await shown('记忆记录归属或格式不匹配');assert.equal(await page.getByText('retired',{exact:true}).count(),0);
 });
 await check('newer search wins over late results',async()=>{
   await open();fixture.state.controls.delayData=350;await page.locator('#md-query').fill('公园');await page.locator('#md-search').click();fixture.state.controls.delayData=0;await page.locator('#md-query').fill('课程');await page.locator('#md-search').click();await page.waitForFunction(()=>document.querySelectorAll('[data-md-record]').length===1);await page.waitForTimeout(450);assert.equal(await page.locator('[data-md-record="memory-observed"]').count(),1);assert.equal(await page.locator('[data-md-record="source-park"]').count(),0);
 });
 await check('expired authorization disables writes and ignores a late write reply',async()=>{
   await open();await policyReady();await page.locator('#md-policy-baseHalfLifeDays').fill('40');fixture.state.controls.delayWrite=500;await page.locator('#md-policy-save').click();
   fixture.state.controls.unauthorized=true;await page.locator('#refresh').click();await page.locator('#session').waitFor();await page.waitForTimeout(600);assert.doesNotMatch(await page.locator('.memory-dynamics').innerText(),/策略已保存为版本/);assert.equal(await page.locator('#md-policy-save').isDisabled(),true);await shown('等待本机授权');
 });
 await check('instance replacement retains policy draft but requires fresh version comparison',async()=>{
   await open();await policyReady();await page.locator('#md-policy-baseHalfLifeDays').fill('40');fixture.state.controls.instanceId='synthetic-replacement';fixture.state.dataRevision=1;fixture.state.policy=policyVersionForTest();fixture.state.history=[fixture.state.policy];
   await page.locator('#refresh').click();await shown('连接已更新。未保存编辑已保留');await page.locator('#memory-policy').click();await page.locator('#md-policy-review:not([disabled])').waitFor();assert.equal(await page.locator('#md-policy-baseHalfLifeDays').inputValue(),'40');assert.equal(await page.locator('#md-policy-save').isDisabled(),true);await shown('最新版本 1');
 });
 await check('maintenance reports actual failure and all memory sections fit a 360px viewport',async()=>{
   await open('maintenance');await shown('合成维护失败，未提交更新');await shown('不代表所有维护都已完成');
   await page.setViewportSize({width:360,height:900});
   for(const section of ['dynamics','fragments','policy','traces','maintenance']){
     await page.locator('#memory-'+section).click();await page.waitForTimeout(60);
     assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),section+' overflows viewport');
     if(section==='dynamics'){await page.locator('[data-md-record="memory-missing"]').click();await shot('memory-overview-narrow.png');}
     if(section==='policy')await shot('memory-policy-narrow.png');
   }
   await page.setViewportSize({width:1360,height:1000});await page.locator('#memory-dynamics').click();
   const controls=await page.locator('#md-query,#md-state,#md-search').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {height:r.height,bottom:r.bottom};}));assert.ok(Math.max(...controls.map(c=>c.height))-Math.min(...controls.map(c=>c.height))<1,'search controls share height');assert.ok(Math.max(...controls.map(c=>c.bottom))-Math.min(...controls.map(c=>c.bottom))<1,'search controls share baseline');await page.locator('[data-md-record="memory-missing"]').click();await shot('memory-overview-desktop.png');
 });
 }finally{
   evidence.pageErrors=errors;await writeFile(resolve(output,'ui-verification.json'),JSON.stringify(evidence,null,2)+'\n');await context.close();await browser.close();await fixture.close();
 }
});
function policyVersionForTest(){return {revision:1,effectiveAt:'2026-09-12T00:00:00.000Z',policy:{baseHalfLifeDays:30,emotionHalfLifeDays:7,baselineWeight:.55,activationWeight:.25,importanceWeight:.15,emotionWeight:.05},restoredFromRevision:null};}
