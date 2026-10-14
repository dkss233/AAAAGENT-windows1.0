import test from 'node:test';
import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir, writeFile} from 'node:fs/promises';

const root = resolve(import.meta.dirname, '../../../..');
const output = resolve(process.env.WORKBENCH_BROWSER_OUTPUT ?? join(root, 'artifacts/W0-I/workbench-54/w1-focus-mainline'));
const load = async path => import(pathToFileURL(join(root, 'code/desktop-pet/dist', path)));
const {fixture} = await load('tests/management/helpers.js');
const {startManagementServer} = await load('management/server.js');
const {ManagementSettingsStore} = await load('management/settings-store.js');
const {ManagementRuntime} = await load('management/runtime.js');
const {SqliteWorkbenchStore} = await load('app/workbench-store.js');
const {WorkbenchService} = await load('app/workbench-service.js');
const {webkit} = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const at = '2026-09-27T00:00:00.000Z';

test('real management HTTP, SQLite reopen and WebKit preserve exact focus across random ports', async t => {
  await mkdir(output, {recursive:true});
  const f = await fixture(t);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const project = {id:'local-a',name:'A',abstract:'',detailRef:{rootPath:'/workspace/a'},version:1,updatedAt:at};
  const projects = {
    async get(id) { return id === project.id ? project : null; },
    async list({offset=0,limit=25}={}) { return {items:[project],total:1,offset,limit}; },
    async save() { throw Error('unexpected project write'); },
    async remove() { throw Error('unexpected project removal'); },
    async close() {},
  };
  const memory = {characters:()=>[],list(){throw Error('unexpected memory read');},edit(){throw Error('unexpected memory write');},
    context(){throw Error('unexpected memory context');},prompt(){throw Error('unexpected prompt');},savePrompt(){throw Error('unexpected prompt write');}};
  const native = {
    async environmentDescriptor(){return {environmentId:'native-env'};},
    async shellSnapshot(){return {snapshotSequence:7,updatedAt:at,projects:[{id:'native-project',workspaceRoot:'/workspace/a'}],
      threads:[{id:'native-thread',projectId:'native-project',modelSelection:{instanceId:'codex'},latestTurn:null,
        hasPendingApprovals:false,hasPendingUserInput:false}]};},
    async threadSnapshot(){return {thread:{id:'native-thread',projectId:'native-project',modelSelection:{instanceId:'codex'},messages:[]}};},
    async dispatch(){throw Error('provider dispatch forbidden');},
    async readReceipt(){return null;},
  };
  const database = join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite');
  let store = new SqliteWorkbenchStore(database);
  const options = () => ({uiRoot:resolve(root,'code/desktop-pet/management/ui'),settings,memory,projects,
    workbench:new WorkbenchService(projects,store,native),
    snapshot:()=>({apiVersion:1,runtime:runtime.identity(),modules:[],events:[],settings:settings.snapshot(),
      adapters:[],credentials:[],characters:[{id:'companion',name:'companion'}]})});
  let first = await startManagementServer(options());
  t.after(async()=>{if(first)await first.close();if(store)store.close();});
  const post = (server,path,body)=>fetch(server.origin+path,{method:'POST',headers:{Authorization:`Bearer ${server.token}`,
    Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post(first,'/api/workbench/project-bindings',{
    projectId:'local-a',t3ProjectId:'native-project',workspaceRoot:'/workspace/a'})).status,200);
  const registered=await post(first,'/api/workbench/tasks',{
    projectId:'local-a',t3ProjectId:'native-project',threadId:'native-thread',provider:'codex'});
  assert.equal(registered.status,200);
  const task=await registered.json();
  const browser=await webkit.launch({headless:true});t.after(()=>browser.close());
  const context=await browser.newContext(),page=await context.newPage();t.after(()=>context.close());
  const focusPosts=[];page.on('request',req=>{if(new URL(req.url()).pathname==='/api/workbench/focus'&&req.method()==='POST')focusPosts.push(req.url());});
  const call=async(server,method='GET',taskId=null,expectedRevision=0)=>{
    await page.goto(server.url);
    return page.evaluate(async({token,method,taskId,expectedRevision})=>{
      const {ManagementClient}=await import('/api.mjs');
      const client=new ManagementClient(token);
      return method==='GET'
        ?client.request('/api/workbench/focus?projectId=local-a',{credentials:'same-origin'})
        :client.request('/api/workbench/focus',{method:'POST',credentials:'same-origin',body:{projectId:'local-a',taskId,expectedRevision}});
    },{token:server.token,method,taskId,expectedRevision});
  };
  const empty=await call(first);
  assert.equal(empty.task,null);assert.equal(empty.revision,0);
  const selected=await call(first,'POST',task.id,0);
  assert.equal(selected.task.id,task.id);assert.equal(selected.revision,1);assert.equal(focusPosts.length,1);
  const browserCookie=(await context.cookies(first.origin+'/api/workbench/focus')).find(cookie=>cookie.name==='aaaagent_wb_web_v1');
  assert.equal(browserCookie?.httpOnly,true);assert.equal(browserCookie?.sameSite,'Strict');
  await first.close();first=null;store.close();store=null;
  store=new SqliteWorkbenchStore(database);
  const second=await startManagementServer(options());t.after(()=>second.close());
  assert.notEqual(new URL(second.origin).port,new URL(focusPosts[0]).port);
  const restored=await call(second);
  assert.equal(restored.task.id,task.id);assert.equal(restored.revision,1);assert.equal(focusPosts.length,1);
  const other=await browser.newContext();t.after(()=>other.close());
  const otherPage=await other.newPage();await otherPage.goto(second.url);
  const isolated=await otherPage.evaluate(async token=>{
    const {ManagementClient}=await import('/api.mjs');
    return new ManagementClient(token).request('/api/workbench/focus?projectId=local-a',{credentials:'same-origin'});
  },second.token);
  assert.equal(isolated.task,null);assert.equal(isolated.revision,0);
  await writeFile(resolve(output,'real-browser.json'),JSON.stringify({
    firstPort:new URL(focusPosts[0]).port,secondPort:new URL(second.origin).port,
    sameBrowserRestoredTask:restored.task.id===task.id,differentBrowserIsolated:isolated.task===null,
    httpOnly:browserCookie.httpOnly,sameSite:browserCookie.sameSite,focusPosts:focusPosts.length,
    backend:'production management server, workbench service and SQLite reopened from isolated temporary trial configuration',
    browser:'WebKit',providerDispatches:0,limitations:'Synthetic T3 read only; no actual user account, Host task, model, device, installation or natural-use acceptance'},null,2)+'\n');
});
