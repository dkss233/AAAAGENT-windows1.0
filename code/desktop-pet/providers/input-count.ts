import type { InputBudgetInfo, TokenCountingMethod } from '../contracts/context-budget.js';
import type { JsonRecord } from './transport.js';
import { DEEPSEEK_ENDPOINT, DEEPSEEK_FLASH_MODEL } from './text-protocol.js';

export const DEFAULT_FOREGROUND_INPUT_TOKENS = 200000;
export const DEFAULT_CURRENT_EMOTION_RESERVE_TOKENS = 512;
/** Registered 2026-10-03 from official DeepSeek V4.1 model metadata. */
export const DEEPSEEK_FLASH_CONTEXT_WINDOW = 1048576;
export function countingMethod(model:string):TokenCountingMethod {
  return {method:'utf8_upper_bound',estimated:true,model,version:'whole-request-utf8-v1'};
}
/** Entire wire JSON plus conservative chat/protocol framing. Bytes are an explicitly
 * labelled prediction upper bound, never actual tokenizer tokens or billed usage.
 * No credential/header contents are counted, serialized or retained here. */
export function countRequestInput(body:JsonRecord):number {
  const messages=Array.isArray(body.messages)?body.messages:[];
  return Buffer.byteLength(JSON.stringify(body),'utf8')+2048+128*messages.length;
}
export interface InputBudgetModel {
  readonly model:string;readonly endpoint:string;readonly inputTokenLimit:number;readonly outputTokenLimit:number;
  readonly contextWindowTokens?:number;readonly targetInputTokens?:number;
}
export function inputBudgetInfo(model:InputBudgetModel,target=model.targetInputTokens??DEFAULT_FOREGROUND_INPUT_TOKENS):InputBudgetInfo {
  const window=model.endpoint===DEEPSEEK_ENDPOINT&&model.model===DEEPSEEK_FLASH_MODEL
    ? DEEPSEEK_FLASH_CONTEXT_WINDOW:model.contextWindowTokens??null;
  if(![target,model.inputTokenLimit,model.outputTokenLimit].every(n=>Number.isSafeInteger(n)&&n>0)
    ||window!==null&&(!Number.isSafeInteger(window)||window<=model.outputTokenLimit))throw Error('invalid_context_budget');
  const remaining=window===null?Infinity:window-model.outputTokenLimit;
  const effective=Math.min(target,model.inputTokenLimit,remaining);
  return {targetInputTokens:target,apiInputLimit:model.inputTokenLimit,contextWindowTokens:window,
    reservedOutputTokens:model.outputTokenLimit,effectiveInputTokens:effective,
    constrainedBy:[...(effective===target?['target' as const]:[]),...(effective===model.inputTokenLimit?['api_input' as const]:[]),...(effective===remaining?['context_window' as const]:[])],counting:countingMethod(model.model)};
}
export function dialogueReservation(model:InputBudgetModel & {inputMicrosPerToken:number;outputMicrosPerToken:number},target?:number):number {
  const budget=inputBudgetInfo(model,target);
  const maximum=Math.ceil(budget.effectiveInputTokens*model.inputMicrosPerToken+budget.reservedOutputTokens*model.outputMicrosPerToken);
  if(!Number.isSafeInteger(maximum)||maximum<0)throw Error('invalid_context_cost');
  return maximum;
}
