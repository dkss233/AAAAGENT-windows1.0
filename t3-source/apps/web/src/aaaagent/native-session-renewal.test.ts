import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renewNativeMountSession,nativeSessionRenewDelay} from './native-session-renewal.ts';

test('renewal reuses only the local tab authority and never sends a task',async()=>{
 const token='a'.repeat(64),requests: Array<{path:string,options:RequestInit}>=[];
 Object.assign(globalThis,{location:{protocol:'http:',hostname:'127.0.0.1'},sessionStorage:{getItem:()=>token},fetch:async(path:string,options:RequestInit)=>{
  requests.push({path,options});return Response.json({apiVersion:1,environmentId:'same-env',mode:'native-operate',mountPath:'/native/',expiresAt:new Date(Date.now()+30*60_000).toISOString()});
 }});
 assert.equal(await renewNativeMountSession('same-env',new AbortController().signal),true);
 assert.deepEqual(requests.map(x=>[x.path,x.options.method,x.options.credentials,x.options.body]),[['/api/native-mount/session','POST','same-origin','{}']]);
 assert.equal(await renewNativeMountSession('wrong-env',new AbortController().signal),false);
 Object.assign(globalThis,{location:{protocol:'https:',hostname:'external.test'}});assert.equal(await renewNativeMountSession('same-env',new AbortController().signal),false);assert.equal(requests.length,2);
});
test('renew before expiry with one long timer rather than frequent history polls',()=>{
 assert.equal(nativeSessionRenewDelay(1_800_000,0),1_740_000);
 assert.equal(nativeSessionRenewDelay(1000,0),800);
 assert.equal(nativeSessionRenewDelay(-1,0),1);
});
