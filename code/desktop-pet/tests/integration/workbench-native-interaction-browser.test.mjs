import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {createMemoryDynamicsFixture} from '../management/memory-dynamics-fixture.mjs';

const root=resolve(import.meta.dirname,'../../../..');
const output=resolve(process.env.WORKBENCH_NATIVE_BROWSER_OUTPUT??join(root,'artifacts/W1/native-web-interactions-54/browser'));
const load=async path=>import(pathToFileURL(join(root,'code/desktop-pet/dist',path)));
const {webkit}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const project={id:'project-a',name:'合成项目',detailRef:{rootPath:'/synthetic/project-a'}};
const task=id=>({id,projectId:project.id,provider:'codex',origin:'t3',environmentId:'native-env',
 t3ProjectId:'native-project',threadId:'thread-'+id,providerInstanceId:'codex'});
const taskA=task('task-a'),taskB=task('task-b');
const approval={id:'approval-one',taskId:taskA.id,nativeRequestId:'native-approval',answerLifetime:'live_only',
 nativeTurnId:'turn-a',version:8,state:'pending',kind:'approval',summary:'运行本地命令？',choiceSource:'t3_default',
 choices:[{id:'accept',label:'允许一次',warning:'将运行命令'},{id:'acceptAlways',label:'总是允许'},
  {id:'decline',label:'拒绝'}]};
const question={id:'question-two',taskId:taskA.id,nativeRequestId:'native-question',answerLifetime:'durable',
 version:9,state:'pending',kind:'question',questions:[
  {id:'q-one',prompt:'选择需要的内容',allowMultiple:true,allowCustomAnswer:false,
   options:[{id:'alpha',label:'甲',description:'第一项'},{id:'beta',label:'乙',description:'第二项'}]},
  {id:'q-two',prompt:'请说明原因',allowMultiple:false,allowCustomAnswer:true,options:[]}]};

test('native approval and question UI scopes requests, requires explicit answers, and never replays uncertain POST',async t=>{
 await mkdir(output,{recursive:true});
 const fixture=await createMemoryDynamicsFixture();t.after(()=>fixture.close());
 const browser=await webkit.launch({headless:true});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1160,height:900},locale:'zh-CN'});t.after(()=>context.close());
 const page=await context.newPage();page.setDefaultTimeout(7000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const state={focus:{version:'0.1.0',projectId:project.id,revision:0,task:null},dispatchEnabled:false,
  interactions:[approval,question],requests:[],commands:new Map(),dropNext:false,malformed:false,
  bindingFault:false,commandFault:false,delayNext:false};
 state.bindings=[];
 const reply=(route,status,data)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
 await page.route('**/api/workbench/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname,method=req.method();
  const body=method==='POST'?req.postDataJSON():null;
  assert.equal(req.headers().authorization,'Bearer memory-dynamics-synthetic-session');
  state.requests.push({path,method,query:url.search,body});
  if(path==='/api/workbench/status')return reply(route,200,{version:'0.1.1',readAvailable:true,
   dispatchEnabled:state.dispatchEnabled,sourceOpening:'verified_same_origin_task_detail',preciseTurnJump:false});
  if(path==='/api/workbench/provider-models')return reply(route,200,{version:'0.1.0',available:false,
   provider:'codex',instanceId:'codex',checkedAt:null,models:[]});
  if(path==='/api/workbench/tasks/creations')return reply(route,200,{version:'0.1.0',projectId:project.id,creations:[]});
  if(path==='/api/workbench/tasks')return reply(route,200,{tasks:[taskA,taskB].map(task=>({task,projection:null}))});
  if(path==='/api/workbench/focus'){
   if(method==='GET')return reply(route,200,state.focus);
   assert.equal(body.projectId,project.id);assert.equal(body.expectedRevision,state.focus.revision);
   state.focus={...state.focus,revision:state.focus.revision+1,task:[taskA,taskB].find(task=>task.id===body.taskId)||null};
   return reply(route,200,state.focus);
  }
  if(path==='/api/workbench/task-detail'){
   const task=[taskA,taskB].find(task=>task.id===url.searchParams.get('taskId'));
   assert.equal(url.searchParams.get('projectId'),project.id);
   return reply(route,200,{task,native:{thread:{id:task.threadId,projectId:task.t3ProjectId,
    modelSelection:{instanceId:'codex'},messages:[]}},preciseTurnJump:false});
  }
  if(path==='/api/workbench/continuations')return reply(route,200,{version:'0.1.0',projectId:project.id,
   taskId:state.focus.task.id,focusRevision:state.focus.revision,drafts:[],truncated:false});
  if(path==='/api/workbench/interactions'){
   assert.equal(method,'GET');assert.equal(url.searchParams.get('projectId'),project.id);
   const selected=[taskA,taskB].find(task=>task.id===url.searchParams.get('taskId'));
   if(state.malformed)return reply(route,200,{status:'supported',task:selected,interactions:[{...approval,taskId:'foreign'}]});
   return reply(route,200,{status:'supported',task:selected,
    interactions:selected.id===taskA.id?state.interactions:[]});
  }
  if(path==='/api/workbench/interactions/bindings'){
   if(state.bindingFault)return reply(route,503,{error:{code:'unavailable',message:'synthetic binding read failed'}});
   const selected=[taskA,taskB].find(task=>task.id===url.searchParams.get('taskId'));
   assert.equal(url.searchParams.get('projectId'),project.id);
   return reply(route,200,{status:'supported',task:selected,
    bindings:state.bindings.filter(binding=>binding.taskId===selected.id).map(({taskId,...binding})=>binding)});
  }
  if(path==='/api/workbench/interactions/respond'){
   assert.equal(method,'POST');assert.equal(body.projectId,project.id);assert.equal(body.taskId,taskA.id);
   const item=state.interactions.find(item=>item.id===body.interactionId);
   assert.equal(body.expectedVersion,item.version);
   const commandId=randomUUID(),value={command:{commandId,state:'accepted',task:taskA},resolution:'pending',interaction:item};
   state.commands.set(commandId,value);
   state.bindings.unshift({taskId:taskA.id,interactionId:item.id,commandId,kind:item.kind,requestVersion:item.version});
   if(state.dropNext){state.dropNext=false;return route.abort('failed');}
   if(state.delayNext){state.delayNext=false;await new Promise(resolve=>setTimeout(resolve,700));}
   return reply(route,200,value);
  }
  if(path==='/api/workbench/interactions/commands'){
   assert.equal(method,'GET');
   if(state.commandFault)return reply(route,503,{error:{code:'unavailable',message:'synthetic private read error'}});
   assert.equal(url.searchParams.get('projectId'),project.id);assert.equal(url.searchParams.get('taskId'),taskA.id);
   const binding=state.bindings.find(binding=>binding.interactionId===url.searchParams.get('interactionId'));
   return binding?reply(route,200,state.commands.get(binding.commandId)):
    reply(route,404,{error:{code:'not_found',message:'无原命令'}});
  }
  throw Error('Unexpected workbench route '+path);
 });
 await page.goto(fixture.url);
 await page.evaluate(async project=>{
  const [{ManagementClient},{createWorkbenchView}]=await Promise.all([import('/api.mjs'),import('/workbench-view.mjs')]);
  const mount=document.createElement('div');document.body.replaceChildren(mount);
  let view;const render=()=>mount.replaceChildren(view.view());
  view=createWorkbenchView(new ManagementClient('memory-dynamics-synthetic-session'),render,
   ()=>({connection:'online',instanceId:'synthetic-native-ui',authEpoch:0,onError:()=>{}}),()=>{});
  view.open(project);render();
 },project);
 await page.locator('#wb-tab-tasks').click();
 await page.locator('[data-wb-task-id="task-a"]').click();
 await page.locator('[data-wb-interaction-id="approval-one"]').waitFor();
 assert.equal(await page.locator('[data-wb-interaction-id]').count(),2);
 await page.locator('[data-wb-interaction-id="approval-one"]').click();
 assert.match(await page.locator('#wb-interactions').innerText(),/T3 的后备选项/);
 assert.equal(await page.locator('.wb-interaction-option').count(),3);
 assert.equal(await page.locator('.wb-interaction-option input:checked').count(),0,'approval has no default choice');
 assert.equal(await page.locator('#wb-interaction-submit').isDisabled(),true);
 state.dispatchEnabled=true;await page.locator('#wb-reload').click();
 await page.locator('[data-wb-interaction-id="approval-one"]').click();
 assert.equal(await page.locator('#wb-interaction-submit').isDisabled(),true);
 const readableOptions=async()=>page.locator('.wb-interaction-option').evaluateAll(nodes=>nodes.map(node=>({
  inputWidth:node.querySelector('input').getBoundingClientRect().width,
  textWidth:node.querySelector('span').getBoundingClientRect().width,
  height:node.getBoundingClientRect().height})));
 for(const row of await readableOptions()){
  assert.ok(row.inputWidth>=14&&row.inputWidth<=18,`radio width ${row.inputWidth}`);
  assert.ok(row.textWidth>=120,`option text width ${row.textWidth}`);
  assert.ok(row.height<110,`option card height ${row.height}`);
 }
 await page.screenshot({path:join(output,'native-approval-options-wide.png'),fullPage:true});
 await page.setViewportSize({width:390,height:790});
 for(const row of await readableOptions()){
  assert.ok(row.inputWidth>=14&&row.inputWidth<=18,`narrow radio width ${row.inputWidth}`);
  assert.ok(row.textWidth>=120,`narrow option text width ${row.textWidth}`);
  assert.ok(row.height<110,`narrow option card height ${row.height}`);
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 await page.screenshot({path:join(output,'native-approval-options-narrow.png'),fullPage:true});
 await page.setViewportSize({width:1160,height:900});
 await page.getByLabel('拒绝').focus();await page.keyboard.press('Space');
 assert.equal(await page.locator('#wb-interaction-submit').isEnabled(),true);
 await page.locator('#wb-interaction-submit').click();
 await page.locator('[data-wb-interaction-attempt="approval-one"]').waitFor();
 const approvalPost=state.requests.filter(row=>row.path==='/api/workbench/interactions/respond')[0];
 assert.deepEqual(approvalPost.body,{projectId:project.id,taskId:taskA.id,interactionId:approval.id,
  expectedVersion:8,response:{type:'decide_approval',choiceId:'decline'}});
 assert.match(await page.locator('[data-wb-interaction-attempt="approval-one"]').innerText(),/命令已接收/);
 assert.match(await page.locator('[data-wb-interaction-attempt="approval-one"]').innerText(),/原生请求仍待处理/);
 const commandId=[...state.commands.keys()][0];state.commands.set(commandId,{...state.commands.get(commandId),resolution:'answered',interaction:undefined});
 await page.locator('[data-wb-interaction-read="approval-one"]').click();
 assert.match(await page.locator('[data-wb-interaction-attempt="approval-one"]').innerText(),/原生请求已解决/);
 state.commandFault=true;await page.locator('[data-wb-interaction-read="approval-one"]').click();
 await page.getByText('原命令暂不可读取',{exact:false}).waitFor();
 assert.equal(state.requests.filter(row=>row.path==='/api/workbench/interactions/respond').length,1);
 state.commandFault=false;
 state.interactions[0]={...approval,version:11};await page.locator('#wb-interactions-refresh').click();
 await page.getByText('原生请求版本或类型与已认领命令不一致',{exact:false}).waitFor();
 assert.equal(await page.locator('#wb-interaction-submit').isDisabled(),true);
 state.interactions[0]=approval;await page.locator('#wb-interactions-refresh').click();
 await page.locator('[data-wb-interaction-id="question-two"]').click();
 assert.equal(await page.locator('#wb-interaction-submit').isDisabled(),true);
 await page.getByLabel('甲').focus();await page.keyboard.press('Space');
 await page.getByLabel('乙').focus();await page.keyboard.press('Space');
 assert.equal(await page.locator('#wb-interaction-submit').isDisabled(),true);
 await page.locator('#wb-interaction-custom-1').fill('原因：需要两项');
 assert.equal(await page.locator('#wb-interaction-submit').isEnabled(),true);
 await page.screenshot({path:join(output,'native-question-answers-wide.png'),fullPage:true});
 state.dropNext=true;await page.locator('#wb-interaction-submit').click();
 await page.locator('[data-wb-interaction-attempt="question-two"]').waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-wb-interaction-attempt="question-two"]')?.innerText.includes('原命令 ID'));
 assert.equal(await page.locator('#wb-interaction-submit').isDisabled(),true);
 await page.locator('#wb-interactions-refresh').click();
 await page.locator('[data-wb-interaction-id="question-two"]').click();
 assert.equal(await page.locator('#wb-interaction-submit').isDisabled(),true);
 const posts=state.requests.filter(row=>row.path==='/api/workbench/interactions/respond');
 assert.equal(posts.length,2);
 assert.deepEqual(posts[1].body.response,{type:'answer_question',answers:[
  {questionId:'q-one',selectedOptionIds:['alpha','beta']},
  {questionId:'q-two',selectedOptionIds:[],customText:'原因：需要两项'}]});
 assert.equal(await page.locator('[data-wb-interaction-read="question-two"]').isDisabled(),false);
 const secondFixture=await createMemoryDynamicsFixture();t.after(()=>secondFixture.close());
 assert.notEqual(new URL(fixture.url).port,new URL(secondFixture.url).port);
 await page.goto(secondFixture.url);
 await page.evaluate(async project=>{
  const [{ManagementClient},{createWorkbenchView}]=await Promise.all([import('/api.mjs'),import('/workbench-view.mjs')]);
  const mount=document.createElement('div');document.body.replaceChildren(mount);
  let view;const render=()=>mount.replaceChildren(view.view());
  view=createWorkbenchView(new ManagementClient('memory-dynamics-synthetic-session'),render,
   ()=>({connection:'online',instanceId:'synthetic-native-ui',authEpoch:0,onError:()=>{}}),()=>{});
  view.open(project);render();
 },project);
 await page.locator('#wb-tab-tasks').click();
 await page.locator('[data-wb-interaction-attempt="question-two"]').waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-wb-interaction-attempt="question-two"]')?.innerText.includes('命令已接收'));
 assert.equal(state.requests.filter(row=>row.path==='/api/workbench/interactions/respond').length,2);
 const questionBinding=state.bindings.find(binding=>binding.interactionId===question.id);
 state.commands.set(questionBinding.commandId,{...state.commands.get(questionBinding.commandId),
  resolution:'expired',interaction:undefined});
 await page.locator('[data-wb-interaction-read="question-two"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-wb-interaction-attempt="question-two"]')?.innerText.includes('原生请求已过期'));
 const third={...approval,id:'approval-three',nativeRequestId:'native-third',version:10,
  choiceSource:'provider',summary:'第三项审批'};
 state.interactions.push(third);await page.locator('#wb-interactions-refresh').click();
 await page.locator('[data-wb-interaction-id="approval-three"]').click();
 await page.getByLabel('拒绝').focus();await page.keyboard.press('Space');
 assert.equal(await page.locator('#wb-interaction-submit').isEnabled(),true);
 state.bindingFault=true;await page.locator('#wb-interactions-refresh').click();
 await page.getByText('服务端已认领请求暂不可读取',{exact:false}).waitFor();
 assert.equal(await page.locator('#wb-interaction-submit').isDisabled(),true);
 state.bindingFault=false;await page.locator('#wb-interactions-refresh').click();
 await page.locator('[data-wb-interaction-id="approval-three"]').click();
 assert.equal(await page.locator('#wb-interaction-submit').isEnabled(),true);
 state.delayNext=true;await page.locator('#wb-interaction-submit').click();
 await page.locator('[data-wb-task-id="task-b"]').click();
 await page.getByText('当前准确任务没有可操作的原生请求。').waitFor();
 assert.equal(await page.locator('[data-wb-interaction-attempt]').count(),0);
 await page.waitForTimeout(800);
 assert.equal(await page.locator('[data-wb-interaction-attempt]').count(),0);
 await page.locator('[data-wb-task-id="task-a"]').click();
 await page.locator('[data-wb-interaction-attempt="approval-three"]').waitFor();
 assert.equal(state.requests.filter(row=>row.path==='/api/workbench/interactions/respond').length,3);
 await page.locator('[data-wb-task-id="task-b"]').click();
 await page.getByText('当前准确任务没有可操作的原生请求。').waitFor();
 assert.equal(await page.locator('[data-wb-interaction-attempt]').count(),0);
 await page.locator('[data-wb-task-id="task-a"]').click();
 await page.locator('[data-wb-interaction-attempt="question-two"]').waitFor();
 state.malformed=true;await page.locator('#wb-interactions-refresh').click();
 await page.getByText('原生请求读取失败',{exact:false}).waitFor();
 assert.equal(await page.locator('[data-wb-interaction-id]').count(),0);
 assert.equal(state.requests.filter(row=>row.path==='/api/workbench/interactions/respond').length,3);
 await page.setViewportSize({width:390,height:790});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 await page.screenshot({path:join(output,'native-interaction-narrow.png'),fullPage:true});
 await page.setViewportSize({width:1160,height:900});
 await page.screenshot({path:join(output,'native-interaction-wide.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 await writeFile(join(output,'evidence.json'),JSON.stringify({browser:'WebKit '+browser.version(),
  checks:['exact project/task/version reads','all fallback approval choices','explicit approval','complete multi-question answer',
   'command accepted separate from answered and expired','lost response never resubmitted','cross-port cold read',
   'binding and command read failures block or warn','stale request version blocks answer',
   'late response after task switch stays scoped','malformed read fail closed',
   '390px and 1160px layout with measured approval option readability'],
  posts:state.requests.filter(row=>row.path==='/api/workbench/interactions/respond').length,
  commandReads:state.requests.filter(row=>
    row.path==='/api/workbench/interactions/commands').length,
  limit:'Synthetic HTTP and WebKit only; no real Host/provider, installed app, device or natural-use acceptance'},null,2)+'\n');
});

test('real management HTTP and reopened SQLite recover one claimed native response without another dispatch',async t=>{
 await mkdir(output,{recursive:true});
 const [{fixture},{startManagementServer},{ManagementSettingsStore},{ManagementRuntime},
  {SqliteWorkbenchStore},{WorkbenchService}]=await Promise.all([
   load('tests/management/helpers.js'),load('management/server.js'),load('management/settings-store.js'),
   load('management/runtime.js'),load('app/workbench-store.js'),load('app/workbench-service.js')]);
 const f=await fixture(t),settings=await ManagementSettingsStore.open(join(f.c.projectRoot,'settings.json'),f.c);
 const runtime=new ManagementRuntime(f.c.sourceRevision),at='2026-09-27T00:00:00.000Z';
 const actualProject={id:'local-a',name:'隔离项目',abstract:'',detailRef:{rootPath:f.c.projectRoot},version:1,updatedAt:at};
 const projects={async get(id){return id===actualProject.id?actualProject:null;},
  async list({offset=0,limit=25}={}){return {items:[actualProject],total:1,offset,limit};},
  async save(){throw Error('unexpected project write');},async remove(){throw Error('unexpected project removal');},async close(){}};
 const memory={characters:()=>[],list(){throw Error('unexpected companion read');},
  edit(){throw Error('unexpected companion write');},context(){throw Error('unexpected companion context');},
  prompt(){throw Error('unexpected companion prompt');},savePrompt(){throw Error('unexpected companion write');}};
 const activities=[{id:'native-approval-event',kind:'approval.requested',tone:'approval',summary:'允许执行本地命令？',
  turnId:'turn-1',sequence:8,createdAt:at,payload:{requestId:'native-request-1',options:[
   {decision:'accept',label:'允许一次',warning:'将执行命令'},{decision:'decline',label:'拒绝'}]}}];
 let dispatches=0;
 const native={async environmentDescriptor(){return {environmentId:'native-env'};},
  async shellSnapshot(){return {snapshotSequence:10,updatedAt:at,
   projects:[{id:'native-project',workspaceRoot:f.c.projectRoot}],
   threads:[{id:'native-thread',projectId:'native-project',modelSelection:{instanceId:'codex'},
    runtimeMode:'approval-required',interactionMode:'default',latestTurn:{turnId:'turn-1',state:'running'},
    hasPendingApprovals:true,hasPendingUserInput:false}]};},
  async threadSnapshot(){return {thread:{id:'native-thread',projectId:'native-project',
   modelSelection:{instanceId:'codex'},runtimeMode:'approval-required',interactionMode:'default',
   session:{threadId:'native-thread',status:'running',activeTurnId:'turn-1'},activities,messages:[]}};},
  async dispatch(command){dispatches++;assert.equal(command.type,'thread.approval.respond');
   assert.equal(command.requestId,'native-request-1');assert.equal(command.decision,'decline');return {sequence:11};},
  async readReceipt(){return null;}};
 const database=join(f.c.projectRoot,'data/desktop-pet/workbench.sqlite');
 let store=new SqliteWorkbenchStore(database),first=null,second=null;
 const options=()=>({uiRoot:resolve(root,'code/desktop-pet/management/ui'),settings,memory,projects,
  workbench:new WorkbenchService(projects,store,native,true),
  snapshot:()=>({apiVersion:1,runtime:runtime.identity(),modules:[],events:[],settings:settings.snapshot(),
   adapters:[],credentials:[],characters:[{id:'companion',name:'companion'}]})});
 t.after(async()=>{if(first)await first.close();if(second)await second.close();if(store)store.close();});
 first=await startManagementServer(options());
 const post=(server,path,body)=>fetch(server.origin+path,{method:'POST',headers:{Authorization:`Bearer ${server.token}`,
  Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post(first,'/api/workbench/project-bindings',{
  projectId:actualProject.id,t3ProjectId:'native-project',workspaceRoot:f.c.projectRoot})).status,200);
 const taskResponse=await post(first,'/api/workbench/tasks',{
  projectId:actualProject.id,t3ProjectId:'native-project',threadId:'native-thread',provider:'codex'});
 assert.equal(taskResponse.status,200);const boundTask=await taskResponse.json();
 const browser=await webkit.launch({headless:true});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1120,height:900},locale:'zh-CN'});t.after(()=>context.close());
 const page=await context.newPage();page.setDefaultTimeout(8000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 async function openView(server){
  await page.goto(server.origin+'/');
  await page.evaluate(async({token,project})=>{
   const [{ManagementClient},{createWorkbenchView}]=await Promise.all([import('/api.mjs'),import('/workbench-view.mjs')]);
   const mount=document.createElement('div');document.body.replaceChildren(mount);
   let view;const render=()=>mount.replaceChildren(view.view());
   view=createWorkbenchView(new ManagementClient(token),render,
    ()=>({connection:'online',instanceId:'synthetic-management',authEpoch:0,onError:()=>{}}),()=>{});
   view.open(project);render();
  },{token:server.token,project:actualProject});
  await page.locator('#wb-tab-tasks').click();
  await page.locator(`[data-wb-task-id="${boundTask.id}"]`).waitFor();
 }
 await openView(first);
 await page.locator(`[data-wb-task-id="${boundTask.id}"]`).click();
 await page.locator('[data-wb-interaction-id]').first().waitFor();
 await page.locator('[data-wb-interaction-id]').first().click();
 await page.getByLabel('拒绝').check();
 let responseRequests=0;
 await page.route('**/api/workbench/interactions/respond',async route=>{
  responseRequests++;const response=await route.fetch();assert.equal(response.status(),200);
  await route.abort('failed');
 });
 await page.locator('#wb-interaction-submit').click();
 await page.locator('[data-wb-interaction-attempt]').waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-wb-interaction-attempt]')?.innerText.includes('命令已接收'));
 assert.equal(responseRequests,1);assert.equal(dispatches,1);
 const recovered=await fetch(first.origin+`/api/workbench/interactions/bindings?projectId=${actualProject.id}&taskId=${boundTask.id}`,
  {headers:{Authorization:`Bearer ${first.token}`}}).then(response=>response.json());
 assert.equal(recovered.bindings.length,1);
 const commandId=recovered.bindings[0].commandId,interactionId=recovered.bindings[0].interactionId;
 assert.match(await page.locator('[data-wb-interaction-attempt]').innerText(),/原生请求仍待处理/);
 await page.unroute('**/api/workbench/interactions/respond');
 const firstPort=new URL(first.origin).port;
 await first.close();first=null;store.close();store=null;
 store=new SqliteWorkbenchStore(database);second=await startManagementServer(options());
 await openView(second);
 await page.locator(`[data-wb-interaction-attempt="${interactionId}"]`).waitFor();
 await page.waitForFunction(id=>document.querySelector(`[data-wb-interaction-attempt="${id}"]`)?.innerText.includes('命令已接收'),interactionId);
 assert.match(await page.locator(`[data-wb-interaction-attempt="${interactionId}"]`).innerText(),/原生请求仍待处理/);
 assert.equal(dispatches,1);assert.equal(responseRequests,1);
 activities.push({id:'native-resolved-event',kind:'approval.resolved',tone:'info',summary:'已解决',
  turnId:'turn-1',sequence:12,createdAt:at,payload:{requestId:'native-request-1'}});
 await page.locator(`[data-wb-interaction-read="${interactionId}"]`).click();
 await page.waitForFunction(id=>document.querySelector(`[data-wb-interaction-attempt="${id}"]`)?.innerText.includes('原生请求已解决'),interactionId);
 assert.equal(dispatches,1);assert.deepEqual(errors,[]);
 await page.screenshot({path:join(output,'native-interaction-reopened-http.png'),fullPage:true});
 await writeFile(join(output,'production-http-evidence.json'),JSON.stringify({browser:'WebKit '+browser.version(),
  firstPort,secondPort:new URL(second.origin).port,taskId:boundTask.id,interactionId,commandId,
  responseRequests,syntheticNativeDispatches:dispatches,sqliteReopened:true,commandColdRead:true,
  finalResolution:'answered',limit:'Production management HTTP and isolated SQLite with synthetic T3 adapter; no real Host/provider, installed app, device or natural-use acceptance'},null,2)+'\n');
});
