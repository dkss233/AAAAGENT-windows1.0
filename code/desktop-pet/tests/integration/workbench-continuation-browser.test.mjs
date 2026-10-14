import test from 'node:test';
import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir, writeFile} from 'node:fs/promises';

const root=resolve(import.meta.dirname,'../../../..');
const output=resolve(process.env.WORKBENCH_BROWSER_OUTPUT??join(root,'artifacts/W0-I/workbench-54/continuation-browser-mainline'));
const load=async path=>import(pathToFileURL(join(root,'code/desktop-pet/dist',path)));
const {fixture}=await load('tests/management/helpers.js');
const {startManagementServer}=await load('management/server.js');
const {ManagementSettingsStore}=await load('management/settings-store.js');
const {ManagementRuntime}=await load('management/runtime.js');
const {SqliteWorkbenchStore}=await load('app/workbench-store.js');
const {WorkbenchService}=await load('app/workbench-service.js');
const {webkit}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const at='2026-09-27T00:00:00.000Z';

test('production management HTTP, SQLite reopen and WebKit recover one exact web draft across ports',async t=>{
 await mkdir(output,{recursive:true});
 const f=await fixture(t),settings=await ManagementSettingsStore.open(join(f.c.projectRoot,'settings.json'),f.c);
 const runtime=new ManagementRuntime(f.c.sourceRevision);
 const project={id:'local-a',name:'A',abstract:'',detailRef:{rootPath:'/workspace/a'},version:1,updatedAt:at};
 const projects={async get(id){return id===project.id?project:null;},
  async list({offset=0,limit=25}={}){return {items:[project],total:1,offset,limit};},
  async save(){throw Error('unexpected project write');},async remove(){throw Error('unexpected project removal');},async close(){}};
 const memory={characters:()=>[],list(){throw Error('unexpected companion read');},
  edit(){throw Error('unexpected companion write');},context(){throw Error('unexpected companion context');},
  prompt(){throw Error('unexpected companion prompt');},savePrompt(){throw Error('unexpected companion write');}};
 let dispatches=0;
 const native={async environmentDescriptor(){return {environmentId:'native-env'};},
  async shellSnapshot(){return {snapshotSequence:7,updatedAt:at,projects:[{id:'native-project',workspaceRoot:'/workspace/a'}],
   threads:[{id:'native-thread',projectId:'native-project',modelSelection:{instanceId:'codex'},
    runtimeMode:'approval-required',interactionMode:'default',latestTurn:null,
    hasPendingApprovals:false,hasPendingUserInput:false}]};},
  async threadSnapshot(){return {thread:{id:'native-thread',projectId:'native-project',
   modelSelection:{instanceId:'codex'},runtimeMode:'approval-required',interactionMode:'default',messages:[]}};},
  async dispatch(){dispatches++;throw Error('provider dispatch forbidden');},async readReceipt(){return null;}};
 const database=join(f.c.projectRoot,'data/desktop-pet/workbench.sqlite');
 let store=new SqliteWorkbenchStore(database);
 const options=(dispatchEnabled=false)=>({uiRoot:resolve(root,'code/desktop-pet/management/ui'),settings,memory,projects,
  workbench:new WorkbenchService(projects,store,native,dispatchEnabled),
  snapshot:()=>({apiVersion:1,runtime:runtime.identity(),modules:[],events:[],settings:settings.snapshot(),
   adapters:[],credentials:[],characters:[{id:'companion',name:'companion'}]})});
 let first=await startManagementServer(options());
 t.after(async()=>{if(first)await first.close();if(store)store.close();});
 const post=(server,path,body)=>fetch(server.origin+path,{method:'POST',headers:{Authorization:`Bearer ${server.token}`,
  Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post(first,'/api/workbench/project-bindings',{
  projectId:project.id,t3ProjectId:'native-project',workspaceRoot:'/workspace/a'})).status,200);
 const response=await post(first,'/api/workbench/tasks',{
  projectId:project.id,t3ProjectId:'native-project',threadId:'native-thread',provider:'codex'});
 assert.equal(response.status,200);const task=await response.json();
 const browser=await webkit.launch({headless:true});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1200,height:920},locale:'zh-CN'});
 t.after(()=>context.close());const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const posts=[];page.on('request',req=>{if(req.method()==='POST'&&new URL(req.url()).pathname.startsWith('/api/workbench/continuation'))
  posts.push(new URL(req.url()).pathname);});
 async function openView(server,targetPage=page){
  await targetPage.goto(server.origin+'/');
  await targetPage.evaluate(async({token,project})=>{
   const [{ManagementClient},{createWorkbenchView}]=await Promise.all([
    import('/api.mjs'),import('/workbench-view.mjs')]);
   const mount=document.createElement('div');document.body.replaceChildren(mount);
   let view;const render=()=>mount.replaceChildren(view.view());
   view=createWorkbenchView(new ManagementClient(token),render,
    ()=>({connection:'online',instanceId:'synthetic-management',authEpoch:0,onError:()=>{}}),()=>{});
   view.open(project);render();
  },{token:server.token,project});
  await targetPage.locator('#wb-tab-tasks').click();
  await targetPage.locator(`[data-wb-task-id="${task.id}"]`).waitFor();
 }
 await openView(first);
 await page.locator(`[data-wb-task-id="${task.id}"]`).click();
 await page.locator('#wb-continuation-raw').waitFor();
 await page.locator('#wb-continuation-raw').fill('原话：请继续 A');
 await page.locator('#wb-continuation-reviewed').fill('审阅后：请继续 A');
 await page.locator('#wb-continuation-prepare').click();
 await page.locator('#wb-continuation-original').waitFor();
 assert.match(await page.locator('#wb-continuation-original').innerText(),/原话：请继续 A/);
 assert.equal(await page.locator('#wb-continuation-confirm').isDisabled(),true);
 assert.deepEqual(posts,['/api/workbench/continuation/prepare']);
 const cookie=(await context.cookies(first.origin+'/api/workbench/focus')).find(row=>row.name==='aaaagent_wb_web_v1');
 assert.equal(cookie?.httpOnly,true);assert.equal(cookie?.sameSite,'Strict');
 const firstPort=new URL(first.origin).port;
 await first.close();first=null;store.close();store=null;
 store=new SqliteWorkbenchStore(database);const second=await startManagementServer(options());
 t.after(()=>second.close());
 await openView(second);
 const listed=page.locator('[data-wb-continuation-id]');await listed.first().waitFor();
 assert.equal(await listed.count(),1);
 await listed.first().click();
 await page.locator('#wb-continuation-original').waitFor();
 assert.match(await page.locator('#wb-continuation-original').innerText(),/原话：请继续 A/);
 assert.match(await page.locator('#wb-continuation-confirmed').innerText(),/审阅后：请继续 A/);
 await page.locator('#wb-continuation-edit').fill('第二版：请继续 A');
 await page.locator('#wb-continuation-save').click();
 await page.getByText('第二版：请继续 A',{exact:true}).first().waitFor();
 await page.locator('#wb-continuation-dismiss').click();
 await page.getByText('这张未提交草稿已取消',{exact:false}).waitFor();
 await page.locator('#wb-continuation-refresh').click();
 await page.getByText('当前准确任务没有可列出的未取消草稿。').waitFor();
 assert.equal(await page.locator('#wb-continuation-confirm').isDisabled(),true);
 const other=await browser.newContext();t.after(()=>other.close());const otherPage=await other.newPage();
 await openView(second,otherPage);
 assert.equal(await otherPage.locator('#wb-continuation-raw').isDisabled(),true);
 assert.equal(await otherPage.locator('[data-wb-continuation-id]').count(),0);
 assert.equal(posts.filter(path=>path==='/api/workbench/continuation/prepare').length,1);
 assert.equal(dispatches,0);
 // This third isolated server enables only a throwing synthetic adapter to exercise ambiguous receipts.
 const enabled=await startManagementServer(options(true));t.after(()=>enabled.close());
 await openView(enabled);
 await page.locator('#wb-continuation-raw').fill('再次续接 A');
 await page.locator('#wb-continuation-reviewed').fill('审阅：再次续接 A');
 await page.locator('#wb-continuation-prepare').click();
 await page.locator('#wb-continuation-original').waitFor();
 await page.locator('[data-wb-continuation-id]').first().waitFor();
 await page.route('**/api/workbench/continuation/confirm',route=>route.abort('failed'));
 await page.locator('#wb-continuation-confirm').click();
 await page.getByText('确认结果待核对',{exact:false}).first().waitFor();
 assert.equal(dispatches,0);
 await page.unroute('**/api/workbench/continuation/confirm');
 await page.locator('#wb-continuation-read').click();
 await page.getByText('原命令尚未领取',{exact:false}).first().waitFor();
 await page.locator('[data-wb-continuation-id]').first().click();
 await page.getByText('已重新展示完整正文',{exact:false}).first().waitFor();
 await page.locator('#wb-continuation-confirm').click();
 await page.getByText('原命令结果仍待核对',{exact:false}).first().waitFor();
 assert.equal(dispatches,1);
 await openView(enabled);
 await page.locator('[data-wb-continuation-id]').first().click();
 await page.locator('#wb-continuation-original').waitFor();
 assert.equal(await page.locator('#wb-continuation-confirm').isDisabled(),true);
 await page.locator('#wb-continuation-read').click();
 assert.equal(dispatches,1);assert.deepEqual(errors,[]);
 await writeFile(join(output,'real-browser.json'),JSON.stringify({browser:'WebKit '+browser.version(),
  firstPort,
  secondPort:new URL(second.origin).port,originalRestored:true,revisionSaved:true,dismissed:true,
  otherBrowserIsolated:true,productionPreparePosts:1,productionDispatches:0,
  syntheticEnabledAbortedConfirmReadRecordedThenReconfirmed:true,syntheticProviderDispatches:dispatches,
  backend:'production management server, WorkbenchService and reopened isolated SQLite',
  limits:'Synthetic T3 read and throwing dispatch adapter in separately enabled test server; no real Host, provider/model, WeChat, device, installation or natural-use acceptance'},null,2)+'\n');
});
