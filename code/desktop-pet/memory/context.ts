import type { ConversationMessage, DialogueContext, MemoryReference, PerceptionResult, TurnScope } from '../contracts/index.js';
import { CONTEXT_BUDGET_VERSION, type ContextBudgetReport, type ContextLayer, type InputBudgetInfo } from '../contracts/context-budget.js';
import type { EmotionBackground, EmotionMessageSnapshot } from '../contracts/emotion-state.js';
import { characterPrompt } from '../companion/prompts.js';
import type { ContextRecords } from './ledger.js';
import { bindScope, sameScope, timestamp } from './scope.js';

export interface ContextReader {
  readonly characterId: TurnScope['characterId'];
  contextRecords(scope: TurnScope): ContextRecords;
  recentTurns?(scope: TurnScope): Iterable<readonly ConversationMessage[]>;
  hasUnreadRecent?(): boolean;
  messageEmotion?(scope: TurnScope, id: string): EmotionMessageSnapshot | null;
  assertContextCurrent(scope: TurnScope, revision: number): void;
}
export interface ContextOptions {
  readonly messageEmotions?: readonly EmotionMessageSnapshot[];
  readonly emotionBackground?: EmotionBackground;
  readonly memoryTieBreak?: (a:MemoryReference,b:MemoryReference)=>number;
  readonly prompts: Parameters<typeof characterPrompt>[1];
  readonly inputTokenBudget: number;
  /** Legacy background read fields; never foreground selection caps. */
  readonly maxRecentMessages: number;
  readonly maxMemories: number;
  readonly budgetInfo?: InputBudgetInfo;
  readonly currentEmotionReserveTokens?: number;
  readonly currentMessageId?: string;
  /** Counts the whole frozen provider request, excluding local diagnostics. */
  readonly countTokens: (context: DialogueContext, currentText: string) => number;
  readonly relevance: (memory: MemoryReference, query: string) => number;
}
export interface ContextSnapshot {
  readonly privacyExcluded?:boolean;
  readonly recall?: import('./sqlite-recall.js').RecallAssembly;
  readonly context: DialogueContext;
  readonly revision: number;
  readonly countedInputTokens: number;
  readonly selectedIds: readonly string[];
  readonly omittedIds: readonly string[];
}

function* inMemoryTurns(messages: readonly ConversationMessage[]): Generator<readonly ConversationMessage[]> {
  const turns: ConversationMessage[][]=[];
  for(const message of messages){
    if(message.role==='user'||!turns.length)turns.push([message]);
    else turns[turns.length-1]!.push(message);
  }
  yield* turns.reverse();
}
/** Synchronous, source-stamped assembly. Large fitting blocks are counted once;
 * only blocks crossing capacity are divided, preserving ordered greedy selection. */
export function assembleContext(ledger: ContextReader, scope: TurnScope, text: string, perception: PerceptionResult | null, now: string, options: ContextOptions): ContextSnapshot {
  const owned = bindScope(scope, ledger.characterId), at=timestamp(now);
  const reserve=options.currentEmotionReserveTokens??512;
  if(!Number.isSafeInteger(options.inputTokenBudget)||options.inputTokenBudget<=0||!Number.isSafeInteger(reserve)||reserve<0)throw new Error('invalid_context_budget');
  // Validate legacy input shape without using these values as selection caps.
  for(const legacy of [options.maxRecentMessages,options.maxMemories])if(!Number.isSafeInteger(legacy)||legacy<0)throw new Error('invalid_context_budget');
  if(options.budgetInfo&&options.budgetInfo.effectiveInputTokens!==options.inputTokenBudget)throw new Error('context_budget_mismatch');
  if (perception && !sameScope(owned, perception.scope)) throw new Error('perception_scope_mismatch');
  const currentPerception = perception ? structuredClone({ ...perception, cues: perception.cues.filter(cue => timestamp(cue.expiresAt) > at) }) : null;
  const data = ledger.contextRecords(owned);
  let context: DialogueContext = {
    scope: owned, characterPrompt: characterPrompt(ledger.characterId, options.prompts), recent: [], summary: '', memories: [],
    perception: currentPerception, inputTokenBudget: options.inputTokenBudget,
  };
  const count = (value: DialogueContext): number => {
    const result = options.countTokens(structuredClone(value), text);
    if (!Number.isSafeInteger(result) || result < 0) throw new Error('invalid_token_count');
    return result;
  };
  let countedInputTokens=count(context);
  if(countedInputTokens>options.inputTokenBudget)throw new Error('required_context_exceeds_budget');
  const layers:Record<ContextLayer,number>={required:countedInputTokens,current_emotion:0,recent:0,summary:0,memory:0,historical_emotion:0};
  const omissions:ContextBudgetReport['omissions'][number][]=[],selectedIds:string[]=[],omittedIds:string[]=[];
  const omit=(layer:ContextLayer,reason:string,ids:readonly string[]=[])=>{
    if(ids.length)for(const id of ids){omittedIds.push(id);omissions.push({id,layer,reason});}
    else omissions.push({layer,reason});
  };
  const admit=(candidate:DialogueContext,layer:ContextLayer,max=options.inputTokenBudget):boolean=>{
    const tokens=count(candidate);
    if(tokens>max)return false;
    const delta=tokens-countedInputTokens;
    if(delta<0)throw new Error('nonmonotonic_context_count');
    context=candidate;countedInputTokens=tokens;layers[layer]+=delta;return true;
  };
  const background=options.emotionBackground;
  if(background&&(background.user.observation||background.companion.observation)){
    const ceiling=Math.min(options.inputTokenBudget,countedInputTokens+reserve);
    if(!admit({...context,emotionBackground:background},'current_emotion',ceiling)){
      // Strip redundant state chronology, never observation content/provenance/source versions.
      const brief:EmotionBackground={user:{...background.user,updatedAt:null,logicalOrder:null,sessionId:null},companion:{...background.companion,updatedAt:null,logicalOrder:null,sessionId:null}};
      if(!admit({...context,emotionBackground:brief},'current_emotion',ceiling))omit('current_emotion','current_emotion_budget');
    }
  }
  let selectedTurns=0,stopped=false;
  const currentId=options.currentMessageId;
  const recent=ledger.recentTurns?.(owned)??inMemoryTurns(data.recent);
  const considerTurns=(turns:readonly (readonly ConversationMessage[])[]):void=>{
    if(!turns.length)return;
    if(stopped){for(const turn of turns)omit('recent','recent_budget',turn.map(m=>m.id));return;}
    const candidate={...context,recent:[...turns.slice().reverse().flat(),...context.recent]};
    if(admit(candidate,'recent')){selectedTurns+=turns.length;selectedIds.push(...turns.flatMap(turn=>turn.map(m=>m.id)));return;}
    if(turns.length===1){stopped=true;omit('recent','recent_budget',turns[0]!.map(m=>m.id));return;}
    const mid=Math.floor(turns.length/2);considerTurns(turns.slice(0,mid));considerTurns(turns.slice(mid));
  };
  let block: (readonly ConversationMessage[])[]=[];
  for(const turn of recent){
    // The current question is already in the required provider currentMessage.
    if(turn[0]?.id===currentId)continue;
    if(turn[0]?.role!=='user'){omit('recent','orphan_assistant',turn.map(m=>m.id));continue;}
    block.push(turn);
    if(block.length===16){considerTurns(block);block=[];if(stopped)break;}
  }
  considerTurns(block);
  // Include fitting blocks at once, split crossing blocks, skip an individual
  // oversized summary/memory and still test later smaller eligible records.
  const selectItems=<T>(items:readonly T[],layer:ContextLayer,ids:(item:T)=>string,build:(items:readonly T[])=>DialogueContext):number=>{
    if(!items.length)return 0;
    if(admit(build(items),layer)){selectedIds.push(...items.map(ids));return items.length;}
    if(items.length===1){omit(layer,`${layer}_budget`,[ids(items[0]!)]);return 0;}
    const mid=Math.floor(items.length/2);return selectItems(items.slice(0,mid),layer,ids,build)+selectItems(items.slice(mid),layer,ids,build);
  };
  const summaries=[...data.summaries].sort((a,b)=>timestamp(b.createdAt)-timestamp(a.createdAt)||a.id.localeCompare(b.id));
  let selectedSummaries=0;
  for(let i=0;i<summaries.length;i+=32)selectedSummaries+=selectItems(summaries.slice(i,i+32),'summary',s=>s.id,items=>({...context,summary:[context.summary,...items.map(s=>s.origin==='manual'?`[人工编辑摘要] ${s.text}`:s.text)].filter(Boolean).join('\n')}));
  const candidates=data.memories.map(memory=>{
    const score=options.relevance(structuredClone(memory),text);
    if(!Number.isFinite(score))throw new Error('invalid_relevance_score');return {memory,score};
  }).sort((a,b)=>b.score-a.score||options.memoryTieBreak?.(a.memory,b.memory)||a.memory.id.localeCompare(b.memory.id));
  const eligible:MemoryReference[]=[];
  for(const {memory,score} of candidates){if(score<=0)omit('memory','no_cue',[memory.id]);else eligible.push(memory);}
  for(let i=0;i<eligible.length;i+=32)selectItems(eligible.slice(i,i+32),'memory',m=>m.id,items=>({...context,memories:[...context.memories,...items]}));
  const metadata=new Map(options.messageEmotions?.map(m=>[m.message.id,m]));
  const historical=context.recent.slice().reverse().flatMap(message=>{
    const value=ledger.messageEmotion?.(owned,message.id)??metadata.get(message.id);
    return value&&(value.observations.length||value.background.user.observation||value.background.companion.observation)?[value]:[];
  });
  // These are metadata omissions, not omissions of already admitted transcript IDs.
  let historicalEmotions=0;
  const selectEmotions=(items:readonly EmotionMessageSnapshot[]):void=>{
    if(!items.length)return;
    const map=new Map(items.map(item=>[item.message.id,item]));
    if(admit({...context,recent:context.recent.map(m=>map.has(m.id)?{...m,emotionSnapshot:map.get(m.id)!}:m)},'historical_emotion')){historicalEmotions+=items.length;return;}
    if(items.length===1){omissions.push({id:items[0]!.message.id,layer:'historical_emotion',reason:'historical_emotion_budget'});return;}
    const mid=Math.floor(items.length/2);selectEmotions(items.slice(0,mid));selectEmotions(items.slice(mid));
  };
  for(let i=0;i<historical.length;i+=32)selectEmotions(historical.slice(i,i+32));
  ledger.assertContextCurrent(owned,data.revision);
  if(options.budgetInfo)context={...context,contextBudget:{...options.budgetInfo,version:CONTEXT_BUDGET_VERSION,countedInputTokens,
    selected:{messages:context.recent.length,turns:selectedTurns,summaries:selectedSummaries,memories:context.memories.length,historicalEmotions},layers,omissions,unreadRecent:ledger.hasUnreadRecent?.()??false}};
  return {context:structuredClone(context),revision:data.revision,countedInputTokens,selectedIds,omittedIds};
}
