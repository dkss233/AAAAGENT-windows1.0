import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fixture } from '../management/helpers.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';

const at = '2026-09-27T00:00:00.000Z';

test('native browser handoff keeps exact identity and browser/desktop focus before issuing a ticket', async t => {
  const f = await fixture(t), settings = await ManagementSettingsStore.open(join(f.c.projectRoot,'settings.json'),f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const project: ProjectEntry = {id:'a',name:'A',abstract:'',detailRef:{rootPath:'/workspace/a'},version:1,updatedAt:at};
  const projects: ProjectIndexPort = {async get(id){return id==='a'?project:null;},async list(){throw Error();},async save(){throw Error();},async remove(){throw Error();},async close(){}};
  const memory: ManagementMemoryPort = {characters:()=>[],list(){throw Error();},edit(){throw Error();},context(){throw Error();},prompt(){throw Error();},savePrompt(){throw Error();}};
  const store = new SqliteWorkbenchStore(join(f.c.projectRoot,'data/desktop-pet/workbench.sqlite'));t.after(()=>store.close());
  let environmentId='env', provider='codex', issued=0;
  const thread=()=>({id:'thread',projectId:'project',modelSelection:{instanceId:provider},latestTurn:null,hasPendingApprovals:false,hasPendingUserInput:false});
  const native:T3WorkbenchClient = {async environmentDescriptor(){return {environmentId};},
    async shellSnapshot(){return {snapshotSequence:1,updatedAt:at,projects:[{id:'project',workspaceRoot:'/workspace/a'}],threads:[thread()]};},
    async threadSnapshot(){return {thread:thread()};},async dispatch(){throw Error('navigation must never dispatch');}};
  const service=new WorkbenchService(projects,store,native,false,undefined,undefined,undefined,undefined,{async openBrowser(target,options){issued++;assert.equal(target.environmentId,'env');assert.deepEqual(options,{returnToOriginalManagement:true});return {url:'http://127.0.0.1:12345/open#'+'a'.repeat(43),expiresAt:new Date(Date.now()+60000).toISOString()};}});
  await service.bindProject('a','project','/workspace/a');const task=await service.bindTask('a','project','thread','codex');
  const server=await startManagementServer({uiRoot:resolve(import.meta.dirname,'../../../management/ui'),settings,memory,projects,workbench:service,
    snapshot:()=>({apiVersion:1,runtime:runtime.identity(),modules:[],events:[],settings:settings.snapshot(),adapters:[],credentials:[],characters:[]})});t.after(()=>server.close());
  const headers={Authorization:'Bearer '+server.token,Origin:server.origin,'Content-Type':'application/json'};
  const post=(body:unknown,extra={},path='/api/workbench/native-open')=>fetch(server.origin+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await post({target:'home'},{Authorization:''})).status,401);
  assert.equal((await post({target:'home'},{Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await post({target:'home',url:'https://foreign.invalid'})).status,400);
  assert.equal(issued,0);
  assert.equal((await post({target:'home'})).status,200);
  assert.equal((await post({target:'home'},{},'/api/workbench/native-open/desktop')).status,200);
  assert.equal((await post({target:'project',projectId:'a'})).status,200);
  assert.equal((await post({target:'task',projectId:'a',taskId:task.id})).status,200);
  const focus=await service.readWebFocus('a',undefined),cookie=focus.setCookie!.split(';')[0]!;
  await service.saveWebFocus('a',cookie,task.id,0);
  const selected={target:'task',projectId:'a',taskId:task.id,expectedFocusRevision:1};
  assert.equal((await post(selected,{Cookie:cookie})).status,200);
  const before=issued;
  assert.equal((await post({...selected,expectedFocusRevision:0},{Cookie:cookie})).status,409);
  assert.equal((await post(selected)).status,409);assert.equal(issued,before);
  provider='dsh';assert.equal((await post(selected,{Cookie:cookie})).status,409);assert.equal(issued,before);provider='codex';
  environmentId='changed';assert.equal((await post({target:'task',projectId:'a',taskId:task.id})).status,409);assert.equal(issued,before);environmentId='env';
  assert.equal((await post({target:'task',projectId:'a',taskId:task.id},{},'/api/workbench/native-open/desktop')).status,409);
  assert.equal(issued,before);
});
