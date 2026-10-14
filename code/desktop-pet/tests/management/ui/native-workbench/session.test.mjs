import {test} from 'node:test';
import assert from 'node:assert/strict';
globalThis.document={addEventListener(){},removeEventListener(){}};
globalThis.window={addEventListener(){},removeEventListener(){}};
const {validNativeSession,createNativeMountSession}=await import('../../../../management/ui/native-workbench-view.mjs');
const {ManagementClient}=await import('../../../../management/ui/api.mjs');
const valid=()=>({apiVersion:1,mode:'native-read',mountPath:'/native/',readonly:true,environmentId:'real-environment',expiresAt:new Date(Date.now()+10000).toISOString()});
const host={connection:'online',authEpoch:0,instanceId:'instance-a'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('only exact read or operate same-origin mount replies with paired mode flags are accepted',()=>{
 assert.equal(validNativeSession(valid()),true);
 assert.equal(validNativeSession({...valid(),mode:'native-operate',readonly:false}),true);
 assert.equal(validNativeSession({...valid(),mode:'native-operate',readonly:true}),false);
 assert.equal(validNativeSession({...valid(),mode:'unknown',readonly:false}),false);
 for(const change of [{mountPath:'http://127.0.0.1:56050/'},{mountPath:'//elsewhere/native/'},{readonly:false},{environmentId:''},{expiresAt:'bad'},{expiresAt:new Date(0).toISOString()},{token:'unexpected-secret'}]) assert.equal(validNativeSession({...valid(),...change}),false);
});
test('original ManagementClient sends a single cookie-enabled mount request and no task operation',async()=>{
 const gate=deferred(),requests=[];
 const client=new ManagementClient('test-only-token',async(path,options)=>{requests.push({path,options});await gate.promise;return new Response(JSON.stringify(valid()),{status:200});});
 const mount=createNativeMountSession(client,()=>host);
 const first=mount.connect();await mount.connect();assert.equal(requests.length,1);
 assert.equal(requests[0].path,'/api/native-mount/session');assert.equal(requests[0].options.credentials,'same-origin');assert.equal(requests[0].options.method,'POST');assert.equal(requests[0].options.body,'{}');
 gate.resolve();await first;assert.equal(mount.state().phase,'ready');mount.dispose();
});
test('late mount reply after auth epoch or host change cannot revive the previous iframe session',async()=>{
 const gate=deferred();let current={...host};
 const mount=createNativeMountSession({request:()=>gate.promise},()=>current);
 const pending=mount.connect();current={...current,authEpoch:1,instanceId:'instance-b'};mount.sync();gate.resolve(valid());await pending;
 assert.equal(mount.state().phase,'idle');assert.equal(mount.state().session,null);mount.dispose();
});
test('auth loss, upstream outage and malformed replies stay distinct without raw errors or retries',async()=>{
 for(const [reply,phase] of [[{status:401},'expired'],[{status:503},'offline'],[{status:500},'error']]){
  let calls=0;const mount=createNativeMountSession({request:async()=>{calls++;throw {...reply,message:'private upstream raw detail'};}},()=>host);
  await mount.connect();assert.equal(mount.state().phase,phase);assert.equal(mount.state().session,null);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(mount.state()),/private upstream/);mount.dispose();
 }
 const malformed=createNativeMountSession({request:async()=>({mode:'native-read'})},()=>host);await malformed.connect();assert.equal(malformed.state().phase,'error');malformed.dispose();
});
test('expiry blocks stale visibility and a disposed task ignores in-flight completion',async()=>{
 const expired=deferred();const mount=createNativeMountSession({request:async()=>({...valid(),expiresAt:new Date(Date.now()+35).toISOString()})},()=>host,()=>{if(mount.state().phase==='expired')expired.resolve();});
 await mount.connect();assert.equal(mount.state().phase,'ready');await expired.promise;assert.equal(mount.state().phase,'expired');mount.dispose();
 const gate=deferred();const disposed=createNativeMountSession({request:()=>gate.promise},()=>host);const pending=disposed.connect();disposed.dispose();gate.resolve(valid());await pending;assert.notEqual(disposed.state().phase,'ready');
});
test('long lease renews through the original authority without leaving ready or starting work',async()=>{
 const timers=new Map(),originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
 let clock=0,calls=0,next=0;const phases=[];
 globalThis.setTimeout=(fn,delay)=>{const id=++next;timers.set(id,{fn,delay});return id;};globalThis.clearTimeout=id=>timers.delete(id);
 let mount;
 try{
  mount=createNativeMountSession({request:async(path,options)=>{assert.equal(path,'/api/native-mount/session');assert.equal(options.body&&Object.keys(options.body).length,0);calls++;return {...valid(),expiresAt:new Date(clock+1_800_000).toISOString()};}},()=>host,()=>phases.push(mount.state().phase),()=>clock);
  await mount.connect();assert.equal(calls,1);const deadline=[...timers.values()][0];assert.equal(deadline.delay,1_740_000);
  clock=1_740_000;timers.clear();deadline.fn();await new Promise(done=>setImmediate(done));assert.equal(calls,2);assert.equal(mount.state().phase,'ready');assert.deepEqual(phases,['idle','connecting','ready','ready']);
  mount.dispose();assert.equal(timers.size,0);
 }finally{mount?.dispose();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});
