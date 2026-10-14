import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoardRegistry, boardDigest, boardId, readPrivateBoardJson, writePrivateBoardJson } from './registry.mjs';

export const DAILY_BOARD_CONTROL_VERSION = '0.1.1';

const nativeIdentity = thread => thread.nativeSessionObservation?.nativeId ?? null;
const safeModel = value => value && value.instanceId === 'codex' && boardId(value.model) && (!value.options || typeof value.options === 'object');

/** Original T3 is the sole executor. This service stores role records and once-only admission receipts. */
export function createDailyBoardService({ directory, client, gate, python, now = () => Date.now() }) {
  if (!client || !gate || !['environmentDescriptor','shellSnapshot','threadSnapshot','dispatch','readReceipt'].every(k => typeof client[k] === 'function')) throw Error('original_board_transport_required');
  let serial = Promise.resolve();
  const exclusive = action => { const pending = serial.then(action); serial = pending.catch(() => {}); return pending; };
  async function verifyParticipants(scope, actors, frozen) {
    const environment = await client.environmentDescriptor();
    if (environment.environmentId !== scope.environmentId) throw Error('original_environment_changed');
    const shell = await client.shellSnapshot();
    const project = shell.projects?.find(p => p.id === scope.projectId && p.deletedAt == null);
    if (!project || !boardId(project.workspaceRoot)) throw Error('original_project_unavailable');
    const originals = [];
    for (let i=0;i<actors.length;i++) {
      const actor=actors[i], snapshot=await client.threadSnapshot(actor.threadId), thread=snapshot?.thread;
      const target=await gate.targetCapability(actor.threadId);
      if (!thread || thread.id !== actor.threadId || thread.projectId !== scope.projectId || thread.deletedAt != null || thread.archivedAt != null || !safeModel(thread.modelSelection) || thread.modelSelection.instanceId !== actor.providerInstanceId || !boardId(thread.runtimeMode) || !boardId(thread.interactionMode) || !target || target.environmentId !== scope.environmentId || target.projectId !== scope.projectId || target.source !== 't3' || target.readonly || target.providerInstanceId !== actor.providerInstanceId) throw Error('original_conversation_unavailable');
      const original = { projectRoot:project.workspaceRoot,workspaceRoot:thread.worktreePath ?? project.workspaceRoot,
        branch:thread.branch ?? null,modelSelection:thread.modelSelection,runtimeMode:thread.runtimeMode,interactionMode:thread.interactionMode,nativeSessionId:target.nativeSessionId ?? nativeIdentity(thread) };
      if (frozen) {
        const expected=frozen[i].original;
        if (boardDigest([original.projectRoot,original.workspaceRoot,original.branch,original.modelSelection,original.runtimeMode,original.interactionMode]) !== boardDigest([expected.projectRoot,expected.workspaceRoot,expected.branch,expected.modelSelection,expected.runtimeMode,expected.interactionMode]) || expected.nativeSessionId !== null && expected.nativeSessionId !== original.nativeSessionId) throw Error('registered_conversation_changed');
      }
      originals.push(original);
    }
    return originals;
  }
  const registry=createBoardRegistry({directory,verifyParticipants,python});
  async function current(scope) {
    const saved=registry.load(scope);
    if (!saved) throw Error('board_unregistered');
    const originals=await verifyParticipants(scope,saved.participants,saved.participants);
    let changed=false;
    saved.participants.forEach((actor,i) => { if (actor.original.nativeSessionId === null && originals[i].nativeSessionId !== null) { actor.original.nativeSessionId=originals[i].nativeSessionId; changed=true; } });
    if (changed) writePrivateBoardJson(join(saved.folder,'registry.json'),saved);
    return saved;
  }
  async function readBoard(saved) {
    const snapshot=await registry.snapshot(saved);
    return { ...snapshot,participants:snapshot.participants.map(actor => ({...actor,identitySource:'t3-original-thread-snapshot',nativeThreadId:saved.participants.find(a=>a.actorId===actor.actorId).original.nativeSessionId})) };
  }
  function journal(saved) { const value=readPrivateBoardJson(join(saved.folder,'dispatches.json')); if(value.version!=='0.1.0'||!value.records||Array.isArray(value.records)) throw Error('dispatch_state_changed'); return value; }
  const journalFile=saved=>join(saved.folder,'dispatches.json');
  async function receipt(saved,row,state) {
    if((await client.environmentDescriptor()).environmentId!==saved.scope.environmentId)throw Error('original_environment_changed');
    const original=await client.readReceipt(row.commandId);
    if (original) {
      if (original.aggregateKind!=='thread'||original.aggregateId!==row.threadId||!['accepted','rejected'].includes(original.status)||!Number.isSafeInteger(original.resultSequence)||original.resultSequence<0) throw Error('original_receipt_mismatch');
      gate.reconcile(row.commandId,{...original,commandId:row.commandId});
      row.status=original.status;row.sequence=original.resultSequence;
      writePrivateBoardJson(journalFile(saved),state);
    }
    return { commandId:row.commandId,threadId:row.threadId,taskId:row.taskId,status:row.status,sequence:row.sequence??null,resent:false };
  }
  async function dispatch(saved,actor,request) {
    if(actor.role!=='coordinator'||Object.keys(request.body??{}).some(k=>k!=='taskId')||!boardId(request.body?.taskId)) throw Error('coordinator_dispatch_required');
    const state=journal(saved),old=state.records[request.body.taskId];
    if(old) {
      if(old.operationId!==request.operationId)throw Error('original_dispatch_frozen');
      return receipt(saved,old,state);
    }
    if(Object.values(state.records).some(row=>row.operationId===request.operationId))throw Error('dispatch_operation_changed');
    const board=await registry.snapshot(saved),task=board.tasks.find(t=>t.taskId===request.body.taskId);
    const target=task&&saved.participants.find(a=>a.actorId===task.ownerActorId);
    if(!task||!target||target.role!=='executor') throw Error('assigned_target_required');
    const read=board.events.filter(e=>e.actorId===actor.actorId&&e.kind==='read').at(-1);
    if(!read||read.revision<task.assignedRevision||request.expectedRevision!==board.revision) throw Error('current_assignment_read_required');
    const grant=saved.dispatchAuthorization;
    if(!grant||Date.parse(grant.expiresAt)<=now()) throw Error('dispatch_not_authorized');
    const key=boardDigest([saved.scope,actor.actorId,task.taskId,task.assignedRevision]);
    if(task.status!=='assigned'||Object.keys(state.records).length>=grant.maxDispatches) throw Error('dispatch_limit_or_task_state');
    const original=target.original;
    const {thread:latest}=await client.threadSnapshot(target.threadId,1);
    if(latest?.session?.activeTurnId || latest?.session && !['ready','stopped','error'].includes(latest.session.status))throw Error('registered_receiver_busy');
    const context=registry.publicRegistration(saved).participants.find(p=>p.actorId===target.actorId).contextFile;
    const cli=fileURLToPath(new URL('./client.mjs',import.meta.url));
    const body=['Independent collaboration task '+task.taskId+'. You are registered executor '+target.actorId+' in this original independent conversation.',
      'Use this local tool with your own private context: node '+JSON.stringify(cli)+' --context '+JSON.stringify(context)+' read; then start/report for task '+task.taskId+'. For writes, pass - after the kind and provide JSON on stdin: operationId, expectedRevision from your preceding read, body. Keep role credentials private. Do not spawn native children or substitute another conversation.',
      'Original assigned instructions:',task.instructions].join('\n');
    const createdAt=new Date(now()).toISOString(),commandId='board-'+key;
    const command={type:'thread.turn.start',commandId,threadId:target.threadId,runtimeMode:original.runtimeMode,interactionMode:original.interactionMode,modelSelection:original.modelSelection,message:{messageId:'board-message-'+key,role:'user',text:body,attachments:[]},createdAt};
    const reserved=await gate.reserve({id:commandId,payload:command});
    if(reserved.kind!=='forward') throw Error('original_admission_denied');
    const row={key,operationId:request.operationId,commandId,threadId:target.threadId,taskId:task.taskId,commandSha256:boardDigest(command),status:'submitted',submittedAt:createdAt};
    state.records[task.taskId]=row;
    // Persist before any forward. A failed write leaves the original admission unresolved, never retried.
    writePrivateBoardJson(journalFile(saved),state);
    try { const accepted=await client.dispatch(command); if(!Number.isSafeInteger(accepted?.sequence)||accepted.sequence<0)throw Error('original_dispatch_response_unverified'); gate.receive(commandId,{_tag:'Success',value:accepted}); row.status='accepted';row.sequence=accepted.sequence;writePrivateBoardJson(journalFile(saved),state); }
    catch { return { commandId,threadId:target.threadId,taskId:task.taskId,status:'submitted',sequence:null,resent:false }; }
    return {commandId,threadId:target.threadId,taskId:task.taskId,status:row.status,sequence:row.sequence,resent:false};
  }
  return {
    registry,
    setOrigin(origin) { const url=new URL(origin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw Error('local_board_origin_required');writePrivateBoardJson(join(directory,'runtime.json'),{version:'0.1.0',origin:url.origin,pid:process.pid}); },
    register(input) { return exclusive(()=>registry.register(input)); },
    read(scope) { return exclusive(async()=>readBoard(await current(scope))); },
    actor(request,capability) { return exclusive(async()=>{
      if(!request||Object.keys(request).some(k=>!['scope','actorId','operationId','kind','body','expectedRevision'].includes(k))||!boardId(request.actorId)||!boardId(request.operationId))throw Error('invalid_actor_request');
      const registered=registry.load(request.scope);
      if(!registered)throw Error('board_unregistered');
      const actor=registry.authenticate(registered,request.actorId,capability);
      if(request.kind==='dispatch') {
        if(journal(registered).records[request.body?.taskId])return dispatch(registered,actor,request);
        return dispatch(await current(request.scope),actor,request);
      }
      if(request.kind==='dispatch-receipt') {
        if(actor.role!=='coordinator'||Object.keys(request.body??{}).some(k=>k!=='taskId'))throw Error('coordinator_receipt_required');
        const state=journal(registered),row=state.records[request.body?.taskId];if(!row||row.operationId!==request.operationId)throw Error('original_dispatch_not_found');
        return receipt(registered,row,state);
      }
      const saved=await current(request.scope);
      if(request.kind==='snapshot')return {ok:true,snapshot:await readBoard(saved)};
      if(!['read','assign','start','report','summary'].includes(request.kind))throw Error('unsupported_board_action');
      return registry.apply(saved,request,capability);
    }); },
  };
}
