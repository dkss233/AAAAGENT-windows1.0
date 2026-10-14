import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {choose} from '../../choice-helper.mjs';

if(!process.env.PLAYWRIGHT_MODULE||!process.env.MANAGEMENT_UI_OUTPUT)throw Error('Use the existing Playwright installation and the assigned evidence directory.');
const playwright=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const browserType=playwright[process.env.BUDGET_BROWSER||'chromium'];if(!browserType)throw Error('Unknown browser type');
const output=resolve(process.env.MANAGEMENT_UI_OUTPUT);await mkdir(output,{recursive:true});
const evidence={kind:'actual management UI with generated HTTP DTOs in headless Chromium',models:0,devices:0,businessDatabase:false,productionGUI:false,cases:[],pageErrors:[],screenshots:[],sourceFingerprints:{}};
for(const file of ['management/ui/views.mjs','management/ui/app.mjs','management/ui/memory-dynamics-view.mjs','management/ui/context-budget-view.mjs','tests/management/ui-fixture.mjs','tests/management/ui.test.mjs','tests/management/ui/context-budget/fixture-budget.mjs','tests/management/ui/context-budget/browser.test.mjs'])evidence.sourceFingerprints[file]=createHash('sha256').update(await readFile(file)).digest('hex');

test('B55 budget controls, public DTOs and unchanged settings safeguards',async t=>{
 const fixture=spawn(process.execPath,['tests/management/ui-fixture.mjs'],{stdio:['ignore','pipe','pipe']});let browser,page;
 try{
   const url=await new Promise((ok,no)=>{let data='';const timer=setTimeout(()=>no(Error('Fixture startup timed out')),5000);fixture.once('exit',()=>{clearTimeout(timer);no(Error('Fixture exited'));});fixture.stdout.on('data',v=>{data+=v;const match=/UI_FIXTURE=(\S+)/.exec(data);if(match){clearTimeout(timer);ok(match[1]);}});});
   browser=await browserType.launch({headless:true});evidence.browser=browser.version();page=await browser.newPage({viewport:{width:1360,height:1000},locale:'zh-CN'});page.setDefaultTimeout(6000);page.on('pageerror',e=>evidence.pageErrors.push(e.message));
   const call=(path,body)=>page.evaluate(async({path,body})=>{const response=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer fixture-session-only','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return response.json();},{path,body});
   const control=body=>call('/fixture/control',body),state=()=>call('/fixture/state');
   const shown=text=>page.getByText(text,{exact:false}).first().waitFor();
   const open=async()=>{await page.goto(url);await page.locator('#nav-overview').waitFor();await control({reset:true});await page.goto('about:blank');await page.goto(url);await page.locator('#context-targetInputTokens').waitFor();};
   const idle=()=>page.locator('#settings-save:not([disabled])').waitFor();
   const shot=async name=>{await page.screenshot({path:resolve(output,name),fullPage:true});evidence.screenshots.push(name);};
   const expandBudget=async label=>{const panel=page.locator('[data-budget-info="'+label+'"]');if(!await panel.evaluate(n=>n.open))await panel.locator(':scope > summary').click();await page.waitForFunction(label=>{const n=[...document.querySelectorAll('[data-budget-info]')].find(n=>n.dataset.budgetInfo===label);return n?.open&&n.dataset.closing===undefined;},label);};
   const check=async(name,fn)=>t.test(name,async()=>{try{await fn();assert.deepEqual(evidence.pageErrors,[]);evidence.cases.push({name,passed:true});}catch(e){evidence.cases.push({name,passed:false,error:e.message});throw e;}});

   await check('default target and independent summary fields; current and saved values remain authoritative',async()=>{
     await open();assert.equal(await page.locator('#context-targetInputTokens').inputValue(),'200000');assert.equal(await page.locator('#context-currentEmotionReserveTokens').inputValue(),'512');
     assert.equal(await page.locator('#context-maxRecentMessages,#context-maxMemories,#context-summaryLimit').count(),0);
     assert.equal(await page.locator('#context-summaryMinMessages').inputValue(),'12');assert.equal(await page.locator('#context-summaryMaxMessages').inputValue(),'24');
     await expandBudget('当前运行预算');await expandBudget('最近保存预算');
     const frozen=await page.locator('[data-budget-info="最近保存预算"]').innerText();await page.locator('#context-targetInputTokens').fill('240000');
     assert.equal(await page.locator('[data-budget-info="最近保存预算"]').innerText(),frozen);assert.equal((await state()).writes.length,0);await shot('budget-settings-desktop.png');
   });
   await check('local invalid inputs and server capacity rejection preserve target draft',async()=>{
     await open();for(const value of ['0','1.5','9007199254740992']){await page.locator('#context-targetInputTokens').fill(value);assert.equal(await page.locator('#settings-save').isDisabled(),true);}
     await page.locator('#context-targetInputTokens').fill('200000');await page.locator('#context-currentEmotionReserveTokens').fill('200001');assert.equal(await page.locator('#settings-save').isDisabled(),true);
     await page.locator('#context-currentEmotionReserveTokens').fill('0');await idle();await control({rejectBudget:true});await page.locator('#settings-save').click();await shown('合成服务：模型容量登记不匹配');await idle();assert.equal(await page.locator('#context-currentEmotionReserveTokens').inputValue(),'0');assert.equal((await state()).writes.length,0);
   });
   await check('save shows pending restart, effective remains unchanged and provider constraints follow saved model',async()=>{
     await open();await page.locator('#context-targetInputTokens').fill('240000');await page.locator('#settings-save').click();await shown('配置已保存为版本');await idle();
     await expandBudget('当前运行预算');await expandBudget('最近保存预算');
     assert.match(await page.locator('[data-budget-info="当前运行预算"]').innerText(),/200,000/);assert.match(await page.locator('[data-budget-info="最近保存预算"]').innerText(),/240,000/);await shown('等待重启后生效');
     const saved=(await state()).settings;assert.equal(saved.effective.context.targetInputTokens,200000);assert.equal(saved.saved.context.targetInputTokens,240000);assert.equal(saved.effectiveRevision,2);assert.equal(saved.pending,true);
     await control({catalog:true});await page.locator('#refresh').click();await page.locator('#refresh:not([disabled])').waitFor();await page.locator('#nav-models').click();await page.locator('#configure-dialogue').click();await choose(page,'#model-dialogue','fixture-dialogue-b');
     assert.equal(await page.locator('#input-limit-dialogue').inputValue(),'64000');assert.equal(await page.locator('input[name="contextWindowTokens"]').count(),0);await page.locator('#settings-save').click();await idle();
     await expandBudget('最近保存预算');const budget=await page.locator('[data-budget-info="最近保存预算"]').innerText();assert.match(budget,/fixture-dialogue-b/);assert.match(budget,/61,440/);assert.match(budget,/总窗口扣除输出预留/);
     assert.equal((await state()).settings.saved.providers.dialogue.credentialRef,'fixture-credential');
   });
   await check('trial shows selected counts above old caps, estimated method, layers and omissions without writes',async()=>{
     await open();await control({budgetRich:true});await page.locator('#nav-memory').click();await page.locator('#memory-context').click();await page.locator('[data-context-budget]').waitFor();
     const body=await page.locator('[data-context-budget]').innerText();assert.match(body,/48 \/ 24/);assert.match(body,/3 \/ 8/);assert.match(body,/6,000 \/ 200,000/);
     await page.locator('[data-context-budget] > details').nth(0).locator(':scope > summary').click();await shown('估算（UTF-8 字节上界）');await shown('whole-request-utf8-v1');
     await page.locator('[data-context-budget] > details').nth(1).locator(':scope > summary').click();for(const text of ['近期完整轮次超出剩余预算','没有匹配线索','低于选入门槛','归属、有效性或遗忘检查未通过','长期记忆超出剩余预算','当前情绪超出预留','历史情绪超出剩余预算','仍有未读取的近期历史'])await shown(text);
     assert.equal((await state()).writes.length,0);await shot('context-trial-desktop.png');await page.setViewportSize({width:360,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('context-trial-narrow.png');await page.setViewportSize({width:1360,height:1000});
   });
   await check('legacy missing report and malformed report never become invented current usage',async()=>{
     await open();await control({legacyBudget:true});await page.locator('#nav-memory').click();await page.locator('#memory-context').click();await shown('该记录未提供预算明细');assert.equal(await page.locator('[data-context-budget]').count(),0);
     await control({legacyBudget:false,contextBudget:{version:'9.0.0'}});await page.getByRole('button',{name:'试算当前上下文',exact:true}).click();await shown('预算明细格式不匹配');assert.equal(await page.locator('[data-context-budget]').count(),0);assert.equal((await state()).writes.length,0);
   });
   await check('late trial and foreign records cannot replace current query or role',async()=>{
     await open();await page.locator('#nav-memory').click();await page.locator('#memory-context').click();await page.locator('[data-context-budget]').waitFor();await control({delayContext:350});
     await page.locator('#context-query').fill('旧问题');await page.getByRole('button',{name:'试算当前上下文',exact:true}).click();await control({delayContext:0});await page.locator('#context-query').fill('新问题');
     // The same public read entry is callable when replacing an in-flight trial.
     await page.evaluate(()=>document.querySelector('#context-query').form.requestSubmit());await page.getByText('新问题',{exact:true}).waitFor();await page.waitForTimeout(450);assert.equal(await page.getByText('旧问题',{exact:true}).count(),0);
     await control({foreignContext:true});await page.getByRole('button',{name:'试算当前上下文',exact:true}).click();await shown('上下文包含其他角色');assert.equal(await page.getByText('retired',{exact:true}).count(),0);assert.equal((await state()).writes.length,0);
   });
   await check('public effective DTO overrides local arithmetic and unknown model window stays explicit',async()=>{
     await open();const custom={targetInputTokens:200000,apiInputLimit:45000,contextWindowTokens:null,reservedOutputTokens:4096,effectiveInputTokens:45000,constrainedBy:['api_input'],counting:{method:'model_tokenizer',estimated:false,model:'fixture-dialogue-a',version:'matched-v2'}};
     await control({effectiveBudget:custom});await page.locator('#refresh').click();await page.locator('#refresh:not([disabled])').waitFor();await expandBudget('当前运行预算');const body=await page.locator('[data-budget-info="当前运行预算"]').innerText();assert.match(body,/45,000/);assert.match(body,/未登记；按接口输入容量约束/);assert.match(body,/fixture-dialogue-a/);assert.match(body,/matched-v2/);
     await page.setViewportSize({width:360,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('budget-settings-narrow.png');await page.setViewportSize({width:1360,height:1000});assert.equal((await state()).writes.length,0);
     await control({effectiveBudget:{...custom,counting:{...custom.counting,model:'foreign-model'}}});await page.locator('#refresh').click();await page.locator('#refresh:not([disabled])').waitFor();assert.match(await page.locator('[data-budget-info="当前运行预算"]').innerText(),/服务未提供当前模型的完整预算信息/);assert.doesNotMatch(await page.locator('[data-budget-info="当前运行预算"]').innerText(),/45,000|foreign-model/);
   });
   await check('offline and expired authorization preserve unsaved budget and prompt drafts',async()=>{
     await open();await page.locator('#context-targetInputTokens').fill('220000');await page.locator('#nav-memory').click();await page.locator('#memory-prompt').click();await page.locator('#prompt-text').waitFor();await page.locator('#prompt-text').fill('预算保存前保留的设定草稿');await page.locator('#nav-overview').click();
     await control({offline:true});await page.locator('#refresh').click();await shown('连接中断');assert.equal(await page.locator('#context-targetInputTokens').inputValue(),'220000');assert.equal(await page.locator('#settings-save').isDisabled(),true);
     await control({offline:false,unauthorized:true});await page.locator('#refresh').click();await page.locator('#session').waitFor();assert.equal(await page.locator('#context-targetInputTokens').inputValue(),'220000');
     await control({unauthorized:false});await page.locator('#session').fill('fixture-session-only');await page.evaluate(()=>document.querySelector('#session').form.requestSubmit());await page.locator('#session').waitFor({state:'detached'});await idle();assert.equal(await page.locator('#context-targetInputTokens').inputValue(),'220000');
     await page.locator('#nav-memory').click();await page.locator('#memory-prompt').click();await page.locator('#prompt-text').waitFor();assert.equal(await page.locator('#prompt-text').inputValue(),'预算保存前保留的设定草稿');assert.equal((await state()).writes.length,0);
   });
   await check('original management UI regression retains conflicts, drafts, credentials and rollback',async()=>{
     await open();const result=await page.evaluate(async()=>{const {runUIChecks}=await import('/ui.test.mjs');return runUIChecks();});assert.equal(result.failed,0);evidence.originalUI=result;
   });
 }finally{
   await writeFile(resolve(output,'budget-ui-verification.json'),JSON.stringify(evidence,null,2)+'\n');await browser?.close();if(fixture.exitCode===null){fixture.kill('SIGTERM');await once(fixture,'exit');}
 }
});
