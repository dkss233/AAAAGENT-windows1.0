import {choose as chooseControl} from '../choice-helper.mjs';
// Actual management UI against synthetic forwarding receipts only. Never calls the existing App.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMemoryDynamicsFixture} from '../memory-dynamics-fixture.mjs';
const engines=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const output=resolve(process.env.MANAGEMENT_UI_OUTPUT);await mkdir(output,{recursive:true});
for(const engine of ['chromium','webkit'])test(engine+' existing task forwarding and reviewed labels',async t=>{
 const fixture=await createMemoryDynamicsFixture(),browser=await engines[engine].launch({headless:true});
 const context=await browser.newContext({viewport:{width:1360,height:1000},locale:'zh-CN',recordVideo:process.env.TASKS_CAPTURE==='1'&&engine==='chromium'?{dir:output,size:{width:1360,height:1000}}:undefined});
 const page=await context.newPage();page.setDefaultTimeout(5000);
 const stamp='2026-09-14T02:00:00.000Z';
 const state={requests:[],calls:[],confirms:[],refreshes:[],connection:{harness:'ready',codex:'compatible',preset:'ready'},offline:false,unauthorized:false,invalidTargets:false,delayPrepare:0,dropConfirm:false,conflictConfirm:false,refreshPhase:'accepted',projects:[{id:'project-a',name:'同名课程项目',abstract:'隔离演示摘要',detailRef:{rootPath:'/synthetic/course',entryFile:'docs/README.md'},codexTarget:{hostId:'local',threadId:'existing-a'},version:1,updatedAt:stamp}]};
 const targets=Array.from({length:16},(_,i)=>({threadId:'existing-'+(i===0?'a':i===1?'b':i),hostId:'local',title:i<2?'同名现有任务':'合成任务 '+i,projectPath:'/synthetic/tasks/'+i}));
 await page.route('**/api/tasks**',async route=>{
  const req=route.request(),u=new URL(req.url()),path=u.pathname,body=req.postDataJSON();state.calls.push({path,body,method:req.method(),query:u.search});
  assert.equal(req.headers().authorization,'Bearer memory-dynamics-synthetic-session');
  const reply=(status,data)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  const fail=(status,message)=>reply(status,{error:{code:status===409?'version_conflict':'unavailable',message}});
  if(state.offline)return fail(503,'转发服务暂不可用');if(state.unauthorized)return fail(401,'本机会话已失效');
  if(path==='/api/tasks')return reply(200,{connection:state.connection,requests:structuredClone(state.requests)});
  if(path==='/api/tasks/targets')return reply(200,{items:state.invalidTargets?[{...targets[0],hostId:'remote'}]:targets.filter(x=>x.title.includes(u.searchParams.get('query')||''))});
  if(path==='/api/tasks/prepare'){
   assert.equal(body.target.hostId,'local');const project=state.projects.find(p=>p.id===body.projectId);
   if(body.projectId&&project?.version!==body.projectVersion)return fail(409,'项目资料已更新');
   const r={id:'request-'+state.requests.length,version:1,phase:'awaiting_confirmation',text:body.text,target:body.target,...(project?{project:{id:project.id,name:project.name,version:project.version,detailRef:project.detailRef}}:{}),createdAt:stamp};state.requests.unshift(r);
   if(state.delayPrepare)await new Promise(r=>setTimeout(r,state.delayPrepare));return reply(200,r);
  }
  const r=state.requests.find(x=>x.id===body.id);assert.ok(r);
  if(path==='/api/tasks/confirm'){
   state.confirms.push(body);assert.deepEqual(Object.keys(body).sort(),['expectedVersion','id']);
   if(state.conflictConfirm){state.conflictConfirm=false;r.version++;return fail(409,'确认记录变化');}
   if(r.phase==='awaiting_confirmation'){assert.equal(r.version,body.expectedVersion);r.phase='accepted';r.version++;r.confirmedAt=stamp;if(r.executor==='harness')r.harnessSessionId='fixture-session-'+r.id;else r.appTurnId='actual-fixture-turn-'+r.id;}
   if(state.dropConfirm)return route.abort('failed');return reply(200,r);
  }
  if(path==='/api/tasks/refresh'){
   state.refreshes.push(body);assert.deepEqual(Object.keys(body),['id']);r.version++;r.phase=state.refreshPhase;
   if(r.phase==='completed')r.result='<img src=x onerror="window.unsafe=true">\n'+('合成任务返回的长内容，仅用于任务页。\n'.repeat(50));
   return reply(200,r);
  }
  throw Error('Unexpected task route '+path);
 });
 await page.route('**/api/projects**',async route=>{
  const u=new URL(route.request().url());state.calls.push({path:u.pathname,method:route.request().method(),query:u.search});assert.equal(route.request().method(),'GET');
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(u.pathname==='/api/projects'?{items:state.projects,total:1,offset:0,limit:25}:state.projects[0])});
 });
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const click=id=>page.locator('#'+id).click(),body=()=>page.locator('body').innerText();
 const enabled=id=>page.waitForFunction(id=>document.getElementById(id)&&!document.getElementById(id).disabled,id);
 const settled=async()=>{await enabled('tasks-refresh');await page.waitForTimeout(60)};
 const choose=async id=>{await page.locator('[data-task-target="'+id+'"]').click()};
 const refresh=async()=>{await click('tasks-refresh');await page.waitForFunction(()=>document.querySelector('#session')||!document.querySelector('#tasks-refresh')?.disabled)};
 const checks=[];
 try{
 await page.goto(fixture.url);await page.waitForFunction(()=>document.body.innerText.includes('管理服务已连接'));
 await t.test('lazy reads, independent real capability labels, local targets, no default target',async()=>{
  assert.equal(state.calls.length,0);await click('nav-tasks');await settled();assert.ok(await page.locator('#tasks-prepare').isDisabled());assert.equal(state.calls.filter(c=>c.path==='/api/projects').length,0);
  await choose('existing-b');assert.ok((await body()).includes('已选：同名现有任务 · existing-b'));
  state.connection.harness='authentication_required';await refresh();assert.ok((await body()).includes('需要认证'));assert.ok((await body()).includes('管理服务已连接'));assert.ok(await page.locator('#tasks-prepare').isDisabled());
  state.connection.harness='ready';state.invalidTargets=true;await refresh();assert.ok(await page.locator('#tasks-prepare').isDisabled());state.invalidTargets=false;await refresh();
  checks.push('no automatic reads before navigation/project expansion; local-only verified targets; explicit duplicate-name selection; management connectivity is independent');
 });
 await t.test('project detail/version and final body shown once; cancel/focus; double confirm one POST',async()=>{
  await choose('existing-b');await click('task-project-toggle');await page.waitForSelector('#task-project');await chooseControl(page,'#task-project','project-a');await page.waitForFunction(()=>document.querySelector('.task-project-binding').textContent.includes('/synthetic/course'));
  const text='请分析这个项目的方案。\n'+('保留这一段完整的最终正文。\n'.repeat(65));await page.locator('#task-text').fill(text);await click('tasks-prepare');await page.waitForSelector('#task-confirm-dialog[open]');
  assert.equal(state.confirms.length,0);assert.equal(await page.locator('#task-final-text').textContent(),text);const content=await page.locator('#task-confirm-dialog').innerText();assert.ok(content.includes('existing-b')&&content.includes('同名课程项目')&&content.includes('/synthetic/course')&&content.includes('docs/README.md'));
  assert.equal(await page.locator('#task-confirm-back').evaluate(n=>n===document.activeElement),true);await page.keyboard.press('Escape');assert.equal(await page.locator('#task-confirm-dialog').count(),0);assert.equal(await page.locator('#tasks-prepare').evaluate(n=>n===document.activeElement),true);
  const prepared=state.calls.filter(c=>c.path.endsWith('/prepare')).length;await click('tasks-prepare');await page.waitForSelector('#task-confirm-dialog[open]');assert.equal(state.calls.filter(c=>c.path.endsWith('/prepare')).length,prepared);
  // A real modal, full body scroll, keyboard focus trap and a reviewable narrow screenshot.
  await page.locator('#task-final-text').focus();await page.keyboard.press('PageDown');await page.waitForTimeout(220);assert.ok(await page.locator('#task-final-text').evaluate(n=>n.scrollTop)>0);
  await page.screenshot({path:resolve(output,engine+'-confirmation-wide.png')});await page.setViewportSize({width:360,height:900});await page.screenshot({path:resolve(output,engine+'-confirmation-narrow.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(()=>{document.querySelector('#task-confirm-send').click();document.querySelector('#task-confirm-send')?.click()});await settled();assert.equal(state.confirms.length,1);assert.ok((await body()).includes('已接收 · 尚未确认完成'));assert.ok(await page.locator('#tasks-prepare').isDisabled());
  assert.equal(state.calls.find(c=>c.path.endsWith('/prepare')).body.projectVersion,1);await page.setViewportSize({width:1360,height:1000});checks.push('project exact version/entry, full confirmed body, Escape and focus, real modal scrolling, one confirm, acceptance not completion');
 });
 await t.test('edits require new confirmation and late prepare never confirms an altered draft',async()=>{
  await page.locator('#task-text').fill('第二份工作正文');await enabled('tasks-prepare');await click('tasks-prepare');await page.waitForSelector('#task-confirm-dialog[open]');await click('task-confirm-back');await choose('existing-a');await page.locator('#task-text').fill('第三份正文');
  state.delayPrepare=150;await click('tasks-prepare');await page.evaluate(()=>{const n=document.querySelector('#task-text');n.value='准备期间变更的草稿';n.dispatchEvent(new Event('input',{bubbles:true}))});await settled();state.delayPrepare=0;
  assert.equal(await page.locator('#task-confirm-dialog').count(),0);assert.equal(state.confirms.length,1);assert.equal(await page.locator('#task-text').inputValue(),'准备期间变更的草稿');
  checks.push('changed target/text needs a new preparation; late prepare cannot open confirmation for another draft');
 });
 await t.test('lost confirm response and unknown refresh never resend or cancel',async()=>{
  await click('tasks-prepare');await page.waitForSelector('#task-confirm-dialog[open]');state.dropConfirm=true;state.offline=true;
  // Allow the confirm itself; make the snapshot fail after the accepted response is lost.
  state.offline=false;const wait=page.waitForRequest('**/api/tasks/confirm');await click('task-confirm-send');await wait;
  await settled();state.dropConfirm=false;const count=state.confirms.length;assert.equal(count,2);
  const id=state.requests[0].id;state.requests[0].phase='unknown';state.refreshPhase='unknown';await refresh();await page.locator('[data-task-request="'+id+'"]').click();await click('task-refresh-receipt');await enabled('task-refresh-receipt');assert.ok((await body()).includes('结果未知'));assert.equal(state.confirms.length,count);
  await click('nav-projects');await click('nav-tasks');await settled();assert.equal(state.confirms.length,count);assert.ok(state.calls.every(c=>!c.path.includes('cancel')));checks.push('unknown record refresh is status-only; navigation does not resend or cancel');
 });
 await t.test('exact completion is task-only plain text; disabled services keep draft and old status',async()=>{
  state.refreshPhase='completed';await click('task-refresh-receipt');await enabled('task-refresh-receipt');assert.ok((await body()).includes('已完成'));assert.equal(await page.locator('.tasks-page img').count(),0);assert.ok((await page.locator('#task-result').innerText()).includes('<img src=x'));
  assert.equal(fixture.state.writes.length,0);await page.locator('#task-text').fill('断线保留草稿');state.offline=true;await refresh();assert.ok(await page.locator('#tasks-prepare').isDisabled());assert.equal(await page.locator('#task-text').inputValue(),'断线保留草稿');assert.ok((await body()).includes('上次回执'));
  state.offline=false;await refresh();await page.locator('#task-text').focus();await page.locator('#task-text').evaluate(n=>n.setSelectionRange(2,5));await page.evaluate(()=>document.querySelector('#refresh').click());await settled();
  assert.deepEqual(await page.locator('#task-text').evaluate(n=>[n===document.activeElement,n.selectionStart,n.selectionEnd]),[true,2,5]);
  await page.locator('#task-result').focus();await page.keyboard.press('PageDown');await page.waitForTimeout(220);assert.ok(await page.locator('#task-result').evaluate(n=>n.scrollTop)>0);
  await page.screenshot({path:resolve(output,engine+'-receipts-wide.png'),fullPage:true});await page.setViewportSize({width:360,height:900});await page.screenshot({path:resolve(output,engine+'-receipts-narrow.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.emulateMedia({reducedMotion:'reduce'});await click('nav-overview');await click('nav-tasks');await settled();assert.equal(await page.evaluate(()=>document.getAnimations().length),0);await page.setViewportSize({width:1360,height:1000});checks.push('exact result only in task details, no HTML or companion writes, offline draft, refresh caret, real result scroll and reduced motion');
 });
 await t.test('project version change and confirmation conflicts do not send blindly',async()=>{
  await choose('existing-a');await page.locator('#task-text').fill('项目变化测试');state.projects[0].version++;await click('tasks-prepare');await settled();assert.ok((await body()).includes('项目资料已更新'));assert.equal(await page.locator('#task-confirm-dialog').count(),0);
  await chooseControl(page,'#task-project','');await chooseControl(page,'#task-project','project-a');await settled();await click('tasks-prepare');await page.waitForSelector('#task-confirm-dialog[open]');state.conflictConfirm=true;const n=state.confirms.length;await click('task-confirm-send');await settled();assert.equal(state.confirms.length,n+1);assert.ok((await body()).includes('确认记录已更新'));assert.equal(await page.locator('#task-confirm-dialog').count(),0);checks.push('project version and confirmation version conflict close pending modal without automatic confirmation');
 });
 await t.test('authentication closes confirmation; changed immutable receipt cannot enable sending',async()=>{
  await chooseControl(page,'#task-project','');await page.locator('#task-text').fill('验证重新连接的正文');await click('tasks-prepare');await page.waitForSelector('#task-confirm-dialog[open]');const n=state.confirms.length;
  state.unauthorized=true;await page.evaluate(()=>document.querySelector('#refresh').click());await page.waitForSelector('#session');assert.equal(await page.locator('#task-confirm-dialog').count(),0);assert.equal(state.confirms.length,n);
  state.unauthorized=false;await page.locator('#session').fill('memory-dynamics-synthetic-session');await page.locator('#session').evaluate(n=>n.form.requestSubmit());await settled();assert.equal(await page.locator('#task-confirm-dialog').count(),0);assert.equal(await page.locator('#task-text').inputValue(),'验证重新连接的正文');
  const r=state.requests[0],original=r.text;r.text='不匹配的回执正文';await refresh();assert.ok((await body()).includes('回执未采用'));assert.ok(await page.locator('#tasks-prepare').isDisabled());assert.equal(state.confirms.length,n);r.text=original;await refresh();
  checks.push('expired authorization closes modal and preserves draft; new session never auto-confirms; immutable receipt mismatch fails closed');
 });
 await t.test('Harness targetless plan confirms without Codex connection and immutable executor cannot change',async()=>{
  const r={id:'native-harness',version:1,phase:'awaiting_confirmation',executor:'harness',text:'合成资料整理',plan:{title:'整理资料',reason:'小任务由 Harness 直接完成'},project:{id:'directory-a',version:2,name:'现有任务目录',source:'task_directory',detailRef:{rootPath:'/synthetic/native'}},createdAt:stamp};state.requests.unshift(r);state.connection.codex='incompatible';await refresh();await page.locator('[data-task-request="native-harness"]').click();await enabled('task-review');
  assert.match(await page.locator('.task-receipt').innerText(),/DeepSeek Harness/);assert.doesNotMatch(await page.locator('.task-receipt').innerText(),/任务名称暂不可用|任务标识/);await click('task-review');await page.waitForSelector('#task-confirm-dialog[open]');assert.equal(await page.locator('#task-final-text').textContent(),r.text);await page.screenshot({path:resolve(output,engine+'-harness-confirmation.png')});const count=state.confirms.length;await click('task-confirm-send');await settled();assert.equal(state.confirms.length,count+1);assert.equal(r.target,undefined);assert.equal(r.appTurnId,undefined);
  r.nativeStatus='approval';await refresh();assert.match(await page.locator('.task-receipt').innerText(),/等待在 Harness 中批准/);r.nativeStatus='completed';state.refreshPhase='completed';await click('task-refresh-receipt');await enabled('task-refresh-receipt');assert.match(await page.locator('.task-receipt').innerText(),/已完成/);
  r.executor='codex';r.target={...targets[0],title:'冻结任务名'};r.version++;await refresh();assert.match(await body(),/回执未采用/);assert.equal(state.confirms.length,count+1);r.executor='harness';delete r.target;state.connection.codex='compatible';await refresh();
  const c={...r,id:'frozen-codex',executor:'codex',target:{hostId:'local',threadId:'existing-a',title:'冻结任务标题'},version:1};state.requests.unshift(c);await refresh();await page.locator('[data-task-request="frozen-codex"]').click();assert.match(await page.locator('.task-receipt').innerText(),/冻结任务标题/);assert.doesNotMatch(await page.locator('.task-receipt').innerText(),/同名现有任务/);
  checks.push('targetless Harness confirmation/refresh with incompatible Codex, actual directory binding retained, immutable executor rejected, frozen Codex title retained');
 });
 await t.test('reviewed Chinese distinguishes management, connection refresh and external edit',async()=>{
  await click('nav-projects');await page.waitForSelector('[data-project-id="project-a"]');await page.locator('[data-project-id="project-a"]').click();await enabled('project-name');await page.locator('#project-name').fill('保留的本页资料');fixture.state.controls.instanceId='synthetic-reconnected';await click('refresh');await enabled('project-review');
  assert.ok((await body()).includes('连接已更新。请核对最新资料'));assert.ok(!(await body()).includes('服务实例'));await click('project-review');state.projects[0].version++;state.projects[0].name='其他位置更新资料';await click('projects-refresh');await enabled('project-review');assert.ok((await body()).includes('这张卡片已在其他位置更新'));assert.equal(await page.locator('#project-name').inputValue(),'保留的本页资料');
  assert.ok((await body()).includes('管理服务已连接'));checks.push('P2 labels distinguish management connectivity, connection refresh and external data conflict');
 });
 assert.deepEqual(errors,[]);assert.equal(fixture.state.writes.length,0);
 await writeFile(resolve(output,engine+'-evidence.json'),JSON.stringify({engine,version:browser.version(),checks,requests:state.calls.map(c=>({path:c.path,method:c.method})),confirmPosts:state.confirms.length,statusRefreshPosts:state.refreshes.length,realTaskSends:0,providers:0,devices:0,synthetic:true,errors},null,2));
 }finally{await context.close();await browser.close();await fixture.close();}
});
