import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMemoryDynamicsFixture} from '../memory-dynamics-fixture.mjs';
const {webkit}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
test('actual task UI accepts 215 and 1000 valid targets, search and strict rejection remain',async t=>{
 const fixture=await createMemoryDynamicsFixture();t.after(()=>fixture.close());
 const browser=await webkit.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1100,height:800}});page.setDefaultTimeout(3000);
 const targets=Array.from({length:1001},(_,i)=>({threadId:'synthetic-'+i,hostId:'local',title:'合成任务 '+i,projectPath:'/synthetic/'+i}));
 let count=215,invalid=null,writes=0;
 await page.route('**/api/tasks**',route=>{
  const request=route.request(),url=new URL(request.url());if(request.method()!=='GET'){writes++;throw Error('No writes allowed');}
  let items=targets.slice(0,count).filter(t=>t.title.includes(url.searchParams.get('query')||''));
  if(invalid==='duplicate')items=[targets[0],targets[0]];
  if(invalid==='field')items=[{...targets[0],hostId:'remote'}];
  return route.fulfill({contentType:'application/json',body:JSON.stringify(url.pathname.endsWith('/targets')?{items,limit:1000}:{requests:[],connection:{harness:'ready',codex:'compatible',preset:'ready'}})});
 });
 await page.goto(fixture.url);await page.waitForFunction(()=>document.body.innerText.includes('管理服务已连接'));await page.locator('#nav-tasks').click();
 await page.waitForFunction(()=>document.querySelectorAll('[data-task-target]').length===215);
 assert.ok(await page.locator('#tasks-prepare').isDisabled());
 await page.locator('[data-task-target="synthetic-214"]').click();await page.locator('#task-text').fill('synthetic request');assert.ok(await page.locator('#tasks-prepare').isEnabled());
 const refresh=async()=>{await page.locator('#tasks-refresh').click();await page.waitForFunction(()=>!document.querySelector('#tasks-refresh').disabled);};
 count=1000;await refresh();assert.equal(await page.locator('[data-task-target]').count(),1000);
 const query=page.locator('#tasks-query');await query.fill('合成任务 999');await page.locator('#tasks-search').click();await page.waitForFunction(()=>document.querySelectorAll('[data-task-target]').length===1);assert.equal(await page.locator('[data-task-target]').getAttribute('data-task-target'),'synthetic-999');
 await query.fill('');await page.locator('#tasks-search').click();await page.waitForFunction(()=>document.querySelectorAll('[data-task-target]').length===1000);
 for(const kind of ['duplicate','field','oversize']){invalid=kind;count=kind==='oversize'?1001:215;await refresh();assert.match(await page.locator('body').innerText(),/现有任务列表无法识别/);assert.ok(await page.locator('#tasks-prepare').isDisabled());}
 invalid=null;count=215;await refresh();await page.waitForFunction(()=>!document.body.innerText.includes('现有任务列表无法识别'));
 const out=resolve(process.env.MANAGEMENT_UI_OUTPUT);await mkdir(out,{recursive:true});await page.screenshot({path:resolve(out,'targets-215.png')});assert.equal(writes,0);
});
