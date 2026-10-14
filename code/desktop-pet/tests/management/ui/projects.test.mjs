// Production UI with isolated HTTP data. No project files, databases, tasks or providers are touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMemoryDynamicsFixture} from '../memory-dynamics-fixture.mjs';
const engines=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const output=resolve(process.env.MANAGEMENT_UI_OUTPUT);
await mkdir(output,{recursive:true});
for(const engine of ['chromium','webkit'])test(engine+' project index CRUD, races and folk UI',async t=>{
 const fixture=await createMemoryDynamicsFixture(),browser=await engines[engine].launch({headless:true});
 const context=await browser.newContext({viewport:{width:1360,height:1000},locale:'zh-CN',recordVideo:process.env.PROJECTS_CAPTURE==='1'&&engine==='chromium'?{dir:output,size:{width:1360,height:1000}}:undefined});
 const page=await context.newPage();page.setDefaultTimeout(5000);
 const make=(id,name='同名项目')=>({id,name,abstract:'仅用于页面验证的合成摘要。'.repeat(24),detailRef:{rootPath:'/synthetic/projects/'+id,entryFile:'docs/README.md'},codexTarget:{hostId:'synthetic-host',threadId:'synthetic-task-'+id},version:1,updatedAt:'2026-09-14T00:00:00.000Z'});
 const state={items:Array.from({length:34},(_,i)=>make('project-'+i)),requests:[],writes:[],offline:false,unauthorized:false,delayGet:0,delaySave:0,dropSave:false,malformed:false};
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/projects**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname,body=req.postDataJSON();state.requests.push({path,method:req.method(),query:url.search,body});
  assert.equal(req.headers().authorization,'Bearer memory-dynamics-synthetic-session');
  const reply=(status,data)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  const fail=(status,message)=>reply(status,{error:{code:status===409?'version_conflict':status===404?'not_found':'unavailable',message}});
  if(state.offline)return fail(503,'索引服务暂不可用');if(state.unauthorized)return fail(401,'会话已失效');
  if(path==='/api/projects'){
   const q=url.searchParams.get('query')||'',offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit'));
   const matches=state.items.filter(x=>x.name.includes(q)||x.abstract.includes(q));return reply(200,state.malformed?{items:'bad'}:{items:matches.slice(offset,offset+limit),total:matches.length,offset,limit});
  }
  if(req.method()==='GET'){
   const item=structuredClone(state.items.find(x=>x.id===decodeURIComponent(path.split('/').at(-1))));
   if(state.delayGet)await new Promise(r=>setTimeout(r,state.delayGet));
   return item?reply(200,item):fail(404,'索引卡片已不存在');
  }
  if(path==='/api/projects/save'){
   let item=state.items.find(x=>x.id===body.id);
   if(body.id&&!item)return fail(404,'索引卡片已不存在');
   if((item?.version??0)!==body.expectedVersion)return fail(409,'索引版本已变化');
   item={...body,id:body.id||'created-'+state.writes.length,version:body.expectedVersion+1,updatedAt:'2026-09-14T01:00:00.000Z'};delete item.expectedVersion;
   state.items=state.items.filter(x=>x.id!==item.id);state.items.unshift(item);state.writes.push({path,body});
   if(state.delaySave)await new Promise(r=>setTimeout(r,state.delaySave));
   if(state.dropSave)return route.abort('failed');return reply(200,item);
  }
  if(path==='/api/projects/remove'){
   const item=state.items.find(x=>x.id===body.id);if(!item)return fail(404,'索引卡片已不存在');if(item.version!==body.expectedVersion)return fail(409,'索引版本已变化');
   state.items=state.items.filter(x=>x.id!==body.id);state.writes.push({path,body});return reply(200,{id:body.id,removed:true});
  }
  throw Error('Unexpected project request: '+path);
 });
 const click=id=>page.locator('#'+id).click();
 const enabled=async id=>{await page.waitForFunction(id=>{const n=document.getElementById(id);return n&&!n.disabled},id)};
 const text=()=>page.locator('body').innerText();
 const refresh=async()=>{await click('projects-refresh');await page.waitForFunction(()=>document.querySelector('#session')||!document.querySelector('#projects-refresh')?.disabled);};
 const choose=async id=>{await page.locator('[data-project-id="'+id+'"]').click();await enabled('project-name');};
 const checks=[];
 try{
 await page.goto(fixture.url);
 await t.test('lazy navigation, bounded list, explicit identity and plain text',async()=>{
  assert.equal(state.requests.length,0);await click('nav-projects');await page.waitForSelector('[data-project-id="project-0"]');
  assert.equal(state.requests.length,1);assert.match(state.requests[0].query,/limit=25/);assert.ok(!state.requests[0].query.includes('characterId'));
  await choose('project-0');assert.equal(await page.locator('#project-root').inputValue(),'/synthetic/projects/project-0');
  assert.ok((await text()).includes('尚未核验连接'));assert.equal(await page.locator('a[href*="synthetic"],button[data-send-task]').count(),0);
  await page.locator('#project-name').fill('<img src=x onerror="window.unsafe=true">');await click('project-save');await enabled('project-save');
  assert.equal(await page.locator('.projects-page img').count(),0);assert.ok((await text()).includes('<img src=x'));assert.equal(state.writes.at(-1).body.id,'project-0');
  checks.push('lazy bounded independent index; duplicate names use IDs; target metadata not connectivity; text not HTML');
 });
 await t.test('create and update once, remove confirmation deletes only card',async()=>{
  await click('project-new');await page.locator('#project-name').fill('新合成项目');await page.locator('#project-root').fill('/synthetic/new');
  await page.locator('#project-entry').fill('../outside.md');await click('project-save');assert.ok((await text()).includes('相对路径'));const before=state.writes.length;
  await page.locator('#project-entry').fill('docs/start.md');await page.locator('.project-target summary').click();await page.locator('#project-host').fill('synthetic-host');await click('project-save');assert.equal(state.writes.length,before);
  await page.locator('#project-thread').fill('synthetic-existing-task');state.delaySave=150;
  await page.evaluate(()=>{document.querySelector('#project-save').click();document.querySelector('#project-save').click()});await enabled('project-save');state.delaySave=0;
  assert.equal(state.writes.length,before+1);assert.equal(state.writes.at(-1).body.expectedVersion,0);assert.ok(!state.writes.at(-1).body.id);
  await click('project-remove');assert.ok((await text()).includes('不删除项目文件'));await click('project-remove-cancel');assert.equal(state.writes.length,before+1);
  await click('project-remove');await click('project-remove-confirm');await page.waitForFunction(()=>!document.querySelector('#project-remove-confirm'));assert.equal(state.writes.at(-1).path,'/api/projects/remove');
  assert.deepEqual(Object.keys(state.writes.at(-1).body).sort(),['expectedVersion','id']);checks.push('create zero version, one in-flight write, update stable ID, explicit card-only removal');
 });
 await t.test('version conflicts retain draft and require reviewing current item',async()=>{
  await choose('project-1');await page.locator('#project-name').fill('本页保留草稿');const item=state.items.find(x=>x.id==='project-1');item.version++;item.name='其他位置的名称';item.abstract='其他位置更新的摘要';
  await click('project-save');await page.waitForSelector('#project-review');await enabled('project-review');
  assert.equal(await page.locator('#project-name').inputValue(),'本页保留草稿');assert.ok(await page.locator('#project-save').isDisabled());await page.locator('.project-comparison summary').click();assert.ok((await text()).includes('其他位置的名称'));
  await click('project-review');assert.equal(await page.locator('#project-abstract').inputValue(),'其他位置更新的摘要');await click('project-save');await enabled('project-save');assert.equal(state.writes.at(-1).body.expectedVersion,2);
  await click('project-remove');state.items.find(x=>x.id==='project-1').version++;const n=state.writes.length;await click('project-remove-confirm');await page.waitForSelector('#project-review');assert.equal(state.writes.length,n);assert.equal(await page.locator('#project-remove-confirm').count(),0);
  checks.push('save/remove conflicts preserve draft, show current values, rebase only edited fields, invalidate removal confirmation');
 });
 await t.test('late detail reads, snapshot refresh and offline recovery preserve edits',async()=>{
  state.delayGet=160;await page.locator('[data-project-id="project-2"]').click();await page.locator('[data-project-id="project-3"]').click();await enabled('project-name');await page.waitForTimeout(200);state.delayGet=0;
  assert.equal(await page.locator('#project-root').inputValue(),'/synthetic/projects/project-3');await page.locator('#project-name').fill('断线保留的草稿');
  state.offline=true;await refresh();assert.equal(await page.locator('#project-name').inputValue(),'断线保留的草稿');assert.ok(await page.locator('#project-save').isDisabled());
  assert.ok((await text()).includes('已连接')); // Index failure must not falsely disconnect management.
  state.offline=false;await refresh();await enabled('project-save');assert.equal(await page.locator('#project-name').inputValue(),'断线保留的草稿');
  const n=state.writes.length;await click('nav-memory');await click('nav-projects');await enabled('project-save');assert.equal(state.writes.length,n);assert.equal(await page.locator('#project-name').inputValue(),'断线保留的草稿');
  checks.push('late selection ignored; module outage isolated; refresh/navigation preserve draft without POST');
 });
 await t.test('unknown create outcome cannot auto-repeat; missing and invalid replies never permit overwrite',async()=>{
  await click('project-new');await page.locator('#project-name').fill('回执丢失的新增');await page.locator('#project-root').fill('/synthetic/uncertain');state.dropSave=true;
  const n=state.writes.length;await click('project-save');await page.waitForFunction(()=>document.body.innerText.includes('尚未确认'));state.dropSave=false;await refresh();
  assert.equal(state.writes.length,n+1);assert.ok(await page.locator('#project-save').isDisabled());assert.ok((await text()).includes('回执丢失的新增'));
  await choose('project-4');state.items=state.items.filter(x=>x.id!=='project-4');await refresh();assert.ok(await page.locator('#project-save').isDisabled());assert.ok((await text()).includes('不存在'));
  state.malformed=true;await refresh();assert.ok((await text()).includes('无法识别'));state.malformed=false;await refresh();await click('project-new');await click('project-discard');const writes=state.writes.length;await click('project-remove-confirm');assert.equal(state.writes.length,writes);assert.ok(state.items.some(x=>x.name==='回执丢失的新增'));checks.push('uncertain creation retained and not retried; missing item/invalid payload fail closed');
 });
 await t.test('authentication and instance changes require fresh version review',async()=>{
  await choose('project-5');await page.locator('#project-name').fill('跨实例草稿');fixture.state.controls.instanceId='synthetic-new-instance';await click('refresh');await enabled('refresh');await page.waitForSelector('#project-review');assert.ok(await page.locator('#project-save').isDisabled());
  await enabled('project-review');await click('project-review');await enabled('project-save');
  state.unauthorized=true;await refresh();await page.waitForSelector('#session');assert.equal(await page.locator('#project-name').inputValue(),'跨实例草稿');assert.ok(await page.locator('#project-save').isDisabled());
  state.unauthorized=false;await page.locator('#session').fill('memory-dynamics-synthetic-session');await page.locator('#session').evaluate(n=>n.form.requestSubmit());await page.waitForFunction(()=>!document.querySelector('#session'));await enabled('project-review');await click('project-review');checks.push('auth/instance invalidates writes; refresh and explicit review retains draft');
 });
 await t.test('pagination, real scrolling, focus, wide/narrow and reduced motion',async()=>{
  await page.locator('#projects-query').fill('同名');await click('projects-search');await enabled('projects-search');await click('projects-next');await enabled('projects-refresh');assert.ok(state.requests.some(r=>r.query.includes('offset=25')));
  await page.locator('#projects-query').fill('');await click('projects-search');await enabled('projects-search');await choose('project-6');
  const input=page.locator('#project-abstract');await input.focus();await input.evaluate(n=>{n.setSelectionRange(8,13);n.scrollTop=25});await click('refresh');await enabled('refresh');await enabled('project-name');
  // Programmatic refresh keeps actual input focus, unlike the user clicking refresh above.
  await input.focus();await input.evaluate(n=>n.setSelectionRange(8,13));await page.evaluate(()=>document.querySelector('#refresh').click());await enabled('refresh');await enabled('project-name');
  assert.deepEqual(await input.evaluate(n=>[n===document.activeElement,n.selectionStart,n.selectionEnd]),[true,8,13]);
  const list=page.locator('#projects-rows');await list.hover();await page.mouse.wheel(0,460);await page.waitForTimeout(250);assert.ok(await list.evaluate(n=>n.scrollTop)>0);await list.focus();await page.keyboard.press('PageDown');await page.waitForTimeout(250);const pos=await list.evaluate(n=>n.scrollTop);
  await page.evaluate(()=>document.querySelector('#projects-refresh').click());await enabled('projects-refresh');assert.equal(await list.evaluate(n=>n.scrollTop),pos);
  assert.equal(await list.evaluate(n=>n.offsetWidth-n.clientWidth),0);await page.screenshot({path:resolve(output,engine+'-projects-wide.png'),fullPage:true});
  await page.setViewportSize({width:360,height:900});await page.waitForTimeout(220);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:resolve(output,engine+'-projects-narrow.png'),fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});await click('nav-overview');await click('nav-projects');await enabled('projects-refresh');assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
  checks.push('bounded search/pages, wheel and keyboard scroll with hidden bars, selection/focus preserved, 1360/360 widths, reduced motion');
 });
 assert.deepEqual(errors,[]);assert.equal(fixture.state.writes.length,0);assert.ok(state.requests.every(r=>!r.query.includes('characterId')));
 await writeFile(resolve(output,engine+'-evidence.json'),JSON.stringify({engine,version:browser.version(),checks,synthetic:true,providerCalls:0,deviceCalls:0,taskSends:0,source:'production management UI with isolated project HTTP routes',errors},null,2));
 }finally{await context.close();await browser.close();await fixture.close();}
});
