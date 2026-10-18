import { parseEmotionAssessment } from './emotion-inference.js';
import { hostClock } from './host-clock.js';
import { buildDialogueRequest, type DialogueRequestFrame, type DialogueRequestOptions } from './dialogue-request.js';
import { countRequestInput } from './input-count.js';
import type { DialogueProvider, DialogueReply, DialogueRequest, ExpressionIntent, MemoryMaintenanceInput, MemoryMaintenanceProvider, MemoryChange } from '../contracts/index.js';
import { assertScope, checkAbort } from '../media/scope.js';
import { EndpointConfig, object, parseModelJson, ProviderTransport, string } from './transport.js';
import { assertRoleInput, completedText, exactFields, parseMemoryChanges } from './memory-json.js';
import { MEMORY_MAINTENANCE_PROMPT } from './memory-prompt.js';

import { PRESENTATION_PRESET_IDS } from '../contracts/presentation.js';

import { normalizeSpokenText } from './spoken-text.js';
import type { SocialContextPort } from '../companion/cloud/protocol.js';


function expression(raw: unknown): ExpressionIntent {
  const value = object(raw);
  if (typeof value.intensity !== 'number' || !Number.isFinite(value.intensity) || value.intensity < 0 || value.intensity > 1) throw new Error('Invalid expression intensity');
  return { ...(value.presetId === undefined ? {} : { presetId: value.presetId === null ? null : string(value.presetId) }), emotion: string(value.emotion), intensity: value.intensity, delivery: string(value.delivery), gesture: value.gesture === null ? null : string(value.gesture) };
}

/** No output length cap is introduced; JSON mode is followed by local shape validation. */
export class JsonDialogueProvider implements DialogueProvider {
  constructor(private readonly config: EndpointConfig, private readonly transport = new ProviderTransport(),
    private readonly visualPolicy?: () => { presets: readonly { id: string; label: string }[] },
    private readonly clock: () => ReturnType<typeof hostClock> = hostClock,
    private readonly requestOptions: DialogueRequestOptions = {}, private readonly social?: SocialContextPort) {}
  private readonly frames=new Map<string,{input:Omit<DialogueRequest,'context'>;frame:DialogueRequestFrame}>();
  prepare(input:Omit<DialogueRequest,'context'>):void {
    const key=JSON.stringify(input.scope);
    const reference=this.social?.capture(input.scope.characterId);
    this.frames.delete(key);this.frames.set(key,{input:structuredClone(input),frame:{now:this.clock(),...(reference?{social:structuredClone(reference)}:{}),...(this.visualPolicy?{visual:structuredClone(this.visualPolicy())}:{})}});
    if(this.frames.size>64)this.frames.delete(this.frames.keys().next().value!);
  }
  private frame(scope:DialogueRequest['scope'],text:string) {
    const key=JSON.stringify(scope);let frozen=this.frames.get(key);
    if(!frozen||frozen.input.text!==text){this.prepare({scope,text});frozen=this.frames.get(key)!;}
    return frozen;
  }
  countContext(context:DialogueRequest['context'],text:string):number {
    const frozen=this.frame(context.scope,text);
    const built=buildDialogueRequest({...frozen.input,context},this.config,frozen.frame,this.requestOptions);
    return countRequestInput({...built.body,model:this.config.model});
  }
  async reply(original: DialogueRequest, signal: AbortSignal): Promise<DialogueReply> {
    checkAbort(signal);
    const input = structuredClone(original);
    assertScope(input.scope, input.context.scope);
    if (input.context.perception) assertScope(input.scope, input.context.perception.scope);
    assertRoleInput({ scope: input.scope, messages: input.context.recent, relevantMemories: input.context.memories });
    if (!Number.isFinite(input.context.inputTokenBudget) || input.context.inputTokenBudget <= 0) throw new Error('Explicit context input budget required');
    const frozen=this.frame(input.scope,input.text);
    if(JSON.stringify(frozen.input)!==JSON.stringify({scope:input.scope,text:input.text,...(input.memoryOutcome?{memoryOutcome:input.memoryOutcome}:{}),...(input.memoryPending?{memoryPending:input.memoryPending}:{})})) {
      this.prepare({scope:input.scope,text:input.text,...(input.memoryOutcome?{memoryOutcome:input.memoryOutcome}:{}),...(input.memoryPending?{memoryPending:input.memoryPending}:{})});
    }
    const built=buildDialogueRequest(input,this.config,this.frame(input.scope,input.text).frame,this.requestOptions);
    if(countRequestInput({...built.body,model:this.config.model})>input.context.inputTokenBudget)throw Error('required_context_exceeds_budget');
    const {forgetting}=built;
    const reference=this.frame(input.scope,input.text).frame.social;
    if(reference&&!forgetting)this.social?.assertCurrent(reference);
    const raw = await this.transport.request(this.config, input.scope, 'dialogue', built.body, signal);
    checkAbort(signal);
    if(reference&&!forgetting)this.social?.assertCurrent(reference);
    const reply = parseModelJson(completedText(raw)), text = normalizeSpokenText(string(reply.text), built.currentMessage);
    const intent = expression(reply.expression);
    // The assembled context omits this turn (memory/context.ts skips it), so the message identity is
    // supplied here rather than looked up in `recent`, where it is never present.
    const emotionAssessment = forgetting ? undefined : parseEmotionAssessment(reply.emotionAssessment,input,
      { id: `${input.scope.turnId}:user`, version: 1 });
    if (this.visualPolicy) {
      const enabled = new Set(this.visualPolicy().presets.map(p => p.id));
      // Reread after model latency. Only the visual projection is filtered; words and TTS intent survive.
      const presetId = intent.presetId && PRESENTATION_PRESET_IDS.includes(intent.presetId as never) && enabled.has(intent.presetId) ? intent.presetId : null;
      return { scope: input.scope, text, expression: { ...intent, presetId }, ...(emotionAssessment?{emotionAssessment}:{}) };
    }
    return { scope: input.scope, text, expression: intent, ...(emotionAssessment?{emotionAssessment}:{}) };
  }
}

/** Only proposes operations; role-specific storage and retrieval invalidation remain owned by W3. */
export class QwenMemoryMaintenanceProvider implements MemoryMaintenanceProvider {
  constructor(private readonly config: EndpointConfig, private readonly transport = new ProviderTransport()) {}
  async propose(input: MemoryMaintenanceInput, signal: AbortSignal): Promise<readonly MemoryChange[]> {
    checkAbort(signal); assertRoleInput(input);
    const messages = [{ role: 'system', content: MEMORY_MAINTENANCE_PROMPT },
      { role: 'user', content: JSON.stringify({ messages: input.messages, memories: input.relevantMemories }) }];
    const raw = await this.transport.request(this.config, input.scope, 'memory_maintenance', { messages, stream: false, enable_thinking: false, response_format: { type: 'json_object' } }, signal);
    checkAbort(signal);
    const parsed = parseModelJson(completedText(raw));
    exactFields(parsed, ['changes']);
    return parseMemoryChanges(parsed.changes, input);
  }
}

/** Historical descriptive shape; runtime integration uses LocalDialogueConfiguration. */
export interface OllamaDialogueBoundary { endpoint: string; model: string; capabilities: readonly ['dialogue']; verified: false }

/** Historical import compatibility; protocol is selected from the registered endpoint. */
export class QwenDialogueProvider extends JsonDialogueProvider {}
