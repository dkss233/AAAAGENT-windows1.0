import { JsonDialogueProvider } from '../providers/qwen-dialogue.js';
import { DEEPSEEK_ENDPOINT, DEEPSEEK_FLASH_MODEL } from '../providers/text-protocol.js';
import type { DialogueContext } from '../contracts/index.js';
import type { MemoryTurnInput, SummaryInput } from '../contracts/memory-lifecycle.js';
import { SUMMARY_PROMPT } from '../providers/memory-lifecycle-prompt.js';
import { checkedSources, MemoryWire, type MemoryWireMode } from '../providers/memory-wire.js';
import { buildMemoryTurnFormat } from '../providers/memory-turn-format.js';

/** Conservative UTF-8 byte upper bounds, including current provider instructions and framing.
 * These are not exact tokenizer counts. No bound is applied to the reply's output length. */
export function contextInputUpperBound(context: DialogueContext, currentText: string): number {
  // Offline evaluation compatibility. Production uses the live provider's
  // countContext, with its actual frozen visual and execution-state frame.
  const provider = new JsonDialogueProvider({ model: DEEPSEEK_FLASH_MODEL, endpoint: DEEPSEEK_ENDPOINT,
    apiKey: () => '', authorizer: { authorize: async () => { throw Error('offline_counter_only'); } } });
  return provider.countContext(context, currentText);
}
export function memoryTurnInputUpperBound(input: MemoryTurnInput, mode: MemoryWireMode = 'numeric-v1'): number {
  const format = buildMemoryTurnFormat(input, mode);
  return Buffer.byteLength(JSON.stringify(format.data), 'utf8') + Buffer.byteLength(format.system, 'utf8') + 2048;
}
export function summaryInputUpperBound(input: SummaryInput): number {
  const wire = new MemoryWire(checkedSources(input.scope, input.sources));
  return Buffer.byteLength(JSON.stringify(wire.data()), 'utf8') + Buffer.byteLength(SUMMARY_PROMPT, 'utf8') + 2048;
}
