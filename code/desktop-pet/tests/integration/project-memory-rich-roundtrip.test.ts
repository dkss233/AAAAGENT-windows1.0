import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteProjectIndex} from '../../projects/sqlite-project-index.js';
import {SqliteWorkbenchStore} from '../../app/workbench-store.js';
import {WorkbenchService} from '../../app/workbench-service.js';
import {SqliteProjectMemory} from '../../projects/project-memory-sqlite.js';
import {createProjectTerminalExtractor} from '../../projects/project-terminal-extractor.js';
import {createProjectTerminalModelDeriver} from '../../projects/project-terminal-model-deriver.js';
import {defaultProjectTerminalConfiguration} from '../../management/project-terminal-configuration.js';
const tool=await import(new URL('../../../tools/project-memory-rich-roundtrip.mjs',import.meta.url).href);
const artifacts=fileURLToPath(new URL('../../../../../artifacts/W0-I/rich-memory-roundtrip-54/tests/',import.meta.url));
const at='2026-09-28T00:00:00.000Z';
async function fixture(t:any){
 await mkdir(artifacts,{recursive:true});const root=await mkdtemp(join(artifacts,'case-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const plan=tool.prepareRichPlan({projectRoot:root,runId:'pinecone-01',sourceRevision:'a'.repeat(40),createdAt:at});for(const p of plan.projects)await mkdir(p.workspaceRoot,{recursive:true});
 const receiptDirectory=join(root,'artifacts/W0-I/rich-memory-roundtrip-54/receipt');const projects=new SqliteProjectIndex(join(root,'index.sqlite'));t.after(()=>projects.close());
 const file=join(root,'workbench.sqlite');let store=new SqliteWorkbenchStore(file);t.after(()=>store.close());
 const nativeProjects:any[]=[],threads:any[]=[],sends:any[]=[],receipts=new Map();let turnSends=0,failThread=false;
 const native:any={async environmentDescriptor(){return{environmentId:'fixture-native-env'};},async shellSnapshot(){return{snapshotSequence:sends.length,updatedAt:at,projects:nativeProjects,threads};},async threadSnapshot(id:string){return{snapshotSequence:sends.length,thread:structuredClone(threads.find(x=>x.id===id))};},
  async providerModels(provider:string){return{providers:[{instanceId:provider,driver:provider,enabled:true,installed:true,status:'ready',authStatus:'authenticated',checkedAt:new Date().toISOString(),models:[{id:plan.providers[provider].model,name:'fixture',...(provider==='dsh'?{reasoningEfforts:[{id:'high',label:'High'}],defaultReasoningEffort:'high'}:{})}]}]};},
  async createCommand(command:any){sends.push(command);if(command.type==='project.create')nativeProjects.push({id:command.projectId,workspaceRoot:command.workspaceRoot});else threads.push({...command,id:command.threadId,latestTurn:null,messages:[],hasPendingApprovals:false,hasPendingUserInput:false});if(command.type!=='thread.create'||!failThread)receipts.set(command.commandId,{status:'accepted',aggregateKind:command.type==='project.create'?'project':'thread',aggregateId:command.type==='project.create'?command.projectId:command.threadId,resultSequence:sends.length});return{sequence:sends.length};},
  async readReceipt(id:string){return receipts.get(id)??null;},async dispatch(){turnSends++;throw Error('No model turn in candidate tests');}};
 let workbench=new WorkbenchService(projects,store,native,false);const approval={mode:'offline-test',planSha256:plan.planSha256,reference:'isolated-fixture-only',scope:'two-fictional-projects-two-native-tasks-no-turn'};
 const run=(extra:any={})=>tool.createRichResources({plan,approval,receiptDirectory,projects,workbench,...extra});
 return{root,plan,projects,receiptDirectory,approval,run,sends,threads,receipts,turnSends:()=>turnSends,setFailThread(v:boolean){failThread=v;},reopen(){store.close();store=new SqliteWorkbenchStore(file);workbench=new WorkbenchService(projects,store,native,false);}};
}
test('SQLite creation creates two fictional projects and one A native project/two tasks; cold repeat sends no turns or duplicate commands',async t=>{
 const f=await fixture(t),first=await f.run();assert.equal(first.status,'prepared_no_turn');assert.equal((await f.projects.list({})).total,2);assert.equal(f.sends.length,3);assert.equal(f.turnSends(),0);assert.equal(first.preview.requests.length,2);assert.equal(first.preview.extractionRequests.length,0);assert.notEqual(first.receipt.projects.A.id,first.receipt.projects.B.id);assert.equal(first.preview.requests[0].native.fullNativeInstructionsSha256,null);assert.match(first.preview.requests[0].native.nativeTransportRetries,/not a one-HTTP guarantee/);f.reopen();assert.deepEqual(await f.run(),first);assert.equal(f.sends.length,3);
});
test('unknown native creation stops before second task; same-command recovery never resends',async t=>{
 const f=await fixture(t);f.setFailThread(true);assert.equal((await f.run()).status,'unknown');assert.equal(f.sends.length,2);assert.equal((await f.run()).status,'unknown');assert.equal(f.sends.length,2);const cmd=f.sends[1];f.receipts.set(cmd.commandId,{status:'accepted',aggregateKind:'thread',aggregateId:cmd.threadId,resultSequence:2});f.setFailThread(false);f.reopen();assert.equal((await f.run()).status,'prepared_no_turn');assert.equal(f.sends.length,3);
});
test('lost project-save reply recovers reserved identity; unknown absence never saves again',async t=>{
 const f=await fixture(t);let saves=0;const real=f.projects.save.bind(f.projects);f.projects.save=async input=>{saves++;const saved=await real(input);if(saves===1)throw Error('lost reply');return saved;};assert.equal((await f.run()).status,'unknown');assert.equal(saves,1);assert.equal((await f.run()).status,'prepared_no_turn');assert.equal(saves,2);
 const g=await fixture(t);let unknownSaves=0;g.projects.save=async()=>{unknownSaves++;throw Error('unknown');};assert.equal((await g.run()).status,'unknown');assert.equal((await g.run()).status,'unknown');assert.equal(unknownSaves,1);
});
test('plan/approval drift, unclaimed project, nonempty task and interrupted lock fail without turns',async t=>{
 const f=await fixture(t);await assert.rejects(f.run({plan:{...f.plan,runId:'changed'}}));await assert.rejects(f.run({approval:{...f.approval,planSha256:'bad'}}));assert.equal(f.sends.length,0);await f.run();f.threads[0].messages.push({role:'user',text:'existing'});await assert.rejects(f.run());assert.equal(f.turnSends(),0);
 const g=await fixture(t);await g.projects.save({expectedVersion:0,name:g.plan.projects[0].name,abstract:g.plan.projects[0].abstract,detailRef:{rootPath:g.plan.projects[0].workspaceRoot}});await assert.rejects(g.run(),/Unclaimed/);assert.equal(g.sends.length,0);
 const h=await fixture(t);await mkdir(h.receiptDirectory);await writeFile(join(h.receiptDirectory,'create.lock'),'interrupted');await assert.rejects(h.run());assert.equal((await h.projects.list({})).total,0);
});
test('workspace symlink is rejected before project mutation',async t=>{
 const f=await fixture(t),path=f.plan.projects[1].workspaceRoot;await rm(path,{recursive:true});await symlink(f.plan.projects[0].workspaceRoot,path);await assert.rejects(f.run());assert.equal((await f.projects.list({})).total,0);
});
test('preview cannot invent completed evidence; offline receipt cannot feed real extraction',async t=>{
 const f=await fixture(t),result=await f.run();assert.throws(()=>tool.prepareNativeRequestPreview(f.plan,{...result.receipt,drafts:{}}));const changed=structuredClone(result.receipt);changed.drafts.codex.input.dispatchText='other';assert.throws(()=>tool.prepareNativeRequestPreview(f.plan,changed));await assert.rejects(tool.freezeRichTerminalRequests({plan:f.plan,receipt:result.receipt,jobs:[],configuration:{},materialPort:{readTerminalMaterial(){throw Error('never');}}}));const bad=tool.reviewRichQuality({items:[],projectId:result.receipt.projects.A.id,sourceTaskIds:[]});assert.equal(bad.status,'failed');assert.equal(bad.manualEditsCountAsModelSuccess,false);
});
test('DSH preset binds the returned environment, task command and exact fictional input without installing',async t=>{
 const f=await fixture(t),result=await f.run();
 const session=result.preview.dshPresetBinding.plannedSessionId;
 assert.equal(result.preview.dshPresetBinding.nativeSessionExists,'unverified');
 const files=tool.prepareBoundDshPreset(f.plan,result.preview,session,'file:///fixture/dsh-rich-memory-trial.mjs');
 assert.ok(files['agent.cordis.yml'].includes(session));
 assert.ok(files['agent.cordis.yml'].includes(result.receipt.drafts.dsh.commandId));
 assert.ok(files['agent.cordis.yml'].includes(JSON.stringify(f.plan.providers.dsh.input)));
 assert.throws(()=>tool.prepareBoundDshPreset(f.plan,result.preview,'old-native-session','file:///fixture/dsh-rich-memory-trial.mjs'));
 const changed=structuredClone(result.preview);changed.requests[1].commandId='other';
 assert.throws(()=>tool.prepareBoundDshPreset(f.plan,changed,session,'file:///fixture/dsh-rich-memory-trial.mjs'));
 assert.equal(f.turnSends(),0);
});
test('two isolated terminal jobs freeze exact source bodies without queue writes and reject project, task, reference, input or attempt drift',async t=>{
 const f=await fixture(t);
 // The mode exercises the reviewed branch through injected SQLite/fake-native ports only.
 const created=await f.run({approval:{...f.approval,mode:'approved-create-only',reference:'isolated-fixture-not-real-approval'}});
 const materials=['codex','dsh'].map(provider=>{
  const task=created.receipt.tasks[provider],draft=created.receipt.drafts[provider];
  return {version:'0.1.0' as const,source:'t3_thread_detail' as const,
   evidence:{projectId:task.projectId,taskId:task.id,nativeTurnId:'fixture-turn-'+provider,
    terminalEventId:'fixture-event-'+provider,terminalPhase:'completed' as const,
    resultRef:`t3:${task.environmentId}:${task.threadId}:message:fixture-answer-${provider}`,
    occurredAt:at,extractionVersion:'b54-t3-terminal-v1'},
   userMessages:[{id:draft.input.inputId,text:draft.input.dispatchText}],
   assistantMessage:{id:'fixture-answer-'+provider,text:'完全虚构：仅离线演示用蓝色圆点，Host验收和低电量测量尚未完成。'}};
 });
 const memory=new SqliteProjectMemory(join(f.root,'freeze-memory.sqlite'),{autoProcess:false});t.after(()=>memory.close());
 const jobs=[];
 for(const m of materials){const {jobId}=await memory.enqueueTerminal(m.evidence);jobs.push((await memory.getJob(m.evidence.projectId,jobId))!);}
 const original=structuredClone(jobs);
 const materialPort={async readTerminalMaterial(evidence:any){return structuredClone(materials.find(m=>m.evidence.taskId===evidence.taskId)!);}};
 const options={plan:f.plan,receipt:created.receipt,jobs,configuration:defaultProjectTerminalConfiguration('deepseek-000000000000'),materialPort};
 const review=await tool.freezeRichTerminalRequests(options);
 assert.equal(review.requests.length,2);assert.equal(review.modelRequests,0);assert.equal(review.workerStarted,false);assert.equal(review.queueMutations,0);
 for(const request of review.requests){const m=materials.find(m=>m.evidence.taskId===request.evidence.taskId)!;
  assert.deepEqual(JSON.parse(request.userText).userMessages,m.userMessages);assert.equal(request.attemptOrdinal,1);assert.equal(request.automaticRetries,0);
  assert.equal(request.body.max_tokens,1024);assert.ok(request.bodyJson.includes('低电量测量尚未完成'));
 }
 for(const mutate of [(j:any)=>j.evidence.projectId=created.receipt.projects.B.id,
   (j:any)=>j.evidence.taskId='old-task',(j:any)=>j.evidence.resultRef='t3:old-env:old-thread:message:old-answer',
   (j:any)=>j.attempts=1,(j:any)=>j.state='done',(j:any)=>j.evidence.terminalPhase='failed']){
  const drift=structuredClone(jobs);mutate(drift[0]);await assert.rejects(tool.freezeRichTerminalRequests({...options,jobs:drift}));
 }
 for(const mutate of [(m:any)=>m.userMessages[0].id=created.receipt.drafts.codex.input.origin.messageId,
   (m:any)=>m.userMessages[0].text+='drift',(m:any)=>m.evidence.nativeTurnId='old-turn']){
  await assert.rejects(tool.freezeRichTerminalRequests({...options,materialPort:{async readTerminalMaterial(e:any){const m=await materialPort.readTerminalMaterial(e);mutate(m);return m;}}}));
 }
 await assert.rejects(tool.freezeRichTerminalRequests({...options,configuration:{...options.configuration,enabled:true}}));
 for(const job of original)assert.deepEqual(await memory.getJob(job.projectId,job.id),job);
 assert.equal(f.turnSends(),0);
});
test('existing extractor/SQLite preserve candidate sources, explicit acceptance/edit/withdrawal and project isolation',async t=>{
 const f=await fixture(t),created=await f.run(),projectId=created.receipt.projects.A.id,otherId=created.receipt.projects.B.id,task=created.receipt.tasks.codex,draft=created.receipt.drafts.codex;
 const evidence={projectId,taskId:task.id,nativeTurnId:'fixture-completed-turn',terminalEventId:'fixture-terminal-event',terminalPhase:'completed' as const,resultRef:'t3:fixture:thread:message:fixture-answer',occurredAt:at,extractionVersion:'b54-t3-terminal-v1'};
 const material={version:'0.1.0' as const,source:'t3_thread_detail' as const,evidence,userMessages:[{id:draft.input.inputId,text:draft.input.dispatchText}],assistantMessage:{id:'fixture-answer',text:'合成回复，尚未实现或验收。'}};
 const derive=createProjectTerminalModelDeriver({async complete(){return JSON.stringify({outcome:'proposals',claims:[{stableKey:'offline-marker',kind:'decision',text:'完全虚构项目：离线演示使用蓝色圆点。',branchRef:'pinecone-demo',condition:'离线演示',sourceMessageIds:[draft.input.inputId]}]});}});
 const memory=new SqliteProjectMemory(join(f.root,'memory.sqlite'),{autoProcess:false,extractor:createProjectTerminalExtractor({async readTerminalMaterial(){return material;}},derive)});t.after(()=>memory.close());const job=await memory.enqueueTerminal(evidence);await memory.runPending();assert.equal((await memory.getJob(projectId,job.jobId))?.attempts,1);
 const [item]=await memory.list({projectId,limit:20});assert.ok(item);assert.equal(item.status,'candidate');assert.equal(item.sources[0]?.userInputId,draft.input.inputId);assert.equal(tool.reviewRichQuality({items:[item],projectId,sourceTaskIds:[task.id]}).status,'semantic_review_required');assert.deepEqual(await memory.recall({projectId,limit:20,branchRef:'pinecone-demo'}),[]);
 const source={userInputId:'fixture-human-only',recordedAt:at};await memory.change({type:'accept',operationId:'accept',projectId,id:item.id,expectedVersion:1,source});assert.equal((await memory.get(projectId,item.id))?.version,2);assert.equal((await memory.recall({projectId,limit:20,branchRef:'pinecone-demo'})).length,1);assert.deepEqual(await memory.recall({projectId:otherId,limit:20,branchRef:'pinecone-demo'}),[]);
 assert.equal((await memory.change({type:'edit',operationId:'stale',projectId,id:item.id,expectedVersion:1,text:'stale',source})).state,'conflict');await memory.change({type:'edit',operationId:'edit',projectId,id:item.id,expectedVersion:2,text:'完全虚构项目：人工改为绿色圆点。',source});await memory.change({type:'withdraw',operationId:'withdraw',projectId,id:item.id,expectedVersion:3,source});assert.deepEqual(await memory.recall({projectId,limit:20,branchRef:'pinecone-demo'}),[]);assert.equal((await memory.enqueueTerminal(evidence)).state,'already_queued');assert.equal(await memory.runPending(),0);assert.equal((await memory.get(projectId,item.id))?.status,'withdrawn');assert.equal(f.turnSends(),0);
});
