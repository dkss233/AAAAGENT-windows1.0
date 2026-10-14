import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.document={addEventListener(){},removeEventListener(){}};
globalThis.window={addEventListener(){},removeEventListener(){}};
const {managementFrameOrigin,originalManagementRelation,originalFrameMessage,consumeOriginalNativeEntry}=await import('../../../../management/ui/native-workbench-view.mjs');
const {nativeOpenReceiptValid}=await import('../../../../management/ui/workbench-view.mjs');
const origin='http://127.0.0.1:55101',gateway='http://127.0.0.1:55102';
const relation={version:'0.1.1',origin,path:'/',environmentId:'original-env',navigationId:'12345678-abcd-abcd-abcd-123456789abc'};
const node=(content,version='0.1.0')=>({getAttribute:key=>({content,'data-version':version})[key]??null});
const doc=entries=>({querySelectorAll:selector=>{assert.equal(selector,'meta[name="aaa-management-frame-origin"]');return entries;}});
test('only the unique exact server frame origin can enable a cross-origin frame',()=>{
 assert.equal(managementFrameOrigin(doc([node(gateway)]),origin),gateway);
 for(const entries of [[],[node(gateway),node(gateway)],[node(gateway,'future')],...['http://localhost:55102',origin,gateway+'/',gateway+'/open','https://127.0.0.1:55102','http://127.0.0.1:0','http://127.0.0.1:65536',gateway+'#x',gateway+'?x','http://user@127.0.0.1:55102'].map(v=>[node(v)])])assert.equal(managementFrameOrigin(doc(entries),origin),null);
});
test('the exact ticket relation retains the original environment and nonce without extra fields',()=>{
 assert.deepEqual(originalManagementRelation(relation,origin),relation);
 for(const change of [{version:'0.1.0'},{origin:gateway},{path:'/models'},{environmentId:''},{environmentId:'a\u0000b'},{environmentId:'x'.repeat(251)},{navigationId:'not-a-nonce'},{token:'unexpected'}])assert.equal(originalManagementRelation({...relation,...change},origin),null);
 assert.equal(originalManagementRelation(null,origin),null);
});
const child=type=>({source:'aaa-original-management-frame',version:'0.1.0',navigationId:relation.navigationId,environmentId:relation.environmentId,type});
test('child messages are bounded display lifecycle messages bound to the exact relationship',()=>{
 for(const type of ['ready','return','error'])assert.equal(originalFrameMessage(child(type),relation),true);
 for(const phase of ['expired','offline','error'])assert.equal(originalFrameMessage({...child('error'),phase},relation),true);
 for(const change of [{type:'submit'},{type:'appearance.state'},{version:'future'},{source:'aaa-workspace-ui'},{environmentId:'other-env'},{navigationId:'another-nonce'},{body:'unexpected'},{phase:'offline'}])assert.equal(originalFrameMessage({...child('return'),...change},relation),false);
 assert.equal(originalFrameMessage({...child('error'),phase:'ready'},relation),false);
 assert.equal(originalFrameMessage(null,relation),false);
});
test('parent appearance messages have no generic navigation, configuration or body channel',()=>{
 const value={...child('appearance.state'),source:'aaa-original-management-parent',mode:'dark'};
 for(const mode of ['light','dark','system'])assert.equal(originalFrameMessage({...value,mode},relation,true),true);
 for(const change of [{mode:'unknown'},{type:'return'},{page:'overview'},{body:'unexpected'},{environmentId:'other-env'},{navigationId:'different'},{source:'aaa-original-management-frame'}])assert.equal(originalFrameMessage({...value,...change},relation,true),false);
});
test('shared original receipt validator retains target identity, short-lived loopback ticket and route checks',()=>{
 const value={version:'0.1.0',status:'ready',target:{kind:'home',environmentId:'original-env'},expiresAt:new Date(Date.now()+50000).toISOString(),url:gateway+'/open#'+'A'.repeat(43)};
 assert.equal(nativeOpenReceiptValid(value,'home',undefined,null),true);
 for(const change of [{version:'future'},{status:'error'},{target:{kind:'task',environmentId:'original-env'}},{target:{kind:'home',environmentId:''}},{expiresAt:new Date(0).toISOString()},{expiresAt:new Date(Date.now()+120000).toISOString()},...['/open','/open?body=x','/open#bad','/native/#'+'A'.repeat(43)].map(p=>({url:gateway+p}))])assert.equal(nativeOpenReceiptValid({...value,...change},'home',undefined,null),false);
});

test('desktop receipt is bound to the complete management origin, exact frame and original target without another issue',()=>{
 const receipt={version:'0.1.0',status:'ready',target:{kind:'task',environmentId:'original-env',projectId:'project',taskId:'task',threadId:'original-thread',t3ProjectId:'native-project',workspaceRoot:'/original-workspace',providerInstanceId:'codex'},expiresAt:new Date(Date.now()+50000).toISOString(),url:gateway+'/open#'+'A'.repeat(43),originalManagementReturn:relation};
 const current=value=>({origin,hash:'#'+new URLSearchParams({token:'controlled-token',nativeEntry:JSON.stringify(value)})});
 assert.deepEqual(consumeOriginalNativeEntry(current(receipt),gateway),{receipt,error:false});
 assert.equal(consumeOriginalNativeEntry({origin,hash:'#token=controlled-token'},gateway),null);
 for(const bad of [{...receipt,url:'http://127.0.0.1:55103/open#'+'A'.repeat(43)},{...receipt,expiresAt:new Date(0).toISOString()},{...receipt,originalManagementReturn:{...relation,origin:gateway}},{...receipt,target:{...receipt.target,environmentId:'another'}},{...receipt,target:{...receipt.target,taskId:''}}])assert.deepEqual(consumeOriginalNativeEntry(current(bad),gateway),{receipt:null,error:true});
 assert.deepEqual(consumeOriginalNativeEntry({origin,hash:current(receipt).hash+'&nativeEntry=duplicate'},gateway),{receipt:null,error:true});
 assert.deepEqual(consumeOriginalNativeEntry(current(receipt),null),{receipt:null,error:true});
});
