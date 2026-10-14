import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.document={addEventListener(){},removeEventListener(){}};
globalThis.window={addEventListener(){},removeEventListener(){}};
const {nativeEntryTarget,consumeInitialNativeEntry}=await import('../../../../management/ui/native-workbench-view.mjs');
const {nativeTarget}=await import('../../../../../workbench/integration/t3-browser.mjs');
const origin='http://management-entry.invalid';
test('all three original public ticket target projections preserve the exact original identity',async()=>{
 const environmentId='environment-测试',t3ProjectId='project-测试',threadId='original-c-测试';
 const client={environmentDescriptor:async()=>({environmentId}),shellSnapshot:async()=>({projects:[{id:t3ProjectId,workspaceRoot:'/controlled'}]}),
  threadSnapshot:async()=>({thread:{id:threadId,projectId:t3ProjectId,modelSelection:{instanceId:'codex'}}})};
 for(const kind of ['home','project','task']){
  const emitted='/native'+await nativeTarget(client,{kind,environmentId,t3ProjectId,threadId,workspaceRoot:'/controlled',providerInstanceId:'codex'});
  const accepted=nativeEntryTarget(emitted,origin,environmentId);assert.equal(accepted.path,emitted);
  if(kind!=='home')assert.equal(accepted.environmentId,environmentId);
 }
});
test('external targets, credentials, fragments, auth routes and unknown query fields cannot open an iframe',()=>{
 for(const path of ['https://other.invalid/native/env/c','http://user:pass@management-entry.invalid/native/env/c','javascript:alert(1)',
  '/native/env/c#','/native/env/c#token','/native/pair','/native/login','/native/%70air/c','/native/%6Cogin/c',
  '/native/env/c?token=value','/native/?aaaEnvironment=env','/native/?aaaProject=p&aaaEnvironment=env&aaaProject=q',
  '/native/%/c','/native/env/c/extra','/native/env/c\\extra','/native/env/c\n'])assert.equal(nativeEntryTarget(path,origin,'env'),null,path);
});
test('a syntactically valid target is refused when its thread or project belongs to another mount environment',()=>{
 for(const path of ['/native/other-env/c','/native/?aaaProject=p&aaaEnvironment=other-env']){
  assert.ok(nativeEntryTarget(path,origin));assert.equal(nativeEntryTarget(path,origin,'env'),null);
 }
});
test('startup consumes the original target exactly once and removes duplicate or invalid target parameters',()=>{
 let current=new URL(origin+'/?nativePath='+encodeURIComponent('/native/env/original-c')),replacements=[];
 const history={replaceState:(_state,_title,path)=>{replacements.push(path);current=new URL(path,origin);}};
 assert.deepEqual(consumeInitialNativeEntry(current,history),{path:'/native/env/original-c',error:false});
 assert.equal(current.href,origin+'/');assert.equal(consumeInitialNativeEntry(current,history),null);assert.deepEqual(replacements,['/']);
 current=new URL(origin+'/?nativePath=%2Fnative%2F&nativePath=bad');assert.deepEqual(consumeInitialNativeEntry(current,history),{path:null,error:true});assert.equal(current.href,origin+'/');
 current=new URL(origin+'/?nativePath=%2Fnative%2F&unexpected=value');assert.deepEqual(consumeInitialNativeEntry(current,history),{path:null,error:true});assert.equal(current.search,'?unexpected=value');
});
test('ordinary management entry retains its URL and original token handling',()=>{
 const current=new URL(origin+'/#token=controlled-only');let calls=0;
 assert.equal(consumeInitialNativeEntry(current,{replaceState(){calls++;}}),null);assert.equal(calls,0);assert.equal(current.hash,'#token=controlled-only');
});
