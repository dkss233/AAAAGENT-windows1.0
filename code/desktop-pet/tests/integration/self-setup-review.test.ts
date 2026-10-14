import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFirstRunSetup, firstRunDraft } from '../../app/self-setup.js';
import type { TrialConfiguration } from '../../app/trial-config.js';
import { ManagedCredentialStore } from '../../management/credential-store.js';
import { credentialRegistry } from '../../management/credentials.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { createSelfSetup } from '../../management/self-setup.js';
import { RegisteredVoiceStore } from '../../providers/registered-voices.js';
import { pcm16Wav } from '../../media/wav.js';

const testKey='sk-synthetic-supervisor-no-real-account';
const uiRoot=fileURLToPath(new URL('../../../management/ui',import.meta.url));
async function fixture(t:test.TestContext){
 const outer=await realpath(await mkdtemp(resolve(tmpdir(),'s-review50-'))),root=resolve(outer,'project');await mkdir(root);
 const calls:string[]=[];let responseMode:'unknown'|'denied'|'ok'='unknown';
 const cloud=(async(url:unknown,init:RequestInit={})=>{
  const address=String(url);calls.push(address);
  if(address.includes('/uploads?'))return Response.json({data:{upload_host:'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com/',upload_dir:'dashscope-instant/review',x_oss_object_acl:'private',x_oss_forbid_overwrite:'true',expire_in_seconds:3600,policy:'synthetic',signature:'synthetic',oss_access_key_id:'synthetic'}});
  if(address.includes('dashscope-file-mgr'))return new Response('');
  assert.ok(address.startsWith('https://dashscope.aliyuncs.com/'),'unexpected provider endpoint');
  const body=JSON.parse(String(init.body));assert.equal(body.input.action,'voice_clone');
  if(responseMode==='unknown')throw Error('synthetic transport loss after upstream submission');
  if(responseMode==='denied')return new Response('',{status:403});
  return Response.json({output:{base_resp:{status_code:0},input_sensitive:false,input_sensitive_type:0},usage:{characters:2}});
 }) as typeof fetch;
 const options={credentialDirectory:resolve(outer,'keys'),fetch:cloud,uiRoot};let service=await startFirstRunSetup(root,options);
 t.after(async()=>{await service.close();await rm(outer,{recursive:true,force:true});});
 async function request(path='',body?:unknown,method=body?'POST':'GET'){
  const res=await fetch(service.origin+'/api/self-setup'+path,{method,headers:{Authorization:'Bearer '+service.token,...(body?{Origin:service.origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return{status:res.status,data:await res.json() as any};
 }
 return{root,outer,calls,request,get service(){return service;},mode:(mode:typeof responseMode)=>responseMode=mode,async restart(){await service.close();service=await startFirstRunSetup(root,options);}};
}
async function prepared(f:Awaited<ReturnType<typeof fixture>>){
 const s=(await f.request()).data,instanceId=s.instanceId;
 const key=(await f.request('/credentials',{instanceId,provider:'dashscope',key:testKey,expectedRevision:0,operationId:'s-review-key'})).data;
 const reference=(await f.request('/reference',{instanceId,operationId:'s-review-upload',filename:'review.wav',audioBase64:Buffer.from(pcm16Wav(new Float32Array(240000),24000)).toString('base64')})).data;
 const op=(await f.request('/voice/prepare',{instanceId,referenceId:reference.id,label:'合成检查',targetModel:'MiniMax/speech-2.8-turbo',credentialRef:key.credentialRef,configRevision:0,text:'你好'})).data;
 assert.equal(op.phase,'prepared');assert.equal(f.calls.length,0);return {op,instanceId};
}
test('independent HTTP unknown survives restart, retains reservation, and neither repeat nor retry replays cloud',async t=>{
 const f=await fixture(t),{op,instanceId}=await prepared(f);
 const result=await f.request('/voice/confirm',{instanceId,operationId:op.operationId,expectedRevision:op.revision,costConsent:true});
 assert.equal(result.status,200);assert.equal(result.data.phase,'unknown');assert.equal(result.data.retryAvailable,false);
 const count=f.calls.length;assert.equal(count,3);
 const ledgerPath=resolve(f.root,'artifacts/W0-I/model-evaluation/budget.json'),before=await readFile(ledgerPath,'utf8');
 assert.equal(JSON.parse(before).entries[0].status,'unknown');
 await f.restart();const snapshot=(await f.request()).data;assert.equal(snapshot.operations[0].phase,'unknown');
 const retry=await f.request('/voice/retry',{instanceId:snapshot.instanceId,operationId:op.operationId,expectedRevision:result.data.revision});assert.equal(retry.status,400);
 const confirm=await f.request('/voice/confirm',{instanceId:snapshot.instanceId,operationId:op.operationId,expectedRevision:result.data.revision,costConsent:true});assert.equal(confirm.status,400);
 assert.equal(f.calls.length,count);assert.equal(await readFile(ledgerPath,'utf8'),before);
 assert.doesNotMatch(JSON.stringify(snapshot),/sk-synthetic|credentialFile|synthetic transport|cloneReceipt/);
});
test('independent runtime credential save leaves effective models, old keys, voice selection and shared ledger intact',async t=>{
 const outer=await realpath(await mkdtemp(resolve(tmpdir(),'s-runtime50-'))),root=resolve(outer,'project');await mkdir(root);
 t.after(()=>rm(outer,{recursive:true,force:true}));const managed=new ManagedCredentialStore(root,resolve(outer,'keys'));
 managed.save({provider:'deepseek',key:testKey,expectedRevision:0,operationId:'s-runtime-first'});
 managed.save({provider:'dashscope',key:testKey+'2',expectedRevision:1,operationId:'s-runtime-second'});
 const draft=firstRunDraft(root,managed.directory);
 const base:TrialConfiguration={...draft,models:Object.fromEntries(Object.entries(draft.models).map(([slot,model])=>[slot,{...model,credentialFile:managed.entries().find(e=>e.provider===model.provider)!.file}])) as TrialConfiguration['models']};
 const registry=await RegisteredVoiceStore.open(resolve(root,'voices.json'));
 const settings=await ManagementSettingsStore.open(resolve(root,'settings.json'),base,registry,{credentials:credentialRegistry(base,managed)});
 const previous=JSON.stringify(settings.snapshot()),baseBefore=JSON.stringify(base),oldKey=await readFile(managed.entries()[0]!.file,'utf8');
 const ledger={batchId:base.budgetBatchId,currency:'CNY',budgetMode:'unlimited',limitMicros:null,blocked:false,entries:[{operationId:'existing-user-call',model:'deepseek',reservedMicros:100,actualMicros:80,status:'settled'}]};
 await mkdir(dirname(base.budgetFile),{recursive:true});await writeFile(base.budgetFile,JSON.stringify(ledger));const bytes=await readFile(base.budgetFile,'utf8');
 let cloudCalls=0;const setup=createSelfSetup({base,settings,instanceId:'synthetic-runtime',mode:'runtime',credentials:managed,fetch:async()=>{cloudCalls++;throw Error('forbidden');}});t.after(()=>setup.close());
 await setup.saveCredential({instanceId:'synthetic-runtime',provider:'deepseek',key:testKey+'new',expectedRevision:2,operationId:'s-runtime-third'});
 const s=await setup.snapshot();assert.equal(s.mode,'runtime');assert.equal(s.budget.limitMicros,null);assert.equal(cloudCalls,0);
 assert.equal(JSON.stringify(settings.snapshot()),previous);assert.equal(JSON.stringify(base),baseBefore);assert.equal(await readFile(managed.entries()[0]!.file,'utf8'),oldKey);assert.equal(await readFile(base.budgetFile,'utf8'),bytes);
 // References already used by the runtime retain their existing-config classification.
 assert.equal(new Set(s.credentials.map(c=>c.id)).size,3);assert.equal(s.credentials.filter(c=>c.managed).length,1);assert.doesNotMatch(JSON.stringify(s),/sk-synthetic|credentialFile/);
});
test('independent real WebKit connects to actual setup HTTP and preserves permission-failure recovery contract',{skip:process.env.PLAYWRIGHT_MODULE?false:'Run separately with the existing Playwright module; not a bundled dependency.'},async t=>{
 assert.ok(process.env.PLAYWRIGHT_MODULE,'set existing Playwright module');
 const {webkit}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE!).href),f=await fixture(t);f.mode('denied');
 const browser=await webkit.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1100,height:950}});page.setDefaultTimeout(7000);const errors:string[]=[];
 page.on('pageerror',(e:Error)=>errors.push(e.message));
 await page.route('**/*',(route:any)=>new URL(route.request().url()).origin===f.service.origin?route.continue():route.abort());
 await page.goto(f.service.url);const ready=()=>page.locator('#setup-refresh:not([disabled])').waitFor();await ready();
 assert.match(await page.locator('#self-setup').innerText(),/保存 API Key 不代表模型已经开通/);
 const choose=async(selector:string,value:string)=>{await page.locator(selector).click();await page.locator('[role="option"][data-value='+JSON.stringify(value)+']').click();};
 await choose('#setup-provider','dashscope');await page.locator('#setup-key').fill(testKey);await page.locator('#setup-key-save').click();await ready();
 assert.equal(await page.locator('#setup-key').inputValue(),'');assert.equal(f.calls.length,0);
 const saved=(await f.request()).data,credential=saved.credentials.find((c:any)=>c.managed).id;
 await page.locator('#setup-audio').setInputFiles({name:'generated.wav',mimeType:'audio/wav',buffer:Buffer.from(pcm16Wav(new Float32Array(240000),24000))});await page.locator('#setup-upload').click();await ready();
 await page.locator('#setup-voice-label').fill('独立合成检查');await page.locator('#setup-voice-text').fill('你好');await choose('#setup-voice-credential',credential);await page.locator('#setup-voice-prepare').click();await ready();
 const op=(await f.request()).data.operations[0];assert.equal(op.phase,'prepared');assert.equal(f.calls.length,0);
 await page.locator('#setup-consent-'+op.operationId).check();await page.locator('[data-setup-confirm]').click();await ready();
 assert.match(await page.locator('[data-setup-operation]').innerText(),/开通/);assert.equal((await f.request()).data.operations[0].retryAvailable,true);
 const calls=f.calls.length;await page.locator('[data-setup-retry]').click();await ready();assert.equal(f.calls.length,calls);
 const after=(await f.request()).data;assert.equal(after.operations.length,2);assert.ok(after.operations.some((o:any)=>o.phase==='failed'));assert.ok(await page.locator('[data-setup-confirm]').isDisabled());
 assert.doesNotMatch(await page.locator('body').innerText(),/sk-synthetic|credentialFile/);assert.deepEqual(errors,[]);
 if(process.env.MANAGEMENT_UI_OUTPUT){await mkdir(process.env.MANAGEMENT_UI_OUTPUT,{recursive:true});await page.screenshot({path:resolve(process.env.MANAGEMENT_UI_OUTPUT,'real-http-setup.png'),fullPage:true});}
});
