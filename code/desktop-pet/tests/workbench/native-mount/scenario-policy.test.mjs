import { test } from 'node:test';
import { restrictPrivatePathSync } from '../../../dist/core/platform-files.js';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScenarioPolicy } from '../../../workbench/native-mount/scenario-policy.mjs';
import { createNativeExecutionGate } from '../../../workbench/native-mount/execution-gate.mjs';
const model={instanceId:'codex',model:'gpt-6.1-sol',options:{reasoningEffort:'medium'}};
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'aaa-scenario-')),file=join(dir,'policy.json'),journal=join(dir,'journal.json');
  const policy={version:1,kind:'web-scenario-turn-budget',environmentId:'env',sourceRevision:'candidate-source',projectId:'project',authorizationId:'scenario',
    startsAt:'2026-10-04T00:00:00Z',expiresAt:'2026-10-04T01:00:00Z',maxTurnStarts:9,maxResponseCommands:2,
    threads:[['C',4],['A',1],['B',2],['D',2]].map(([threadId,maxTurnStarts])=>({threadId,providerInstanceId:'codex',maxTurnStarts,runtimeModes:['auto-accept-edits'],modelSelections:[model]}))};
  const write=p=>{writeFileSync(file,JSON.stringify(p),{mode:0o600});restrictPrivatePathSync(file);};write(policy);
  const create=()=>createNativeExecutionGate({environmentId:'env',file:journal,
    providers:[{providerInstanceId:'codex',send:true,continue:true,modelSelection:true,interrupt:true,approval:true,userInput:true,runtimeModes:['auto-accept-edits','full-access'],attachments:{file:true,image:true,maxBytes:500}}],
    prepareCommand:async()=>({environmentId:'env',projectId:'project',providerInstanceId:'codex',readonly:false,source:'t3',newThread:false,modelSelection:model}),
    admissionPolicy:createScenarioPolicy({file,environmentId:'env',sourceRevision:'candidate-source',now:()=>Date.parse('2026-10-04T00:30:00Z')})});
  let seq=0;
  const request=(threadId,type='thread.turn.start',extra={})=>({_tag:'Request',id:'rpc-'+ ++seq,payload:{type,threadId,commandId:'command-'+seq,runtimeMode:'auto-accept-edits',modelSelection:model,
    message:{messageId:'message-'+seq,role:'user',text:'controlled',attachments:[]},requestId:'original-request-'+seq,...extra}});
  const accept=async(gate,r)=>{const got=await gate.reserve(r);if(got.kind==='forward')gate.receive(r.payload.commandId,{_tag:'Success',value:{sequence:seq}});return got;};
  return {file,journal,policy,write,create,request,accept,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test('nine original web/board starts and two original responses have separate durable limits',async()=>{
  const f=fixture();try {const gate=f.create();for(const [thread,n] of [['C',4],['A',1],['B',2],['D',2]])for(let i=0;i<n;i++)assert.equal((await f.accept(gate,f.request(thread))).kind,'forward');
    assert.equal((await f.accept(gate,f.request('C'))).kind,'deny');
    for(const type of ['thread.approval.respond','thread.user-input.respond'])assert.equal((await f.accept(gate,f.request('C',type))).kind,'forward');
    assert.equal((await f.accept(gate,f.request('C','thread.user-input.respond'))).kind,'deny');
    const rows=Object.values(JSON.parse(readFileSync(f.journal,'utf8')).commands);assert.equal(rows.filter(r=>r.commandType==='thread.turn.start').length,9);assert.equal(rows.length,11);
    assert.equal((await f.accept(f.create(),f.request('B'))).kind,'deny');
  }finally{f.cleanup();}
});
test('parallel original admission cannot exceed one executor slot',async()=>{
  const f=fixture();try {const gate=f.create();const results=await Promise.all([gate.reserve(f.request('A')),gate.reserve(f.request('A'))]);assert.equal(results.filter(x=>x.kind==='forward').length,1);}finally{f.cleanup();}
});
test('unknown original command blocks another actor until its exact original receipt is reconciled',async()=>{
  const f=fixture();try {let gate=f.create();const r=f.request('C');assert.equal((await gate.reserve(r)).kind,'forward');gate=f.create();
    assert.equal((await gate.reserve(f.request('B'))).kind,'deny');gate.reconcile(r.payload.commandId,{commandId:r.payload.commandId,aggregateKind:'thread',aggregateId:'wrong',status:'accepted',resultSequence:1});assert.equal((await gate.reserve(f.request('B'))).kind,'deny');
    gate.reconcile(r.payload.commandId,{commandId:r.payload.commandId,aggregateKind:'thread',aggregateId:'C',status:'accepted',resultSequence:1});assert.equal((await f.accept(gate,f.request('B'))).kind,'forward');
    assert.equal((await gate.reserve(r)).kind,'deny');
  }finally{f.cleanup();}
});
test('deletion, changed budget and changed project do not reset journaled scope after restart',async()=>{
  const f=fixture();try {assert.equal((await f.accept(f.create(),f.request('C'))).kind,'forward');rmSync(f.file);assert.equal((await f.accept(f.create(),f.request('C'))).kind,'deny');
    f.write({...f.policy,maxResponseCommands:3});assert.equal((await f.accept(f.create(),f.request('C'))).kind,'deny');
    f.write({...f.policy,projectId:'new-project'});assert.equal((await f.accept(f.create(),f.request('C'))).kind,'deny');
  }finally{f.cleanup();}
});
test('wrong source, expired window, full-access and unlisted model are denied before forwarding',async()=>{
  const f=fixture();try {
    for(const change of [{sourceRevision:'other'},{expiresAt:'2026-10-04T00:01:00Z'}]){f.write({...f.policy,...change});assert.equal((await f.accept(f.create(),f.request('C'))).kind,'deny');}
    f.write(f.policy);const gate=f.create();for(const change of [{runtimeMode:'full-access'},{modelSelection:{...model,options:{reasoningEffort:'high'}}},{threadId:'unknown'}])assert.equal((await f.accept(gate,f.request('C','thread.turn.start',change))).kind,'deny');
    assert.equal((await f.accept(gate,f.request('C','thread.turn.start',{modelSelection:{...model,options:[{id:'reasoningEffort',value:'medium'}]}}))).kind,'forward');
  }finally{f.cleanup();}
});
test('an absent scene policy preserves ordinary original gate behavior without creating a grant',async()=>{
  const f=fixture();try{rmSync(f.file);const gate=f.create();assert.equal((await f.accept(gate,f.request('C'))).kind,'forward');assert.equal(JSON.parse(readFileSync(f.journal,'utf8')).commands['command-1'].scenarioAuthorizationId,undefined);}finally{f.cleanup();}
});
test('permission metadata can change from desktop initial model while the next web input still requires its exact selected model',()=>{
  const f=fixture();try {
    const policy=createScenarioPolicy({file:f.file,environmentId:'env',sourceRevision:'candidate-source',now:()=>Date.parse('2026-10-04T00:30:00Z')});
    const target={projectId:'project',providerInstanceId:'codex',modelSelection:{instanceId:'codex',model:'gpt-6-astra',options:{reasoningEffort:'low'}}};
    const mode={type:'thread.runtime-mode.set',threadId:'C',runtimeMode:'auto-accept-edits'};
    assert.equal(policy(mode,target,{}).scenarioAuthorizationId,'scenario');
    assert.throws(()=>policy({...mode,type:'thread.turn.start'},target,{}),/模型/);
    assert.throws(()=>policy({...mode,type:'thread.meta.update',modelSelection:target.modelSelection},target,{}),/模型/);
    assert.equal(policy({...mode,type:'thread.turn.start',modelSelection:model},target,{}).scenarioAuthorizationId,'scenario');
  }finally{f.cleanup();}
});
