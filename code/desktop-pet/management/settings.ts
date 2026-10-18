import { DEFAULT_FOREGROUND_INPUT_TOKENS, DEFAULT_CURRENT_EMOTION_RESERVE_TOKENS, inputBudgetInfo, dialogueReservation } from '../providers/input-count.js';
import { deepseekFlashDialogueModel, DEEPSEEK_ENDPOINT, DEEPSEEK_FLASH_MODEL } from '../providers/text-protocol.js';
import { TEXT_SLOTS } from '../providers/text-protocol.js';
import { ManagementError, type ManagedSettings, type ProviderAdapterInfo, type ProviderSelection, type ProviderSlot } from '../contracts/management.js';
import { validateTrialConfiguration, type TrialConfiguration } from '../app/trial-config.js';
import { credentialRegistry } from './credentials.js';
import { managementAdapterCatalog, CUSTOM_TTS_ADAPTER_ID } from '../providers/management-catalog.js';
import { validateCustomTts } from '../providers/local-speech.js';
import type { RegisteredVoiceStore } from '../providers/registered-voices.js';

export const PROVIDER_SLOTS: readonly ProviderSlot[] = ['asr', 'dialogue', 'memory_turn', 'summary', 'perception', 'tts', 'admission'];
const ADAPTERS: Record<ProviderSlot, string> = { asr:'qwen-asr', dialogue: 'qwen-dialogue', memory_turn: 'strict-deepseek', summary: 'qwen-summary', perception: 'qwen-visual-emotion', tts: 'qwen-tts-instruct', admission: 'semantic-admission' };
export function defaultManagedSettings(base: TrialConfiguration, credentials = credentialRegistry(base)): ManagedSettings {
  const providers = Object.fromEntries(PROVIDER_SLOTS.filter(slot=>base.models[slot]).map(slot => {
    const { credentialFile, targetInputTokens:_target, ...model } = slot==='dialogue'&&base.models[slot]!.model===DEEPSEEK_FLASH_MODEL&&base.models[slot]!.endpoint===DEEPSEEK_ENDPOINT ? deepseekFlashDialogueModel(base.models[slot]!.credentialFile) as import('../app/trial-config.js').TrialModel : base.models[slot]!;
    return [slot, { ...model, adapterId: TEXT_SLOTS.includes(slot as never) && model.provider === 'deepseek' ? `deepseek-${slot}` : slot === 'perception' && !base.models.asr ? 'qwen-perception' : ADAPTERS[slot], credentialRef: credentials.ref(credentialFile, model.provider),
      ...(slot === 'tts' ? { voice: 'Cherry', language: 'Chinese' } : {}) }];
  })) as ManagedSettings['providers'];
  providers.dialogue.reservationMicros=dialogueReservation(providers.dialogue,DEFAULT_FOREGROUND_INPUT_TOKENS);
  return { providers, context: { targetInputTokens:DEFAULT_FOREGROUND_INPUT_TOKENS,currentEmotionReserveTokens:DEFAULT_CURRENT_EMOTION_RESERVE_TOKENS,maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, summaryMinMessages: 12, summaryMaxMessages: 24, timeoutMs: base.memory.timeoutMs } };
}
export function availableAdapters(base: TrialConfiguration, voices?: RegisteredVoiceStore): ProviderAdapterInfo[] {
  return managementAdapterCatalog(base, voices?.snapshot().voices);
}
function invalid(message = '配置字段不受当前运行方式支持。'): never { throw new ManagementError('invalid_request', message); }
function keys(value: unknown, allowed: readonly string[], required = allowed): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const names = Object.keys(value); if (names.some(name => !allowed.includes(name)) || required.some(name => !names.includes(name))) invalid();
}
const text = (value: unknown, max = 160): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
export function validateManagedSettings(value: unknown, base: TrialConfiguration, voices?: RegisteredVoiceStore, historical = false, credentials = credentialRegistry(base), draftOnly = false, priorDialogueReservation?:number): ManagedSettings {
  keys(value, ['providers', 'context']); keys(value.providers, PROVIDER_SLOTS, PROVIDER_SLOTS.filter(slot=>slot!=='asr' || (!historical && !!base.models.asr)));
  const oldContextKeys=['maxRecentMessages', 'maxMemories', 'summaryLimit', 'summaryMinMessages', 'summaryMaxMessages', 'timeoutMs'];
  keys(value.context,[...oldContextKeys,'targetInputTokens','currentEmotionReserveTokens'],oldContextKeys);
  value=structuredClone(value);
  keys(value,['providers','context']);keys(value.context,[...oldContextKeys,'targetInputTokens','currentEmotionReserveTokens'],oldContextKeys);keys(value.providers,PROVIDER_SLOTS,PROVIDER_SLOTS.filter(slot=>slot!=='asr' || (!historical && !!base.models.asr)));
  keys(value.providers.dialogue,Object.keys(value.providers.dialogue as object));
  const legacy=value.context.targetInputTokens===undefined;
  value.context.targetInputTokens??=DEFAULT_FOREGROUND_INPUT_TOKENS;
  value.context.currentEmotionReserveTokens??=DEFAULT_CURRENT_EMOTION_RESERVE_TOKENS;
  const target=value.context.targetInputTokens,reserve=value.context.currentEmotionReserveTokens;
  if(!Number.isSafeInteger(target)||(target as number)<1||!Number.isSafeInteger(reserve)||(reserve as number)<0||(reserve as number)>(target as number))invalid('输入预算与当前情绪预留无效。');
  if(legacy&&value.providers.dialogue?.model===DEEPSEEK_FLASH_MODEL&&value.providers.dialogue.endpoint===DEEPSEEK_ENDPOINT&&value.providers.dialogue.inputTokenLimit===32768) {
    Object.assign(value.providers.dialogue,{inputTokenLimit:1048576,contextWindowTokens:1048576,reservationMicros:3545728});
  }
  const limits = { maxRecentMessages: [1, 200], maxMemories: [1, 200], summaryLimit: [0, 50], summaryMinMessages: [2, 200], summaryMaxMessages: [2, 200], timeoutMs: [1000, 300000] };
  for (const [key, [min, max]] of Object.entries(limits)) { const n = value.context[key]; if (!Number.isSafeInteger(n) || (n as number) < min! || (n as number) > max!) invalid('上下文参数超出当前支持范围。'); }
  if ((value.context.summaryMinMessages as number) > (value.context.summaryMaxMessages as number)) invalid('摘要触发条数不能超过摘要读取条数。');
  const adapters = availableAdapters(base, voices);
  if (historical) {
    const legacy = structuredClone(base);
    delete (legacy.models as {asr?:unknown}).asr;
    const plus=legacy.models.perception.model.includes('omni-plus');
    (legacy.models as Record<string,unknown>).perception={...legacy.models.perception,inputMicrosPerToken:plus?53:18,outputMicrosPerToken:plus?40:13.3,reservationMicros:plus?13_100_000:4_500_000};
    for (const slot of TEXT_SLOTS) (legacy.models as Record<string, unknown>)[slot] = { ...base.models[slot],
      provider: 'dashscope', model: 'qwen-plus-2025-12-01', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      credentialFile: base.models.perception.credentialFile, inputTokenLimit: 32768, outputTokenLimit: 32768,
      inputMicrosPerToken: 0.8, outputMicrosPerToken: 2, reservationMicros: 100000 };
    for (const adapter of availableAdapters(legacy, voices)) if (!adapters.some(a => a.id === adapter.id)) adapters.push(adapter);
  }
  for (const slot of PROVIDER_SLOTS) {
    if(slot==='asr' && value.providers.asr===undefined)continue;
    const p = value.providers[slot];
    const required = ['adapterId', 'provider', 'model', 'endpoint', 'credentialRef', 'inputTokenLimit', 'outputTokenLimit', 'reservationMicros', 'inputMicrosPerToken', 'outputMicrosPerToken'];
    keys(p, [...required, 'characterMicros', 'thinking', 'voice', 'language', 'temperature', 'audioMicrosPerSecond','contextWindowTokens'], required);
    const adapter = adapters.find(a => a.id === p.adapterId && a.slots.includes(slot));
    // An operator-defined supplier is not in the reviewed catalogue, so it cannot satisfy the
    // allow-list checks below. It is instead checked against the customTts block the operator saved:
    // supplier, address and model must match that block exactly, which is what keeps the selection and
    // the address actually dialled in step. Without this branch a custom supplier could never be
    // applied from the console, which is the whole point of the feature.
    const custom = slot === 'tts' && base.customTts ? validateCustomTts(base.customTts) : undefined;
    if (custom && p.adapterId === CUSTOM_TTS_ADAPTER_ID) {
      if (p.provider !== custom.provider || p.endpoint !== custom.baseUrl + '/audio/speech'
        || p.model !== custom.model || p.voice !== custom.voice) invalid('自定义语音的服务商、地址、模型或音色与已保存的设置不一致。');
      if (![p.inputTokenLimit, p.outputTokenLimit].every(n => Number.isSafeInteger(n) && (n as number) >= 0)) invalid('模型用量上界无效。');
      try { credentials.file(p.credentialRef as string, custom.provider); } catch { invalid('请先保存该自定义服务商的 API Key。'); }
      continue;
    }
    if (!adapter || adapter.provider !== p.provider || !adapter.endpoints.includes(p.endpoint as string) || !text(p.model) || !text(p.credentialRef)) invalid();
    if (!adapter.models.includes(p.model)) invalid('这个型号尚未登记适配能力和费用边界，不能应用。');
    const choice = adapter.choices?.find(c => c.configuration.model === p.model && c.configuration.endpoint === p.endpoint);
    if (!choice) invalid('型号和服务地址不匹配。');
    const pricing = choice.configuration;
    if (![p.inputTokenLimit, p.outputTokenLimit].every(n => Number.isSafeInteger(n) && (n as number) >= (slot === 'tts' || slot === 'asr' ? 0 : 1))) invalid('模型用量上界无效。');
    if (p.thinking !== pricing.thinking) invalid('思考方式必须与已登记型号一致。');
    if(p.contextWindowTokens!==undefined&&p.contextWindowTokens!==pricing.contextWindowTokens)invalid('模型总窗口由登记提供，不能自行改写。');
    if(slot==='dialogue'&&pricing.contextWindowTokens!==undefined)p.contextWindowTokens=pricing.contextWindowTokens;
    for (const key of ['inputMicrosPerToken', 'outputMicrosPerToken', 'reservationMicros', 'characterMicros', 'audioMicrosPerSecond'] as const)
      if (p[key] !== pricing[key] && !(slot==='dialogue'&&key==='reservationMicros'&&(p[key]===priorDialogueReservation||p[key]===dialogueReservation(p as unknown as ProviderSelection,target as number)))) invalid('计费边界由已登记型号提供，不能在页面中自行改写。');
    if(slot==='dialogue')p.reservationMicros=dialogueReservation(p as unknown as ProviderSelection,target as number);
    if ((p.inputTokenLimit as number) > pricing.inputTokenLimit || (p.outputTokenLimit as number) > pricing.outputTokenLimit) invalid('用量范围不能超过此型号已登记的计费上界。');
    try { credentials.file(p.credentialRef, adapter.provider); } catch { invalid('请选择已登记的同供应商凭据。'); }
    if (p.temperature !== undefined && (!adapter.capabilities.temperature || typeof p.temperature !== 'number' || !Number.isFinite(p.temperature) || p.temperature < 0 || p.temperature > 2)) invalid('此模块不支持所填温度。');
    if (slot === 'tts') {
      if (!text(p.voice, 128) || !choice.voices?.some(v => v.id === p.voice)) invalid('请选择此型号已登记的音色。');
      if (voices?.snapshot().voices.some(voice => voice.voiceId === p.voice)) {
        try { voices.resolve({ voiceId: p.voice, provider: p.provider as 'dashscope', targetModel: p.model,
          endpoint: p.endpoint as string, credentialRef: p.credentialRef }); }
        catch { invalid('克隆音色与此模型、服务地址或凭据不匹配。'); }
      }
      if (adapter.capabilities.language ? !text(p.language, 40) : p.language !== undefined) invalid('语言参数与此语音适配器不匹配。');
    } else if (p.voice !== undefined || p.language !== undefined || p.characterMicros !== undefined) invalid();
    if (slot === 'perception' && !/^qwen3\.5-omni-(flash|plus)(-\d{4}-\d{2}-\d{2})?$/.test(p.model)) invalid('视频情绪需要已支持的Qwen3.5-Omni型号。');
  }
  const settings = structuredClone(value) as unknown as ManagedSettings;
  try { effectiveTrialConfiguration(base, settings, credentials, draftOnly); } catch { invalid('模型参数、调用预留或计费边界无效；额度不会自动扩大。'); }
  return settings;
}
export function effectiveTrialConfiguration(base: TrialConfiguration, settings: ManagedSettings, credentials = credentialRegistry(base), draftOnly = false): TrialConfiguration {
  const models = Object.fromEntries(PROVIDER_SLOTS.filter(slot=>settings.providers[slot]).map(slot => {
    const { adapterId: _adapter, credentialRef, voice: _voice, language: _language, temperature: _temperature, ...model } = settings.providers[slot]!;
    // Registered model capacity is provider metadata, not an operator setting: the settings draft never
    // carries it, so it has to travel with the model it belongs to. The strict memory registration
    // requires it, and a settings page cannot measure it by itself.
    const capacity = base.models[slot]?.contextWindowTokens;
    return [slot, { ...model, ...(capacity === undefined ? {} : { contextWindowTokens: capacity }), credentialFile: credentials.file(credentialRef, model.provider),...(slot==='dialogue'?{targetInputTokens:settings.context.targetInputTokens??DEFAULT_FOREGROUND_INPUT_TOKENS,reservationMicros:dialogueReservation(model,settings.context.targetInputTokens??DEFAULT_FOREGROUND_INPUT_TOKENS)}:{}) }];
  })) as TrialConfiguration['models'];
  const candidate = { ...base, models, memory: { ...base.memory, timeoutMs: settings.context.timeoutMs } };
  return draftOnly ? candidate : validateTrialConfiguration(candidate);
}
