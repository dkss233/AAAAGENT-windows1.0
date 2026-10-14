import type { ConversationMessage, DialogueContext, MemoryChangeResult, MemoryMaintenanceInput, MemoryMaintenanceProvider, MemoryPort, PerceptionResult, TurnScope } from '../contracts/index.js';
import { assembleContext, type ContextOptions, type ContextSnapshot } from './context.js';
import { bindScope, sameScope } from './scope.js';
import { SqliteMemoryStore } from './sqlite-store.js';

export interface SqliteContextOptions extends Omit<ContextOptions, 'prompts'> { readonly summaryLimit: number; readonly recentPageSize?: number }
export function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new Error('memory_cancelled'); }
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('memory_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Scheduling belongs to the application: exactly one caller queues maintenance after append commits. */
export class SqliteMemoryPort implements MemoryPort {
  constructor(readonly store: SqliteMemoryStore, private readonly options: SqliteContextOptions, private readonly provider?: MemoryMaintenanceProvider) {}
  async append(scope: TurnScope, messages: readonly ConversationMessage[]): Promise<void> { this.store.append(scope, messages); }
  async context(scope: TurnScope, text: string, perception: PerceptionResult | null, signal: AbortSignal): Promise<DialogueContext> {
    return this.createContext(scope, text, perception, signal).context;
  }
  protected createContext(scope: TurnScope, text: string, perception: PerceptionResult | null, signal: AbortSignal, excludePersonal=false, currentMessageId?:string): ContextSnapshot {
    checkAbort(signal); const owned = bindScope(scope, scope.characterId);
    if (perception && !sameScope(owned, perception.scope)) throw new Error('perception_scope_mismatch');
    if (perception) {
      const source = this.store.inspect(owned, `${owned.turnId}:user`);
      if (source?.state === 'active') this.store.recordPerception(owned, perception, [source.id]);
    }
    const privacyExcluded=excludePersonal||this.store.pending.has(owned.characterId);
    const foreground=this.store.foregroundRecords(owned,privacyExcluded,excludePersonal,this.options.recentPageSize);
    const data=foreground.data;
    const evaluatedAt=this.store.now(),policyRevision=this.store.dynamics.policy().revision;
    const candidates=privacyExcluded?[]:this.store.recall.rank(owned,text,evaluatedAt);
    const scores=new Map(candidates.map(candidate=>[candidate.source.id,candidate.priority]));
    const candidateOrder=new Map(candidates.map((candidate,index)=>[candidate.source.id,index]));
    let snapshot = assembleContext({ characterId: owned.characterId, contextRecords: requested => {
      bindScope(requested, owned.characterId); return {...data,memories:this.store.recall.references(owned,candidates)};
    }, recentTurns:()=>foreground.turns,hasUnreadRecent:()=>foreground.turns.hasUnread(),
      ...(!privacyExcluded?{messageEmotion:(requested:TurnScope,id:string)=>this.store.emotion.message(requested,id)}:{}),assertContextCurrent: (requested, revision) => this.store.assertContextCurrent(requested, revision) }, owned, text, privacyExcluded?null:perception, this.store.now(), {
      ...this.options,...(currentMessageId?{currentMessageId}:{}), ...(!privacyExcluded?{emotionBackground:this.store.emotion.background(owned)}:{}),
      memoryTieBreak:(a,b)=>(candidateOrder.get(a.id)??0)-(candidateOrder.get(b.id)??0), relevance:memory=>scores.get(memory.id)??0, prompts: { [owned.characterId]: this.store.prompt(owned) },
    });
    if(snapshot.context.contextBudget){
      const exclusions=candidates.filter(candidate=>candidate.omission!==null).map(candidate=>({id:candidate.source.id,layer:'memory' as const,reason:candidate.omission!}));
      snapshot={...snapshot,context:{...snapshot.context,contextBudget:{...snapshot.context.contextBudget,omissions:[...snapshot.context.contextBudget.omissions,...exclusions]}}};
    }
    checkAbort(signal); return {...snapshot,privacyExcluded,recall:{candidates,policyRevision,evaluatedAt,dataRevision:data.revision}};
  }
  maintenanceInput(scope: TurnScope, text: string): MemoryMaintenanceInput {
    const owned = bindScope(scope, scope.characterId);
    const data = this.store.contextRecords(owned, text, this.options.maxRecentMessages, this.options.maxMemories, this.options.summaryLimit,'maintenance');
    return { scope: owned, messages: data.recent, relevantMemories: data.memories };
  }
  async maintain(input: MemoryMaintenanceInput, signal: AbortSignal): Promise<readonly MemoryChangeResult[]> {
    checkAbort(signal);
    if (!this.provider) throw new Error('memory_maintenance_provider_not_configured');
    const task = this.store.prepareMaintenance(input);
    try {
      const changes = await abortable(this.provider.propose(structuredClone(task.input), signal), signal);
      checkAbort(signal);
      return this.store.finishMaintenance(task, changes);
    } catch (error) {
      if (!this.store.closed) this.store.cancelMaintenance(task);
      throw error;
    }
  }
}
