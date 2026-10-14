/** Offline preparation and explicitly gated no-model creation. No dispatch, provider fetch or worker entry. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, join, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RICH_PRESET, RICH_SYSTEM, RICH_OUTPUT_CAP, richPresetFiles } from '../../workbench/integration/dsh-rich-memory-trial.mjs';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const stable = (plan, name) => { const h=hash([plan.runId,name]); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export const RICH_INPUTS = Object.freeze({
  codex: '这是完全虚构的合成项目“松果A”，不是真实产品要求。请仅用中文简短重述以下决定与未决事项，不使用工具、不读文件、不联网、不委派，不声称完成任何实现。约束：只有完成真实Host执行并核对结果后才能标记验收通过，编译成功或模拟检查不算验收。决定：仅在分支pinecone-demo且离线演示条件下使用蓝色圆点作为状态标记。未决：尚未测量低电量模式下的响应时间。请保留这些适用条件和未验证状态。',
  dsh: '这是完全虚构的合成项目“松果A”，不是真实产品要求。请仅用中文简短重述以下决定与未决事项，不使用工具、不读文件、不联网、不委派，不声称完成任何实现。约束：只有完成真实Host执行并核对结果后才能标记验收通过，编译成功或模拟检查不算验收。决定：仅在分支pinecone-demo且离线演示条件下使用蓝色圆点作为状态标记。未决：尚未测量低电量模式下的响应时间。请保留这些适用条件和未验证状态。',
});
export function prepareRichPlan({ projectRoot, runId, sourceRevision, createdAt }) {
  if (!isAbsolute(projectRoot) || resolve(projectRoot) !== projectRoot || !id(runId) ||
      !/^[a-f0-9]{40}$/.test(sourceRevision) || !Number.isFinite(Date.parse(createdAt))) throw Error('Exact root/run/source/time required');
  const base = join(projectRoot, 'artifacts/W0-I/rich-memory-roundtrip-54/projects', runId);
  const plan = { version: 'b54-rich-front-v1', runId, sourceRevision, createdAt, projectRoot,
    evidenceLevel: 'preparation_only_no_native_identity',
    projects: ['A','B'].map(kind => ({ kind, name: `完全虚构·松果${kind}·${runId}`,
      abstract: `完全虚构的B54项目记忆${kind==='A'?'丰富知识':'跨项目隔离'}验收样例；无真实用户事实。`,
      workspaceRoot: join(base, kind), nativeTasks: kind === 'A' ? ['codex','dsh'] : [] })),
    providers: {
      codex: { model: 'gpt-6-astra', account: 'existing-chatgpt-pro', runtimeMode: 'approval-required', interactionMode: 'default',
        binaryVersion: '0.156.0', input: RICH_INPUTS.codex, systemBoundary: 'native Codex/T3-owned; not replaced or claimed fully frozen by this tool',
        fullPromptCapacity: 'unverified_separate_package', nativeTransportRetries: 'existing official same-turn behavior; not a one-HTTP guarantee',
        launchControlsRequired: { shell_tool:false, unified_exec:false, memories:false, apps:false, plugins:false, multi_agent:false, hooks:false, skip_host_skill_discovery:true, project_doc_max_bytes:0 },
        fullNativeInstructionsSha256: null },
      dsh: { model: 'deepseek-official/deepseek-flash', reasoningEffort: 'high', account: 'existing-native-account',
        runtimeMode: 'approval-required', interactionMode: 'default', preset: RICH_PRESET, system: RICH_SYSTEM,
        input: RICH_INPUTS.dsh, maxOutputTokens: RICH_OUTPUT_CAP, automaticRetries: 0, tools: [] },
    },
    limits: { newProjectCards:2, newNativeTasks:2, newNativeTurnsAuthorized:0, extractionPOSTsAuthorized:0,
      globalWorker:false, titleModel:false, tools:false, recall:false },
    extraction: { status:'await_actual_completed_material', fabricatedTaskOrTurnIds:false,
      futureEntry:'project-terminal-finite-trial.mjs', queuedJobs:2, attemptOrdinal:1, maxPOSTsPerJob:1,
      model:'deepseek-flash', adapter:'deepseek-summary', maxOutputTokens:1024, timeoutMs:30000,
      automaticRetries:0, budgetMode:'unlimited', limitMicros:null },
    quality: [ 'explicit Host acceptance constraint retained', 'pinecone-demo and offline condition retained',
      'unmeasured response time remains open_question', 'all model items remain candidate with exact source IDs',
      'no_change/missing/false-completion are quality failures; never repaired into model success',
      'manual acceptance/edit/withdrawal recorded separately; project B never enters A recall' ],
  };
  return { ...plan, planSha256: hash(plan) };
}
export function validateRichPlan(plan) {
  assert.deepEqual(plan, prepareRichPlan(plan));
  return plan;
}
const projectInput = p => ({ expectedVersion:0, name:p.name, abstract:p.abstract, detailRef:{rootPath:p.workspaceRoot} });
function verifyProject(planProject, project) {
  assert.ok(project && id(project.id)); assert.equal(project.version,1);
  assert.equal(project.name,planProject.name); assert.equal(project.abstract,planProject.abstract);
  assert.deepEqual(project.detailRef,{rootPath:planProject.workspaceRoot}); assert.equal(project.codexTarget,undefined);
}
async function findProject(port, p) {
  const matches=[];let offset=0;
  while(true){const page=await port.list({query:'',offset,limit:100});
    matches.push(...page.items.filter(x=>x.name===p.name||x.detailRef.rootPath===p.workspaceRoot));
    offset+=page.items.length;if(offset>=page.total)break;if(!page.items.length)throw Error('Project list changed');}
  if(matches.length>1)throw Error('Ambiguous fictional project');
  if(matches.length)verifyProject(p,matches[0]);return matches[0]??null;
}
function approve(plan, approval) {
  assert.deepEqual(Object.keys(approval).sort(),['mode','planSha256','reference','scope'].sort());
  assert.ok(['offline-test','approved-create-only'].includes(approval.mode));
  assert.equal(approval.planSha256,plan.planSha256);assert.equal(approval.scope,'two-fictional-projects-two-native-tasks-no-turn');
  assert.ok(typeof approval.reference==='string'&&approval.reference.trim());
}
/** Projects are recovered by exact reserved path/name; task creation uses the existing persistent command claim.
 * The local receipt is an operator record, not a queue. Unknown project-save outcomes never cause a second save.
 * An interrupted exclusive lock is deliberately left for human read-only recovery, never stolen on a timer.
 */
export async function createRichResources({ plan: raw, approval, receiptDirectory, projects, workbench }) {
  const plan=validateRichPlan(raw);approve(plan,approval);
  const root=await realpath(plan.projectRoot);assert.equal(root,plan.projectRoot);
  const allowed=join(root,'artifacts/W0-I/rich-memory-roundtrip-54');
  assert.equal(resolve(receiptDirectory),receiptDirectory);
  const part=relative(allowed,receiptDirectory);assert.ok(part && !part.startsWith('..')&&!isAbsolute(part));
  assert.equal(await realpath(dirname(receiptDirectory)),dirname(receiptDirectory));
  try{await mkdir(receiptDirectory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  assert.equal(await realpath(receiptDirectory),receiptDirectory);
  for(const p of plan.projects)assert.equal(await realpath(p.workspaceRoot),p.workspaceRoot);
  const lockPath=join(receiptDirectory,'create.lock');const lock=await open(lockPath,'wx',0o600);
  const file=join(receiptDirectory,'creation-receipt.json');let receipt;
  const save=async()=>{const next=file+'.next';await writeFile(next,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});await rename(next,file);};
  try {
    try {receipt=JSON.parse(await readFile(file,'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;receipt={version:plan.version,planSha256:plan.planSha256,mode:approval.mode,projects:{},tasks:{},drafts:{}};await save();}
    assert.equal(receipt.planSha256,plan.planSha256);assert.equal(receipt.mode,approval.mode);
    for(const p of plan.projects){
      assert.equal(await realpath(p.workspaceRoot),p.workspaceRoot);
      const prior=receipt.projects[p.kind];let project=await findProject(projects,p);
      if(prior?.id){assert.ok(project);assert.equal(project.id,prior.id);}
      else if(!project){
        if(prior) return {status:'unknown',stage:'project-'+p.kind,receipt};
        receipt.projects[p.kind]={state:'attempted'};await save();
        try{project=await projects.save(projectInput(p));}catch{return {status:'unknown',stage:'project-'+p.kind,receipt};}
      }else if(!prior)throw Error('Unclaimed existing project cannot be adopted');
      verifyProject(p,project);receipt.projects[p.kind]={state:'accepted',id:project.id};await save();
    }
    const projectId=receipt.projects.A.id;
    for(const provider of ['codex','dsh']){
      const selection={instanceId:provider,model:plan.providers[provider].model,...(provider==='dsh'?{reasoningEffort:'high'}:{})};
      const request={operationId:stable(plan,provider+'-create'),projectId,title:`完全虚构·松果A·${provider}·${plan.runId}`,provider,modelSelection:selection};
      const result=await workbench.createNativeTask(request);
      if(result.state!=='accepted')return {status:result.state,stage:provider+'-create',receipt};
      const task=result.task;assert.ok(task&&id(task.id)&&id(task.threadId)&&id(task.t3ProjectId));
      assert.equal(task.projectId,projectId);assert.equal(task.provider,provider);assert.equal(task.providerInstanceId,provider);assert.equal(task.origin,'t3');
      const prior=receipt.tasks[provider];if(prior)assert.deepEqual(task,prior);
      if(provider==='dsh'){assert.equal(task.environmentId,receipt.tasks.codex.environmentId);assert.equal(task.t3ProjectId,receipt.tasks.codex.t3ProjectId);assert.notEqual(task.threadId,receipt.tasks.codex.threadId);}
      const detail=await workbench.detail(projectId,task.id);assert.deepEqual(detail.task,task);
      assert.equal(detail.native.thread.id,task.threadId);assert.equal(detail.native.thread.projectId,task.t3ProjectId);
      assert.equal(detail.native.thread.modelSelection.instanceId,provider);assert.equal(detail.native.thread.modelSelection.model,selection.model);
      if(provider==='dsh')assert.deepEqual(detail.native.thread.modelSelection.options,[{id:'reasoningEffort',value:'high'}]);
      assert.equal(detail.native.thread.runtimeMode,'approval-required');assert.equal(detail.native.thread.interactionMode,'default');
      assert.equal(detail.native.thread.latestTurn,null);assert.deepEqual(detail.native.thread.messages,[]);
      receipt.tasks[provider]=task;await save();
      const input={inputId:stable(plan,provider+'-input'),rawText:plan.providers[provider].input,dispatchText:plan.providers[provider].input,
        createdAt:plan.createdAt,origin:{channel:'web',channelSessionId:stable(plan,'session'),messageId:stable(plan,provider+'-message')}};
      const draft=await workbench.prepareContinuation(task.id,input);
      assert.deepEqual(draft.task,task);assert.deepEqual(draft.input,input);assert.equal(draft.state,'open');
      if(receipt.drafts[provider])assert.deepEqual(draft,receipt.drafts[provider]);
      receipt.drafts[provider]=draft;await save();
    }
    return {status:'prepared_no_turn',receipt,preview:prepareNativeRequestPreview(plan,receipt)};
  } finally {await lock.close();await unlink(lockPath);}
}
/** A preview is bound only to actual returned task/draft IDs, and grants no turn authorization. */
export function prepareNativeRequestPreview(raw,receipt){
  const plan=validateRichPlan(raw);assert.equal(receipt.planSha256,plan.planSha256);
  assert.ok(['offline-test','approved-create-only'].includes(receipt.mode));
  const requests=['codex','dsh'].map(provider=>{
    const task=receipt.tasks[provider],draft=receipt.drafts[provider];assert.ok(task&&draft);
    assert.equal(task.projectId,receipt.projects.A.id);assert.equal(task.provider,provider);assert.deepEqual(draft.task,task);
    assert.equal(draft.state,'open');assert.equal(draft.input.rawText,plan.providers[provider].input);assert.equal(draft.input.dispatchText,plan.providers[provider].input);
    assert.ok(id(draft.id)&&id(draft.commandId));assert.equal(draft.version,1);
    const content={provider,task,draftId:draft.id,draftVersion:draft.version,commandId:draft.commandId,
      input:structuredClone(draft.input),native:plan.providers[provider],authorization:'pending-C-specific-turn'};
    return {...content,requestSha256:hash(content)};
  });
  return {planSha256:plan.planSha256,mode:receipt.mode,modelCallsAuthorized:0,requests,
    extractionRequests:[],extractionBlockedUntil:'actual native completion + durable original evidence + exact selected jobs',
    dshPresetBinding:{plannedSessionId:'t3_'+hash([receipt.tasks.dsh.environmentId,receipt.tasks.dsh.threadId]).slice(0,40),
      basis:'fixed DshAdapter.sessionIdFor deterministic rule; this is a planned identifier, not proof the native session exists',
      nativeSessionExists:'unverified',requiredBeforeSend:'fixed adapter/preset check and exact Host session ownership readback'}};
}
export function prepareBoundDshPreset(plan,preview,nativeSessionId,moduleUrl){
  validateRichPlan(plan);assert.equal(preview.planSha256,plan.planSha256);
  const request=preview.requests.find(r=>r.provider==='dsh');assert.ok(request);
  assert.equal(nativeSessionId,'t3_'+hash([request.task.environmentId,request.task.threadId]).slice(0,40));
  assert.equal(preview.dshPresetBinding.plannedSessionId,nativeSessionId);
  const {requestSha256,...body}=request;assert.equal(hash(body),requestSha256);
  assert.equal(request.input.dispatchText,plan.providers.dsh.input);
  return richPresetFiles(moduleUrl,{sessionId:nativeSessionId,requestId:request.commandId,
    input:request.input.dispatchText,inputSha256:hash(request.input.dispatchText)});
}
/** Freeze only two actual first-attempt terminal jobs selected from this receipt. No queue processing here. */
export async function freezeRichTerminalRequests({plan:raw,receipt,jobs,configuration,materialPort}){
  const plan=validateRichPlan(raw);prepareNativeRequestPreview(plan,receipt);
  assert.equal(receipt.mode,'approved-create-only');assert.equal(jobs.length,2);
  const tasks=Object.values(receipt.tasks);assert.equal(new Set(jobs.map(j=>j.evidence.taskId)).size,2);
  for(const job of jobs){const task=tasks.find(t=>t.id===job.evidence.taskId);assert.ok(task);
    assert.equal(job.evidence.projectId,receipt.projects.A.id);assert.equal(job.evidence.terminalPhase,'completed');
    assert.ok(job.evidence.resultRef?.startsWith(`t3:${task.environmentId}:${task.threadId}:message:`));
    assert.equal(job.evidence.extractionVersion,'b54-t3-terminal-v1');assert.equal(job.state,'queued');assert.equal(job.attempts,0);}
  const {freezeProjectTerminalRequests}=await import('../dist/management/project-terminal-request-review.js');
  const checked={async readTerminalMaterial(evidence){
    const material=await materialPort.readTerminalMaterial(evidence);assert.deepEqual(material.evidence,evidence);
    const task=tasks.find(t=>t.id===evidence.taskId);const draft=receipt.drafts[task.provider];
    assert.equal(material.userMessages.length,1);assert.equal(material.userMessages[0].id,draft.input.inputId);
    assert.equal(material.userMessages[0].text,draft.input.dispatchText);return material;
  }};
  return freezeProjectTerminalRequests(configuration,[...jobs].sort((a,b)=>a.id.localeCompare(b.id)),checked);
}
/** Deliberately reports review-needed: keyword hits cannot establish semantic correctness. */
export function reviewRichQuality({items,projectId,sourceTaskIds}){
  const failures=[];
  if(!items.length)failures.push('no candidates: no_change or omissions must be reported as quality failure');
  for(const item of items){if(item.projectId!==projectId||item.status!=='candidate'||!item.sources?.length||
      item.sources.some(s=>!sourceTaskIds.includes(s.taskId)||!s.nativeTurnId||!s.terminalEventId))failures.push('candidate status or exact source boundary failed');}
  return {status:failures.length?'failed':'semantic_review_required',failures,items:items.map(i=>({id:i.id,version:i.version,text:i.text,kind:i.kind,branchRef:i.branchRef??null,condition:i.condition??null,sources:i.sources})),
    criteria:prepareRichPlan({projectRoot:'/synthetic',runId:'criteria',sourceRevision:'a'.repeat(40),createdAt:'2026-09-28T00:00:00Z'}).quality,
    automaticSemanticPass:false,manualEditsCountAsModelSuccess:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [action,projectRoot,runId,sourceRevision,createdAt,...extra]=process.argv.slice(2);
  if(action!=='--plan'||!projectRoot||!runId||!sourceRevision||!createdAt||extra.length)throw Error('Usage: --plan ROOT RUN_ID SOURCE_SHA ISO_TIME; creation is explicit callable-only, never automatic');
  process.stdout.write(JSON.stringify(prepareRichPlan({projectRoot,runId,sourceRevision,createdAt}),null,2)+'\n');
}
