// Production management UI and isolated synthetic HTTP; no user project files or provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMemoryDynamicsFixture} from '../memory-dynamics-fixture.mjs';
import {choose} from '../choice-helper.mjs';
const engines=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const output=resolve(process.env.MANAGEMENT_UI_OUTPUT);await mkdir(output,{recursive:true});
const at='2026-09-26T00:00:00.000Z';
const project=id=>({id,name:id==='project-a'?'甲项目':'乙项目',abstract:'合成工程索引。',detailRef:{rootPath:'/synthetic/'+id},version:1,updatedAt:at});
const source=(id='source')=>({taskId:id,nativeTurnId:'turn-1',artifactRef:'artifact-ref-only',recordedAt:at});
const item=(id,projectId,status='candidate',text='合成项目记忆')=>({id,projectId,kind:'fact',text,status,version:1,sources:[source()],branchRef:'main',condition:'仅用于合成验证',createdAt:at,updatedAt:at});
const job=(id,projectId)=>({id,projectId,evidence:{projectId,taskId:'task-1',nativeTurnId:'turn-1',terminalEventId:'event-1',terminalPhase:'completed',occurredAt:at,extractionVersion:'test-v1'},state:'failed',attempts:1,errorCode:'extraction_failed',createdAt:at,updatedAt:at});

test('project memory workbench uses scoped, versioned management routes and honest capability state',async t=>{
 const fixture=await createMemoryDynamicsFixture(),browser=await engines.webkit.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1200,height:920},locale:'zh-CN'}),page=await context.newPage();page.setDefaultTimeout(5000);
 const state={projects:[project('project-a'),project('project-b')],items:[item('a-candidate','project-a'),item('a-accepted','project-a','accepted','已采纳的合成事实'),item('b-candidate','project-b')],jobs:[job('job-a','project-a')],requests:[],writes:[],delayProject:null,drop:false,unauthorized:false,offline:false,malformed:false};
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const reply=(route,status,data)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
 await page.route('**/api/projects**',async route=>{
  const req=route.request(),u=new URL(req.url());assert.equal(req.headers().authorization,'Bearer memory-dynamics-synthetic-session');
  state.requests.push({path:u.pathname,method:req.method(),projectId:null});
  if(u.pathname==='/api/projects')return reply(route,200,{items:state.projects,total:state.projects.length,offset:0,limit:25});
  const row=state.projects.find(x=>x.id===decodeURIComponent(u.pathname.split('/').at(-1)));
  return row?reply(route,200,row):reply(route,404,{error:{code:'not_found',message:'项目不存在'}});
 });
 await page.route('**/api/project-memory/**',async route=>{
  const req=route.request(),u=new URL(req.url()),body=req.method()==='POST'?req.postDataJSON():null,id=u.searchParams.get('projectId')||body?.projectId;
  assert.equal(req.headers().authorization,'Bearer memory-dynamics-synthetic-session');state.requests.push({path:u.pathname,method:req.method(),projectId:id,body});
  if(state.unauthorized)return reply(route,401,{error:{code:'unauthorized',message:'synthetic secret diagnostic'}});
  if(state.offline)return reply(route,503,{error:{code:'unavailable',message:'synthetic private diagnostic'}});
  if(u.pathname==='/api/project-memory/items'){
   if(state.delayProject===id){state.delayProject=null;await new Promise(r=>setTimeout(r,200));}
   return reply(route,200,state.malformed?{items:'invalid',processingAvailable:false}:{items:state.items.filter(x=>x.projectId===id),processingAvailable:false});
  }
  if(u.pathname==='/api/project-memory/jobs')return reply(route,200,{jobs:state.jobs.filter(x=>x.projectId===id),processingAvailable:false});
  if(u.pathname==='/api/project-memory/item'){
   const found=state.items.find(x=>x.projectId===id&&x.id===u.searchParams.get('id'));
   return found?reply(route,200,found):reply(route,404,{error:{code:'not_found',message:'无此条目'}});
  }
  if(u.pathname==='/api/project-memory/change'){
   assert.match(body.operationId,/^[\da-f-]{36}$/);assert.ok(Number.isFinite(Date.parse(body.recordedAt)));assert.equal(body.projectId,'project-a');
   const found=state.items.find(x=>x.projectId===id&&x.id===body.id);
   if(body.type!=='create'&&found?.version!==body.expectedVersion)return reply(route,200,{operationId:body.operationId,state:'conflict',item:found});
   let saved;
   if(body.type==='create')saved={id:'manual-'+(state.writes.length+1),projectId:id,kind:body.kind,text:body.text,status:body.status,version:1,sources:[{userInputId:'management:'+body.operationId,recordedAt:body.recordedAt}],branchRef:body.branchRef,condition:body.condition,createdAt:at,updatedAt:at};
   else saved={...found,version:found.version+1,text:body.type==='edit'?body.text:found.text,kind:body.type==='edit'&&body.kind!==undefined?body.kind:found.kind,branchRef:body.type==='edit'&&body.branchRef!==undefined?body.branchRef??undefined:found.branchRef,condition:body.type==='edit'&&body.condition!==undefined?body.condition??undefined:found.condition,status:body.type==='accept'?'accepted':body.type==='withdraw'?'withdrawn':found.status,updatedAt:at};
   state.items=state.items.filter(x=>x.id!==saved.id).concat(saved);state.writes.push({body,saved});
   if(state.drop){state.drop=false;return route.abort('failed');}
   return reply(route,200,{operationId:body.operationId,state:'applied',item:saved});
  }
  if(u.pathname==='/api/project-memory/jobs/retry')throw Error('Retry must remain disabled');
  throw Error('Unexpected route '+u.pathname);
 });
 const text=()=>page.locator('body').innerText();
 const open=async id=>{await page.locator('#nav-projects').click();await page.locator('[data-project-id="'+id+'"]').click();await page.locator('#project-memory-open').click();await page.waitForSelector('#pm-rows');await page.waitForFunction(()=>document.querySelector('#pm-new')&&!document.querySelector('#pm-new').disabled);};
 const checks=[];
 try{
  await page.goto(fixture.url);
  await t.test('lazy navigation, scoped reads, source and processing status',async()=>{
   assert.equal(state.requests.filter(x=>x.path.startsWith('/api/project-memory')).length,0);
   await page.locator('#nav-workbench').click();assert.ok((await text()).includes('从“项目索引”选择项目'));
   await page.locator('#wb-projects').click();await page.waitForSelector('[data-project-id="project-a"]');await open('project-a');
   assert.ok((await text()).includes('甲项目'));assert.ok((await text()).includes('后台整理尚未启用'));
   assert.ok(await page.locator('.pm-retry').isDisabled());assert.equal(state.requests.filter(x=>x.path==='/api/project-memory/jobs/retry').length,0);
   await page.locator('[data-pm-id="a-candidate"]').click();await page.waitForSelector('.pm-sources');await page.locator('.pm-sources summary').click();
   await page.waitForFunction(()=>document.body.innerText.includes('artifact-ref-only')&&!document.querySelector('.pm-sources .disclosure-body').getAnimations().length);assert.equal(await page.locator('.pm-sources').evaluate(n=>n.open),true);assert.equal(await page.locator('.pm-sources a').count(),0);
   assert.ok(state.requests.filter(x=>x.path.startsWith('/api/project-memory')).every(x=>x.projectId==='project-a'));
   await page.screenshot({path:resolve(output,'workbench-1200.png'),fullPage:true});
   checks.push('lazy exact project ID reads; factual source refs; extractor capability false disables retry');
  });
  await t.test('manual create, menu keyboard/pointer, accept, edit conflict and withdraw',async()=>{
   await page.locator('#pm-new').click();await choose(page,'#pm-kind','decision');
   await page.locator('#pm-status').click();await page.mouse.move(10,10);assert.ok(await page.locator('#pm-status-listbox').isVisible());
   await page.keyboard.press('Escape');assert.equal(await page.locator('#pm-status-listbox').count(),0);
   await page.locator('#pm-status').click();await page.locator('#pm-text').click();assert.equal(await page.locator('#pm-status-listbox').count(),0);
   await page.locator('#pm-text').fill('手工决定：仅在甲项目采用。');await page.locator('#pm-branch').fill('feature/test');await page.locator('#pm-condition').fill('条件成立时');
   await page.locator('#pm-save').click();await page.waitForSelector('[data-pm-id="manual-1"]');
   const created=state.writes.at(-1).body;assert.equal(created.type,'create');assert.equal(created.kind,'decision');assert.equal(created.status,'candidate');assert.equal(created.branchRef,'feature/test');assert.equal(created.condition,'条件成立时');assert.equal(Object.hasOwn(created,'sources'),false);
   assert.equal(await page.locator('#pm-branch').inputValue(),'feature/test');await page.locator('.pm-sources summary').click();await page.waitForFunction(id=>document.body.innerText.includes('management:'+id),created.operationId);
   await page.locator('#pm-accept').click();assert.ok((await text()).includes('确认采纳'));await page.keyboard.press('Escape');assert.equal(await page.locator('#pm-confirm').count(),0);
   await page.locator('#pm-accept').click();await page.locator('#pm-confirm').click();await page.waitForFunction(()=>document.body.innerText.includes('条目已采纳'));
   assert.equal(state.writes.at(-1).body.type,'accept');assert.equal(state.writes.at(-1).body.expectedVersion,1);
   await page.locator('#pm-text').fill('本页修改的文本');const actual=state.items.find(x=>x.id==='manual-1');actual.version++;actual.text='其他位置保存的新文本';
   await page.locator('#pm-save').click();await page.waitForSelector('#pm-review');assert.ok(await page.locator('#pm-save').isDisabled());assert.ok((await text()).includes('其他位置保存的新文本'));
   assert.equal(await page.locator('#pm-text').inputValue(),'本页修改的文本');await page.locator('#pm-review').click();await page.locator('#pm-save').click();await page.waitForFunction(()=>document.body.innerText.includes('条目已更新'));
   assert.equal(state.writes.at(-1).body.type,'edit');assert.equal(state.writes.at(-1).body.expectedVersion,3);
   await page.locator('#pm-withdraw').click();await page.locator('#pm-confirm').click();await page.waitForFunction(()=>document.body.innerText.includes('条目已撤回'));
   assert.equal(state.writes.at(-1).body.type,'withdraw');assert.ok(await page.locator('#pm-save').isDisabled());
   checks.push('custom menu click/outside/Esc; server-derived source; versioned create/accept/edit conflict/review/withdraw');
  });
  await t.test('metadata edits send changed fields only, preserve drafts and compare conflicts',async()=>{
   await page.locator('[data-pm-id="a-candidate"]').click();await page.waitForFunction(()=>document.querySelector('#pm-branch')?.value==='main');
   assert.equal(await page.locator('#pm-condition').inputValue(),'仅用于合成验证');
   await choose(page,'#pm-kind','constraint');await page.locator('#pm-branch').fill('feature/m05');await page.locator('#pm-condition').fill('审核完成后');
   await page.locator('#pm-save').click();await page.waitForFunction(()=>document.body.innerText.includes('条目已更新'));
   let edit=state.writes.at(-1).body;assert.equal(edit.type,'edit');assert.equal(edit.text,'合成项目记忆');assert.equal(edit.expectedVersion,1);
   assert.deepEqual([edit.kind,edit.branchRef,edit.condition],['constraint','feature/m05','审核完成后']);assert.equal(state.items.find(x=>x.id==='a-candidate').status,'candidate');
   await page.locator('#pm-text').fill('仅正文更新');await page.locator('#pm-save').click();await page.waitForFunction(()=>document.querySelector('[data-pm-id="a-candidate"]')?.innerText.includes('仅正文更新'));
   edit=state.writes.at(-1).body;assert.equal(edit.text,'仅正文更新');for(const key of ['kind','branchRef','condition'])assert.equal(Object.hasOwn(edit,key),false);
   await page.locator('#pm-branch').fill('');await page.locator('#pm-save').click();await page.waitForFunction(()=>document.querySelector('[data-pm-id="a-candidate"]')?.innerText.includes('v4'));
   edit=state.writes.at(-1).body;assert.equal(edit.branchRef,null);assert.equal(Object.hasOwn(edit,'condition'),false);assert.equal(Object.hasOwn(edit,'kind'),false);
   await page.locator('#pm-condition').fill('');await page.locator('#pm-save').click();await page.waitForFunction(()=>document.querySelector('[data-pm-id="a-candidate"]')?.innerText.includes('v5'));
   edit=state.writes.at(-1).body;assert.equal(edit.condition,null);assert.equal(Object.hasOwn(edit,'branchRef'),false);
   assert.equal(state.items.find(x=>x.id==='a-candidate').branchRef,undefined);
   await choose(page,'#pm-kind','decision');await page.locator('#pm-branch').fill('draft/ref');await page.locator('#pm-condition').fill('本页条件');
   const remote=state.items.find(x=>x.id==='a-candidate');remote.version++;remote.kind='open_question';remote.branchRef='remote/ref';remote.condition='远端条件';
   await page.locator('#pm-save').click();await page.waitForSelector('#pm-review');assert.ok(await page.locator('#pm-save').isDisabled());
   assert.ok((await page.locator('.pm-comparison').innerText()).includes('remote/ref'));assert.ok((await page.locator('.pm-comparison').innerText()).includes('远端条件'));
   assert.equal(await page.locator('#pm-branch').inputValue(),'draft/ref');assert.equal(await page.locator('#pm-condition').inputValue(),'本页条件');
   await page.locator('#pm-review').click();await page.locator('#pm-save').click();await page.waitForFunction(()=>document.querySelector('[data-pm-id="a-candidate"]')?.innerText.includes('draft/ref'));
   edit=state.writes.at(-1).body;assert.equal(edit.expectedVersion,remote.version);assert.equal(edit.text,'仅正文更新');assert.deepEqual([edit.kind,edit.branchRef,edit.condition],['decision','draft/ref','本页条件']);
   await page.screenshot({path:resolve(output,'workbench-metadata-1200.png'),fullPage:true});
   await page.locator('#pm-condition').fill('未知回执条件');const before=state.writes.length;state.drop=true;await page.locator('#pm-save').click();
   await page.waitForFunction(()=>document.body.innerText.includes('操作结果尚未确认'));assert.equal(state.writes.length,before+1);assert.ok(await page.locator('#pm-save').isDisabled());
   await page.locator('#pm-refresh').click();await page.waitForSelector('#pm-review');assert.equal(await page.locator('#pm-condition').inputValue(),'未知回执条件');assert.equal(state.writes.length,before+1);
   await page.locator('#pm-review').click();await page.setViewportSize({width:360,height:850});await page.locator('#pm-branch').fill('keyboard/draft');await page.locator('#pm-branch').focus();
   await page.locator('#pm-branch').evaluate(n=>n.setSelectionRange(2,8));await page.evaluate(()=>document.querySelector('#pm-refresh').click());
   await page.waitForFunction(()=>document.querySelector('#pm-refresh')&&!document.querySelector('#pm-refresh').disabled);
   assert.deepEqual(await page.locator('#pm-branch').evaluate(n=>[n===document.activeElement,n.selectionStart,n.selectionEnd]),[true,2,8]);
   assert.equal(await page.locator('#pm-branch').inputValue(),'keyboard/draft');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:resolve(output,'workbench-metadata-360.png'),fullPage:true});await page.setViewportSize({width:1200,height:920});
   checks.push('0.1.2 metadata edit: changed-only fields, explicit null clear, conflict comparison, unknown single write, narrow keyboard draft');
  });
  await t.test('uncertain write stays single and project switch rejects late response',async()=>{
   await page.locator('#pm-new').click();await page.locator('#pm-text').fill('回执丢失的合成候选');const n=state.writes.length;state.drop=true;
   await page.locator('#pm-save').click();await page.waitForFunction(()=>document.body.innerText.includes('操作结果尚未确认'));assert.equal(state.writes.length,n+1);assert.ok(await page.locator('#pm-save').isDisabled());
   state.delayProject='project-a';await page.locator('#pm-refresh').click();await page.locator('#wb-projects').click();await page.locator('[data-project-id="project-b"]').click();await page.locator('#project-memory-open').click();
   await page.waitForSelector('[data-pm-id="b-candidate"]');await page.waitForTimeout(240);assert.equal(await page.locator('[data-pm-id="a-candidate"]').count(),0);
   assert.ok(state.requests.filter(x=>x.path==='/api/project-memory/change').every(x=>x.projectId==='project-a'));
   checks.push('one uncertain POST; per-project identity and late response protection');
  });
  await t.test('narrow screen, scrolling, focus, no unrelated product writes',async()=>{
   await page.setViewportSize({width:360,height:850});await page.waitForTimeout(80);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.locator('#pm-new').click();await page.locator('#pm-text').fill('长文本 '.repeat(350));await page.locator('#pm-text').focus();await page.locator('#pm-text').evaluate(n=>{n.setSelectionRange(8,13);n.scrollTop=160});
   await page.evaluate(()=>document.querySelector('#pm-refresh').click());await page.waitForFunction(()=>document.querySelector('#pm-refresh')&&!document.querySelector('#pm-refresh').disabled);
   assert.deepEqual(await page.locator('#pm-text').evaluate(n=>[n===document.activeElement,n.selectionStart,n.selectionEnd]),[true,8,13]);
   assert.ok(await page.locator('#pm-text').evaluate(n=>n.scrollTop)>0);
   await page.screenshot({path:resolve(output,'workbench-360.png'),fullPage:true});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(state.requests.filter(x=>x.method==='POST'&&x.path!=='/api/project-memory/change').length,0);
   assert.equal(fixture.state.writes.length,0);assert.deepEqual(errors,[]);
   checks.push('360px long-text layout, keyboard caret after refresh, no companion/task/provider writes');
  });
  await t.test('malformed, unavailable and unauthorized reads keep edits safe',async()=>{
   state.malformed=true;await page.locator('#pm-refresh').click();await page.waitForFunction(()=>document.body.innerText.includes('请求未完成'));assert.ok(await page.locator('#pm-save').isDisabled());
   state.malformed=false;state.offline=true;await page.locator('#pm-refresh').click();await page.waitForFunction(()=>document.body.innerText.includes('请求未完成'));assert.ok(!(await text()).includes('synthetic private diagnostic'));
   state.offline=false;await page.locator('#pm-refresh').click();await page.waitForFunction(()=>document.querySelector('#pm-new')&&!document.querySelector('#pm-new').disabled);
   state.unauthorized=true;await page.locator('#pm-refresh').click();await page.waitForSelector('#session');assert.ok(!(await text()).includes('synthetic secret diagnostic'));assert.ok(await page.locator('#pm-save').isDisabled());
   state.unauthorized=false;await page.locator('#session').fill('memory-dynamics-synthetic-session');await page.locator('#session').evaluate(n=>n.form.requestSubmit());await page.waitForFunction(()=>!document.querySelector('#session'));
   assert.equal(state.requests.filter(x=>x.path==='/api/project-memory/jobs/retry').length,0);checks.push('invalid/503 payloads retain draft and lock writes; 401 returns to session login without diagnostics');
  });
  await writeFile(resolve(output,'evidence.json'),JSON.stringify({engine:'webkit',version:browser.version(),checks,requestCount:state.requests.length,changeCalls:state.requests.filter(x=>x.path==='/api/project-memory/change').length,retryCalls:state.requests.filter(x=>x.path.endsWith('/retry')).length,fixtureWrites:fixture.state.writes.length,errors,scope:'isolated production UI with synthetic HTTP; no actual project storage, models, task or devices'},null,2));
 }finally{await context.close();await browser.close();await fixture.close();}
});


test('native T3 entry opens verified home, project and exact task without dispatch',async()=>{
 const fixture=await createMemoryDynamicsFixture(),browser=await engines.webkit.launch({headless:true});
 const context=await browser.newContext({viewport:{width:960,height:800},locale:'zh-CN'}),page=await context.newPage();
 page.setDefaultTimeout(5000);
 const task={id:'task-a',projectId:'project-a',provider:'codex',origin:'t3',environmentId:'env-a',t3ProjectId:'native-a',threadId:'thread-a',providerInstanceId:'codex'};
 const memory={...item('source-memory','project-a','accepted','可信合成项目事实'),sources:[{taskId:'task-a',nativeTurnId:'turn-a',artifactRef:'https://evil.invalid/unsafe',recordedAt:at}]};
 const state={focus:{version:'0.1.0',projectId:'project-a',revision:0,task:null},opens:[],mode:'ready',errors:[]};
 await page.addInitScript(()=>{const original=window.fetch;window.fetch=(path,options)=>{
  if(path==='/api/workbench/native-open')sessionStorage.setItem('native-open-credential-mode',options?.credentials||'');
  return original(path,options);
 };});
 page.on('pageerror',error=>state.errors.push(error.message));
 const reply=(route,status,data,headers={})=>route.fulfill({status,contentType:'application/json',headers,body:JSON.stringify(data)});
 await context.route('**/open',route=>route.fulfill({status:200,contentType:'text/html',body:'<title>synthetic T3</title>'}));
 await page.route('**/api/projects**',route=>{
  const u=new URL(route.request().url());
  return reply(route,200,u.pathname==='/api/projects'?{items:[project('project-a')],total:1,offset:0,limit:25}:project('project-a'));
 });
 await page.route('**/api/project-memory/**',route=>{
  const u=new URL(route.request().url());
  return reply(route,200,u.pathname==='/api/project-memory/items'?{items:[memory],processingAvailable:false}:
   u.pathname==='/api/project-memory/item'?memory:{jobs:[],processingAvailable:false});
 });
 await page.route('**/api/workbench/**',async route=>{
  const request=route.request(),u=new URL(request.url()),path=u.pathname,body=request.method()==='POST'?request.postDataJSON():null;
  assert.equal(request.headers().authorization,'Bearer memory-dynamics-synthetic-session');
  if(path==='/api/workbench/status')return reply(route,200,{version:'0.1.1',readAvailable:true,dispatchEnabled:false,sourceOpening:'verified_same_origin_task_detail',preciseTurnJump:false});
  if(path==='/api/workbench/tasks')return reply(route,200,{tasks:[{task,projection:{taskId:task.id,sequence:1,eventId:'event-a',phase:'completed',nativeTurnId:'turn-a'},resultPreview:{nativeTurnId:'turn-a',messageId:'assistant-a',text:'AAA_B54_CODEX_OK',truncated:false}}]});
  if(path==='/api/workbench/source')return reply(route,200,{status:'verified_task',projectId:'project-a',taskId:'task-a',environmentId:'env-a',threadId:'thread-a',
   detailApi:'/api/workbench/task-detail?projectId=project-a&taskId=task-a',sourceIdsVerified:false,preciseTurnJump:false});
  if(path==='/api/workbench/focus'){
   if(request.method()==='GET')return reply(route,200,state.focus,{'Set-Cookie':'wb-focus=synthetic; Path=/; SameSite=Strict'});
   assert.equal(body.expectedRevision,state.focus.revision);assert.equal(body.projectId,'project-a');
   state.focus={...state.focus,revision:state.focus.revision+1,task:body.taskId===task.id?task:null};
   return reply(route,200,state.focus);
  }
  if(path==='/api/workbench/native-open'){
   state.opens.push({body,cookie:(await request.allHeaders()).cookie||''});
   if(state.mode==='offline')return reply(route,503,{error:{code:'unavailable',message:'private diagnostic'}});
   if(state.mode==='conflict')return reply(route,409,{error:{code:'version_conflict',message:'private diagnostic'}});
   const target={kind:body.target,environmentId:'env-a',...(body.projectId?{projectId:body.projectId,t3ProjectId:'native-a'}:{}),
    ...(body.taskId?{taskId:body.taskId,threadId:'thread-a',providerInstanceId:'codex'}:{})};
   if(state.mode==='drift')target.threadId='wrong-thread';
   const expiresAt=new Date(Date.now()+(state.mode==='expired'?-1000:30000)).toISOString();
   const local=new URL(fixture.url);return reply(route,200,{version:'0.1.0',status:'ready',
    url:(state.mode==='unsafe'?'https://evil.invalid':local.origin)+'/open#'+'A'.repeat(43),expiresAt,target});
  }
  throw Error('Unexpected workbench route '+path);
 });

 const gotoApp=async()=>{await page.goto(fixture.url);await page.waitForSelector('#nav-projects');};
 const enterProject=async()=>{
  await page.locator('#nav-projects').click();await page.locator('[data-project-id="project-a"]').click();
  await page.locator('#project-memory-open').click();
 };
 const checkNativePage=async()=>{
  await page.waitForURL(/\/open#/);
  assert.equal(new URL(page.url()).pathname,'/open');
  assert.equal(await page.title(),'synthetic T3');
  assert.equal(context.pages().length,1,'the original tab navigates instead of opening a silent popup');
 };
 try{
  await gotoApp();await page.locator('#nav-workbench').click();
  await page.locator('#wb-native-home').click();await checkNativePage();
  assert.deepEqual(state.opens.at(-1).body,{target:'home'});
  await page.goBack();await page.waitForSelector('#nav-workbench');await page.locator('#nav-workbench').click();
  await page.waitForSelector('#wb-native-home');
  assert.equal(await page.locator('#wb-native-home').isDisabled(),false,'returning to AAA keeps the entry reusable');
  assert.equal((await page.locator('.workbench-page').innerText()).includes('正在切换'),false);

  await gotoApp();await enterProject();
  await page.locator('[data-pm-id="source-memory"]').click();
  await page.locator('.pm-sources summary').click();await page.locator('.pm-open-source').click();
  await page.waitForSelector('#wb-source-context');
  await page.waitForFunction(()=>document.querySelector('#wb-source-context')?.innerText.includes('可信原生线程 ID'));
  assert.equal(await page.locator('#wb-source-context a').count(),0,'untrusted artifact reference stays text');
  await page.locator('#wb-native-source').click();await checkNativePage();
  assert.deepEqual(state.opens.at(-1).body,{target:'task',projectId:'project-a',taskId:'task-a'},
   'verified source opens the native task without changing browser focus');

  await gotoApp();await enterProject();await page.locator('#wb-tab-tasks').click();
  await page.waitForFunction(()=>document.body.innerText.includes('AAA_B54_CODEX_OK'));
  assert.match(await page.locator('[data-wb-task-id]').first().innerText(),/已完成/);
  await page.waitForSelector('[data-wb-task-id="task-a"]');
  await context.addCookies([{name:'wb-focus',value:'synthetic',url:new URL(fixture.url).origin}]);
  await page.locator('#wb-native-project').click();await checkNativePage();
  assert.deepEqual(state.opens.at(-1).body,{target:'project',projectId:'project-a',expectedFocusRevision:0});
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('native-open-credential-mode')),'same-origin');

  await gotoApp();await enterProject();await page.locator('#wb-tab-tasks').click();
  await page.waitForSelector('[data-wb-task-id="task-a"]');
  assert.equal(await page.locator('#wb-native-task').isDisabled(),true);
  await page.locator('[data-wb-task-id="task-a"]').click();
  await page.waitForFunction(()=>!document.querySelector('#wb-native-task').disabled);
  await page.screenshot({path:resolve(output,'native-entry-wide.png'),fullPage:true});
  await page.setViewportSize({width:360,height:780});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve(output,'native-entry-narrow.png'),fullPage:true});
  await page.setViewportSize({width:960,height:800});
  await page.locator('#wb-native-task').click();await checkNativePage();
  assert.deepEqual(state.opens.at(-1).body,{target:'task',projectId:'project-a',taskId:'task-a',expectedFocusRevision:1});

  await gotoApp();await enterProject();await page.locator('#wb-tab-tasks').click();
  await page.waitForFunction(()=>!document.querySelector('#wb-native-task').disabled);
  for(const mode of ['offline','conflict','expired','drift','unsafe']){
   state.mode=mode;
   await page.locator('#wb-native-task').click();
   await page.waitForFunction(()=>document.querySelector('.workbench-page')?.innerText.includes('重新打开'));
   assert.equal(new URL(page.url()).pathname,'/','failed entry remains in the management page');
   assert.equal(context.pages().length,1);
  }
  assert.equal(state.opens.length,9);
  state.mode='ready';
  await page.locator('#wb-native-task').focus();await page.keyboard.press('Enter');await checkNativePage();
  assert.equal(state.opens.length,10);
  assert.equal(fixture.state.writes.length,0);
  assert.deepEqual(state.errors,[]);
  await writeFile(resolve(output,'native-entry-evidence.json'),JSON.stringify({engine:'webkit',version:browser.version(),
   checks:['current-tab home/project/task and verified source navigation','same-origin credential mode','keyboard navigation',
    '503/409/expiry/identity/unsafe URL remain on AAA','no ticket in persistent UI','no task dispatch','wide/narrow layout'],
   opens:state.opens.length,fixtureWrites:fixture.state.writes.length,errors:state.errors,
   scope:'synthetic HTTP and WebKit navigation only; S actual in-app browser acceptance remains separate'},null,2));
 }finally{await context.close();await browser.close();await fixture.close();}
});

test('a browser that silently refuses navigation shows retry instead of success',async()=>{
 const fixture=await createMemoryDynamicsFixture(),browser=await engines.webkit.launch({headless:true});
 const context=await browser.newContext({viewport:{width:800,height:700}}),page=await context.newPage();
 try{
  await page.goto(fixture.url);
  await page.evaluate(async()=>{
   const {createWorkbenchView}=await import('/workbench-view.mjs');
   const mount=document.createElement('div');mount.id='native-stall-probe';document.body.append(mount);
   let view;
   const render=()=>mount.replaceChildren(view.view());
   const host=()=>({connection:'online',instanceId:'fixture',authEpoch:1,onError(){}});
   const client={async request(path){
    if(path!=='/api/workbench/native-open')throw Error('unexpected request');
    window.stalledNavigation.count++;
    return {version:'0.1.0',status:'ready',url:location.origin+'/open#'+'B'.repeat(43),
     expiresAt:new Date(Date.now()+30000).toISOString(),target:{kind:'home',environmentId:'env-a'}};
   }};
   view=createWorkbenchView(client,render,host,()=>{},()=>{});
   window.stalledNavigation={count:0,view,mount};
   view.sync();render();mount.querySelector('#wb-native-home').click();
  });
  await page.waitForFunction(()=>document.querySelector('#native-stall-probe')?.innerText.includes('浏览器仍停留在原页'),null,{timeout:7000});
  assert.equal(await page.evaluate(()=>window.stalledNavigation.count),1,'no automatic ticket retry');
  assert.equal(new URL(page.url()).pathname,'/');
  assert.equal(await page.evaluate(()=>{
   const ticket='B'.repeat(43);
   return document.documentElement.outerHTML.includes(ticket)||
    Array.from({length:sessionStorage.length},(_,index)=>sessionStorage.getItem(sessionStorage.key(index))).some(value=>value?.includes(ticket));
  }),false,'ticket never enters the DOM or session storage');
  assert.equal(await page.locator('#native-stall-probe #wb-native-home').isDisabled(),false);
  await page.locator('#native-stall-probe #wb-native-home').click();
  await page.waitForFunction(()=>window.stalledNavigation.count===2);
  await page.evaluate(()=>{window.stalledNavigation.view.dispose();window.stalledNavigation.mount.remove();});
 }finally{await context.close();await browser.close();await fixture.close();}
});
