import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagementClient } from '../../management/ui/api.mjs';

test('only workbench focus and continuation routes opt into a browser profile cookie', async () => {
  const calls=[];
  const client=new ManagementClient('synthetic-session-token',async(path,options)=>{
    calls.push({path,credentials:options.credentials,method:options.method});
    return {ok:true,status:200,json:async()=>({accepted:true})};
  });
  await client.request('/api/workbench/status');
  await client.request('/api/workbench/focus?projectId=project-a',{credentials:'same-origin'});
  await client.request('/api/workbench/focus',{method:'POST',body:{projectId:'project-a',taskId:null,expectedRevision:0},credentials:'same-origin'});
  await client.request('/api/workbench/continuation?draftId=draft-a',{credentials:'same-origin'});
  await client.request('/api/workbench/continuation/draft?draftId=draft-a',{credentials:'same-origin'});
  await client.request('/api/workbench/continuations?projectId=project-a',{credentials:'same-origin'});
  await client.request('/api/workbench/continuation/prepare',{method:'POST',body:{projectId:'project-a'},credentials:'same-origin'});
  await assert.rejects(client.request('/api/workbench/commands/continue',{method:'POST',credentials:'same-origin'}),/仅工作台焦点与续接/);
  await assert.rejects(client.request('/api/workbench/tasks',{credentials:'same-origin'}),/仅工作台焦点/);
  assert.deepEqual(calls,[
    {path:'/api/workbench/status',credentials:'omit',method:'GET'},
    {path:'/api/workbench/focus?projectId=project-a',credentials:'same-origin',method:'GET'},
    {path:'/api/workbench/focus',credentials:'same-origin',method:'POST'},
    {path:'/api/workbench/continuation?draftId=draft-a',credentials:'same-origin',method:'GET'},
    {path:'/api/workbench/continuation/draft?draftId=draft-a',credentials:'same-origin',method:'GET'},
    {path:'/api/workbench/continuations?projectId=project-a',credentials:'same-origin',method:'GET'},
    {path:'/api/workbench/continuation/prepare',credentials:'same-origin',method:'POST'},
  ]);
});
