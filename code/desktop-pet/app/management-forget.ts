import { createHash } from 'node:crypto';
import type { MemoryRecordAction, MemoryRecordActionResult } from '../contracts/memory-dynamics.js';
import { ManagementError, type ManagementMemoryPort } from '../contracts/management.js';
import type { MemoryTurnInput, MemoryTurnPlan } from '../contracts/memory-lifecycle.js';
import type { SqliteMemoryStore } from '../memory/sqlite-store.js';
import type { InputBudget } from '../memory/sqlite-lifecycle-state.js';
import { MemoryRuleError } from '../memory/scope.js';

interface ForgetTicket {readonly input:MemoryTurnInput;readonly action:MemoryRecordAction;readonly dataRevision:number}
export interface ManagementForgetLifecycle {
 managementForgetOutcome(action:MemoryRecordAction):MemoryRecordActionResult|null;
 readManagementForget(action:MemoryRecordAction,budget:InputBudget<MemoryTurnInput>):ForgetTicket;
 commitManagementForget(ticket:ForgetTicket,plan:MemoryTurnPlan):MemoryRecordActionResult;
 discardManagementForget(ticket:ForgetTicket):void;
}
/** Named storage rules that the operator can act on. Codes are diagnostic identifiers, never record text. */
const forgetReasons:Record<string,()=>ManagementError> = {
 invalid_token_count:()=>new ManagementError('invalid_request','无法统计这次遗忘请求的输入规模，尚未执行遗忘。请刷新后重试或查看运行记录。'),
 management_source_closure_exceeds_budget:()=>new ManagementError('invalid_request','这条记忆的来源闭包超出单次严格来源处理的输入上限，尚未执行遗忘。这不是暂时故障，重试不会成功；请减少关联来源，或在运行记录中查看实际数量。'),
 memory_hard_gate:()=>new ManagementError('invalid_request','这条内容当前不满足遗忘条件（可能已删除、已失效或不可作为证据），尚未执行遗忘。请刷新后核对它的状态。'),
 management_forget_already_completed:()=>new ManagementError('version_conflict','这次遗忘已经完成过，尚未重复执行。请刷新后核对当前状态。'),
 management_forget_target_required:()=>new ManagementError('invalid_request','严格来源计划没有包含这条记忆的删除操作，尚未执行遗忘。请重试或查看运行记录。'),
 management_forget_target_survived:()=>new ManagementError('invalid_request','严格来源处理结束后这条记忆仍然存在，遗忘未生效。请刷新后核对。'),
 };
function translated(error:unknown):never {
 if(error instanceof ManagementError)throw error;
 if(error instanceof MemoryRuleError&&(/stale|version_conflict|operation_id_payload_mismatch/.test(error.message)))
  throw new ManagementError('version_conflict','数据或操作已变化，尚未执行遗忘，请刷新后重试。');
 if(error instanceof MemoryRuleError){const named=forgetReasons[error.message]?.();if(named)throw named;}
 // Keep the underlying failure class and message. Every producer on this path throws fixed
 // developer strings or storage rule codes: no record text, model output or credential reaches here.
 const detail=error instanceof Error&&error.message.trim()?error.message.trim():'';
 const name=error instanceof Error&&error.name?error.name:'unknown';
 throw new ManagementError('unavailable','严格来源处理未完成，尚未执行遗忘。诊断：'+name+(detail?(' / '+detail):''));
}
/** User-triggered management only. No raw text, model responses or credentials are copied to diagnostics. */
export class StrictManagementForget {
 private readonly pending=new Map<string,{signature:string;result:Promise<MemoryRecordActionResult>}>();
 private readonly controller=new AbortController();
 constructor(private readonly store:SqliteMemoryStore,private readonly lifecycle:ManagementForgetLifecycle,
  private readonly budget:InputBudget<MemoryTurnInput>,private readonly plan:(input:MemoryTurnInput,signal:AbortSignal,action:MemoryRecordAction)=>Promise<MemoryTurnPlan>){}
 forget(action:MemoryRecordAction):Promise<MemoryRecordActionResult>{
  const captured=structuredClone(action),key=JSON.stringify([captured.characterId,captured.operationId]);
  const signature=createHash('sha256').update(JSON.stringify([captured.characterId,captured.id,captured.expectedVersion,captured.operationId,captured.reason])).digest('hex');
  const prior=this.pending.get(key);
  if(prior){if(prior.signature!==signature)return Promise.reject(new ManagementError('version_conflict','同一操作标识不能用于不同请求。'));return prior.result;}
  const result=this.execute(captured).catch(translated).finally(()=>this.pending.delete(key));
  this.pending.set(key,{signature,result});return result;
 }
 private async execute(action:MemoryRecordAction):Promise<MemoryRecordActionResult>{
  this.controller.signal.throwIfAborted();
  const prior=this.lifecycle.managementForgetOutcome(action);if(prior)return prior;
  try{return this.store.dynamicsAction({characterId:action.characterId,sessionId:'management-dynamics',turnId:action.operationId,generation:0},action,false);}
  catch(error){if(!(error instanceof MemoryRuleError)||error.message!=='forget_requires_source_plan')throw error;}
  const ticket=this.lifecycle.readManagementForget(action,this.budget);
  try{
   const plan=await this.plan(structuredClone(ticket.input),this.controller.signal,structuredClone(action));this.controller.signal.throwIfAborted();
   return this.lifecycle.commitManagementForget(ticket,plan);
  }finally{this.lifecycle.discardManagementForget(ticket);}
 }
 close(){this.controller.abort();}
 async drain(){await Promise.allSettled([...this.pending.values()].map(x=>x.result));}
}
export function withStrictManagementForget(memory:ManagementMemoryPort,forget:StrictManagementForget):ManagementMemoryPort {
 const d=memory.dynamics;if(!d)throw Error('Memory dynamics port is required');
 return {characters:()=>memory.characters(),list:q=>memory.list(q),edit:i=>memory.edit(i),context:(c,q)=>memory.context(c,q),prompt:c=>memory.prompt(c),savePrompt:i=>memory.savePrompt(i),
  dynamics:{snapshot:q=>d.snapshot(q),traces:q=>d.traces(q),preview:i=>d.preview(i),savePolicy:i=>d.savePolicy(i),rollbackPolicy:i=>d.rollbackPolicy(i),restore:i=>d.restore(i),forget:i=>forget.forget(i)}};
}
