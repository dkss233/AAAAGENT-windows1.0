import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {apply,richPresetFiles,RICH_SYSTEM} from './dsh-rich-memory-trial.mjs';
const input='这是完全虚构的松果A项目：验收尚未完成。';
const config={sessionId:'new-session',requestId:'new-command',input,inputSha256:createHash('sha256').update(input).digest('hex')};
function fixture(){const hooks=new Map();let allowed;let toolSchemas=[];const ctx={tools:{restrict(v){allowed=v;},guard(fn){assert.equal(typeof fn(),'string');},schemas(){return toolSchemas;}},on(name,fn,options){assert.equal(options.prepend,true);hooks.set(name,fn);}};apply(ctx,config);return{hooks,allowed,setTools(v){toolSchemas=v;}};}
const selected=()=>Promise.resolve({provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'});
const agent=()=>({id:'new-session',session:{snapshotEvents:()=>[]}});
const decision=()=>({kind:'enter',messages:[{source:{kind:'user',rpcId:'new-command'},content:[{type:'text',text:input}]}]});
test('exact first native step only; no tools, capped output and no chained retry',async()=>{
 const f=fixture(),a=agent();assert.deepEqual(f.allowed,{allow:[]});assert.equal((await f.hooks.get('agent/pre-step')({agent:a,step:1},async()=>decision())).kind,'enter');assert.equal((await f.hooks.get('agent/request')({agent:a},selected)).maxTokens,1024);await assert.rejects(f.hooks.get('agent/request')({agent:a},selected),/no replay/);let chained=false;assert.equal(await f.hooks.get('agent/request-error')({},async()=>{chained=true;}),undefined);assert.equal(chained,false);
});
test('wrong session/step/request/text/history/model/tools fail before model dispatch',async()=>{
 for(const mutate of [d=>d.messages[0].source.rpcId='old',d=>d.messages[0].content[0].text+='!',d=>d.messages.push(d.messages[0])]){const f=fixture(),d=decision();mutate(d);assert.equal((await f.hooks.get('agent/pre-step')({agent:agent(),step:1},async()=>d)).kind,'reject');}
 for(const payload of [{agent:agent(),step:2},{agent:{...agent(),id:'other'},step:1}])assert.equal((await fixture().hooks.get('agent/pre-step')(payload,async()=>decision())).kind,'reject');
 const a=agent();a.session.snapshotEvents=()=>[{type:'request/header'}];await assert.rejects(fixture().hooks.get('agent/request')({agent:a},selected),/no replay/);const f=fixture();f.setTools([{}]);await assert.rejects(f.hooks.get('agent/request')({agent:agent()},selected),/scope/);await assert.rejects(fixture().hooks.get('agent/request')({agent:agent()},async()=>({...await selected(),model:'other'})),/route/);
});
test('preset returned as candidate with complete fixed persona; rejects unbound input',()=>{
 const files=richPresetFiles('file:///candidate/rich.mjs',config);assert.match(files['agent.cordis.yml'],/complete: true/);assert.ok(files['agent.cordis.yml'].includes(JSON.stringify(RICH_SYSTEM)));assert.match(files['agent.cordis.yml'],/includeRuntimeContext: false/);assert.throws(()=>richPresetFiles('https://example.invalid/rich.mjs',config));assert.throws(()=>richPresetFiles('file:///candidate/rich.mjs',{...config,input:'not reviewed'}));
});
