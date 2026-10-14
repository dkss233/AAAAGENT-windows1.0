import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const option=n=>{const at=process.argv.indexOf(n);assert.ok(at>=0&&process.argv[at+1]);return resolve(process.argv[at+1]);};
const evidence=option('--evidence'),esbuild=option('--esbuild');
assert.ok(evidence.startsWith(join(root,'artifacts/W1/native-tool-output-54/')));await mkdir(evidence,{recursive:true});
const src=join(root,'code/desktop-pet/t3-native/apps/web/src/aaaagent');
const {build}=createRequire(join(esbuild,'package.json'))(esbuild);
const built=await build({stdin:{contents:`export * from ${JSON.stringify(join(src,'native-tool-output-view.logic.ts'))};export * from ${JSON.stringify(join(src,'native-tool-output.ts'))};`,resolveDir:src,loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const module=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const target={environmentId:'controlled-env',projectId:'controlled-project',workspaceRoot:'/controlled/original-workspace',providerInstanceId:'codex',threadId:'original-c',turnId:'original-turn',toolCallId:'original-exec'};
const ref={environmentId:target.environmentId,threadId:target.threadId},thread={environmentId:target.environmentId,id:target.threadId,projectId:target.projectId,modelSelection:{instanceId:'codex'}},project={environmentId:target.environmentId,id:target.projectId,workspaceRoot:target.workspaceRoot};
const entry={itemType:'command_execution',toolLifecycleStatus:'completed',turnId:target.turnId,toolCallId:target.toolCallId};
const tail='尾部校验：CONTROLLED_FULL_TAIL\n',prefix='受控原形状工具输出\n';
const output=prefix+'0123456789\n'.repeat(450)+'x'.repeat(5200-Buffer.byteLength(prefix+tail+'0123456789\n'.repeat(450)))+tail;
const value=t=>({apiVersion:'0.1.0',source:'t3-original-terminal-activity',complete:true,
 scope:Object.fromEntries(['environmentId','projectId','workspaceRoot','providerInstanceId','threadId'].map(k=>[k,t[k]])),nativeThreadId:'controlled-native-c',turnId:t.turnId,toolCallId:t.toolCallId,activityId:'controlled-terminal-activity',itemType:'command_execution',command:'controlled command, never executed',output,outputBytes:Buffer.byteLength(output),outputSha256:createHash('sha256').update(output).digest('hex'),exitCode:0});
const cases=[],network=[],originalFetch=globalThis.fetch;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
try{
 assert.deepEqual(module.nativeToolOutputTarget(ref,thread,project,entry,target.workspaceRoot),target);
 for(const args of [[null,thread,project,entry,target.workspaceRoot],[ref,{...thread,id:'other'},project,entry,target.workspaceRoot],[ref,{...thread,environmentId:'other'},project,entry,target.workspaceRoot],[ref,thread,{...project,id:'other'},entry,target.workspaceRoot],[ref,thread,project,{...entry,turnId:null},target.workspaceRoot],[ref,thread,project,{...entry,toolCallId:undefined},target.workspaceRoot],[ref,{...thread,modelSelection:{instanceId:'dsh'}},project,entry,target.workspaceRoot],[ref,thread,project,entry,'/different-workspace']])assert.equal(module.nativeToolOutputTarget(...args),null);
 for(const change of [{itemType:'mcp_tool_call'},{toolLifecycleStatus:'inProgress'},{toolLifecycleStatus:'failed'},{toolLifecycleStatus:undefined}])assert.equal(module.terminalNativeCommand({...entry,...change}),false);
 cases.push({name:'accurate metadata, terminal eligibility and missing/mismatched identity refusal',passed:true});
 for(const key of Object.keys(target))assert.notEqual(module.nativeToolOutputKey(target),module.nativeToolOutputKey({...target,[key]:'other'}));
 cases.push({name:'all seven fields participate in original full identity key',passed:true});
 globalThis.fetch=async(path,options)=>{network.push({path,credentials:options.credentials,cache:options.cache});return new Response(JSON.stringify(value(target)),{status:200});};
 const actual=await module.readNativeToolOutput(target);assert.equal(actual.output,output);assert.equal(actual.outputBytes,5200);assert.ok(actual.output.endsWith(tail));
 const url=new URL(network[0].path,'https://controlled.invalid');assert.equal(url.pathname,'/api/orchestration/threads/original-c/tool-output');assert.deepEqual([...url.searchParams.keys()].sort(),Object.keys(target).filter(k=>k!=='threadId').sort());assert.equal(network[0].credentials,'same-origin');assert.equal(network[0].cache,'no-store');
 cases.push({name:'original public client preserves 5200 UTF-8 bytes and tail with cookie readonly GET',passed:true,outputSha256:actual.outputSha256});
 const forged=[];
 for(const key of Object.keys(value(target).scope))forged.push({...value(target),scope:{...value(target).scope,[key]:'other'}});
 for(const patch of [{turnId:'other'},{toolCallId:'other'},{complete:false},{outputBytes:output.length},{outputSha256:'0'.repeat(64)},{itemType:'mcp_tool_call'}])forged.push({...value(target),...patch});
 for(const payload of forged){globalThis.fetch=async()=>new Response(JSON.stringify(payload),{status:200});await assert.rejects(()=>module.readNativeToolOutput(target));}
 cases.push({name:'original public client rejects scope, item, turn, bytes and digest mismatches',passed:true,refused:forged.length});
 for(const status of [401,403,404,413,503]){globalThis.fetch=async()=>new Response('{}',{status});await assert.rejects(()=>module.readNativeToolOutput(target));}
 cases.push({name:'auth, boundary, absent, oversized and unavailable replies never become full text',passed:true});
 for(const field of Object.keys(target)){
  const states=[],requests=[];const reader=new module.NativeToolOutputReadState(state=>states.push(state),(t,options)=>new Promise((resolve,reject)=>requests.push({t,options,resolve,reject})));
  reader.open(target);const next={...target,[field]:'second-identity'};reader.open(next);assert.equal(requests[0].options.signal.aborted,true);
  requests[0].resolve(value(target));await tick();assert.equal(states.some(s=>s.phase==='ready'),false);
  requests[1].resolve(value(next));await tick();assert.equal(states.at(-1).key,module.nativeToolOutputKey(next));assert.equal(states.at(-1).phase,'ready');reader.cancel();
 }
 cases.push({name:'late reply ignoring abort cannot overwrite any of seven changed identity fields',passed:true});
 {
  const states=[],requests=[];const reader=new module.NativeToolOutputReadState(state=>states.push(state),(t,options)=>new Promise((resolve,reject)=>requests.push({options,resolve,reject})));
  reader.open(target);reader.cancel();requests[0].reject(Error('controlled late failure'));await tick();assert.equal(states.length,1);assert.equal(requests[0].options.signal.aborted,true);
  reader.open(target);requests[1].reject(Error('controlled unavailable'));await tick();assert.deepEqual(states.at(-1),{key:module.nativeToolOutputKey(target),phase:'unavailable'});
  reader.open(target);requests[2].resolve(value(target));await tick();assert.equal(states.at(-1).phase,'ready');reader.cancel();
 }
 cases.push({name:'close ignores late errors; failure and explicit reopen stay on the original key',passed:true});
 const empty={...value(target),output:'',outputBytes:0,outputSha256:createHash('sha256').update('').digest('hex'),exitCode:1};
 globalThis.fetch=async()=>new Response(JSON.stringify(empty),{status:200});assert.equal((await module.readNativeToolOutput(target)).output,'');
 cases.push({name:'empty original terminal output and nonzero exit remain complete facts',passed:true});
}finally{globalThis.fetch=originalFetch;}
await writeFile(join(evidence,'results.json'),JSON.stringify({cases,controlledClientCalls:network,boundary:'offline original public client and owned state logic; synthetic original-shaped terminal output; no live HTTP/model/tool execution'},null,2)+'\n');
console.log(JSON.stringify({groups:cases.length,liveNetwork:0,models:0,toolExecutions:0}));
