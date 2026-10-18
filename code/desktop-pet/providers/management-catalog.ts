import { deepseekFlashModel, deepseekFlashDialogueModel, TEXT_SLOTS } from './text-protocol.js';
import type { TrialConfiguration, TrialModel } from '../app/trial-config.js';
import type { ProviderAdapterInfo, ProviderSelection, ProviderSlot } from '../contracts/management.js';
import type { RegisteredVoice } from './registered-voices.js';
import { MINIMAX_TTS_MODEL, MINIMAX_TTS_ENDPOINT } from './minimax-tts.js';
import { QWEN_AUDIO_TTS_V31_MODEL } from './qwen-audio-tts.js';
import { validateCustomTts } from './local-speech.js';

type Selection = Omit<ProviderSelection, 'credentialRef'>;
type Choice = NonNullable<ProviderAdapterInfo['choices']>[number];
const chatEndpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const ttsEndpoint = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const slots: readonly ProviderSlot[] = ['asr', 'dialogue', 'memory_turn', 'summary', 'perception', 'tts', 'admission'];
const identities: Record<ProviderSlot, [string, string]> = {
  asr: ['qwen-asr','语音转写'],
  dialogue: ['qwen-dialogue', '对话'], memory_turn: ['strict-deepseek', '严格记忆'],
  summary: ['qwen-summary', '摘要'], perception: ['qwen-visual-emotion', '视频情绪'],
  tts: ['qwen-tts-instruct', '情绪语音'], admission: ['semantic-admission', '语义准入'],
};

// Reviewed 2026-09-10, Beijing tariffs. CNY / million tokens equals micros / token.
// Sources and limitations: artifacts/W2/runtime-console-01/REVIEW.md.
// These are complete model selections, not labels to overlay on another model's prices.
function chat(adapterId: string, flash: boolean): Selection {
  return { adapterId, provider: 'dashscope', endpoint: chatEndpoint,
    model: flash ? 'qwen-flash-2025-07-28' : 'qwen-plus-2025-12-01',
    inputTokenLimit: 32_768, outputTokenLimit: 32_768,
    inputMicrosPerToken: flash ? 0.15 : 0.8, outputMicrosPerToken: flash ? 1.5 : 2,
    reservationMicros: flash ? 60_000 : 100_000 };
}
function omni(plus: boolean, visual = false): Selection {
  return { adapterId: visual ? identities.perception[0] : 'qwen-perception', provider: 'dashscope', endpoint: chatEndpoint,
    model: `qwen3.5-omni-${plus ? 'plus' : 'flash'}-2026-03-15`,
    inputTokenLimit: 196_608, outputTokenLimit: 65_536,
    // Separate visual-only rates; historical combined input retains its audio upper rate.
    inputMicrosPerToken: visual ? (plus ? 7 : 2.2) : (plus ? 53 : 18), outputMicrosPerToken: plus ? 40 : 13.3,
    reservationMicros: visual ? Math.ceil(196_608 * (plus ? 7 : 2.2) + 65_536 * (plus ? 40 : 13.3)) : (plus ? 13_100_000 : 4_500_000) };
}
function speech(model: string): Selection {
  return { adapterId: identities.tts[0], provider: 'dashscope', endpoint: ttsEndpoint, model,
    inputTokenLimit: 0, outputTokenLimit: 0, inputMicrosPerToken: 0, outputMicrosPerToken: 0,
    characterMicros: 80, reservationMicros: 100_000, voice: 'Cherry', language: 'Chinese' };
}
/** Every voice the non-realtime qwen3-tts-flash model documents, with its official name.
 *  Labels are prefixed with a group so the dropdown stays navigable at this length.
 *  Source: Alibaba Cloud Model Studio "Qwen-TTS voice list". */
function voices(): NonNullable<Choice['voices']> {
  const group = (prefix: string, list: ReadonlyArray<readonly [string, string]>) => list.map(([id, label]) => ({ id, label: prefix + label }));
  return [
    ...group('女声 · ', [
      ['Cherry', '芊悦'], ['Serena', '苏瑶'], ['Chelsie', '千雪'], ['Momo', '茉兔'],
      ['Vivian', '十三'], ['Maia', '四月'], ['Bella', '萌宝'], ['Jennifer', '詹妮弗'],
      ['Katerina', '卡捷琳娜'], ['Mia', '乖小妹'], ['Bellona', '燕铮莺'], ['Bunny', '萌小姬'],
      ['Elias', '墨讲师'], ['Nini', '邻家妹妹'], ['Seren', '小婉'], ['Stella', '少女阿月'],
      ['Sonrisa', '索尼莎'], ['Sohee', '素熙'], ['Ono Anna', '小野杏'],
    ]),
    ...group('男声 · ', [
      ['Ethan', '晨煦'], ['Moon', '月白'], ['Kai', '凯'], ['Nofish', '不吃鱼'],
      ['Ryan', '甜茶'], ['Aiden', '艾登'], ['Eldric Sage', '沧明子'], ['Mochi', '沙小弥'],
      ['Vincent', '田叔'], ['Neil', '阿闻'], ['Arthur', '徐大爷'], ['Pip', '顽屁小孩'],
      ['Bodega', '博德加'], ['Alek', '阿列克'], ['Dolce', '多尔切'], ['Lenn', '莱恩'],
      ['Emilien', '埃米尔安'], ['Andre', '安德雷'], ['Radio Gol', '拉迪奥·戈尔'],
    ]),
    ...group('方言 · ', [
      ['Jada', '上海-阿珍'], ['Dylan', '北京-晓东'], ['Li', '南京-老李'], ['Marcus', '陕西-秦川'],
      ['Roy', '闽南-阿杰'], ['Peter', '天津-李彼得'], ['Sunny', '四川-晴儿'], ['Eric', '四川-程川'],
      ['Rocky', '粤语-阿强'], ['Kiki', '粤语-阿清'],
    ]),
  ];
}

/** Explicit projection: never serialize credentialFile or other private config fields. */
function baseline(slot: ProviderSlot, model: TrialModel): Selection {
  return { adapterId: identities[slot][0], provider: model.provider, endpoint: model.endpoint, model: model.model,
    inputTokenLimit: model.inputTokenLimit, outputTokenLimit: model.outputTokenLimit,
    ...(model.contextWindowTokens===undefined?{}:{contextWindowTokens:model.contextWindowTokens}),
    inputMicrosPerToken: model.inputMicrosPerToken, outputMicrosPerToken: model.outputMicrosPerToken,
    reservationMicros: model.reservationMicros,
    ...(model.audioMicrosPerSecond === undefined ? {} : {audioMicrosPerSecond:model.audioMicrosPerSecond}),
    ...(model.characterMicros === undefined ? {} : { characterMicros: model.characterMicros }),
    ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
    ...(slot === 'tts' ? { voice: 'Cherry', language: 'Chinese' } : {}) };
}

/** Adapter id for an operator-configured OpenAI-compatible TTS endpoint. Exported so the settings
 *  validator and the catalogue agree on one spelling. */
export const CUSTOM_TTS_ADAPTER_ID = 'custom-openai-tts';

/** Metadata only. The caller supplies the registered baseline; no file, key, device or network access. */
export function managementAdapterCatalog(base: TrialConfiguration, registeredVoices: readonly RegisteredVoice[] = []): ProviderAdapterInfo[] {
  const catalog: ProviderAdapterInfo[] = slots.filter(slot=>base.models[slot]).map(slot => {
    const model=base.models[slot]!;
    const deepseek = TEXT_SLOTS.includes(slot as never) && model.provider === 'deepseek';
    const [id, label] = slot === 'perception' && !base.models.asr ? ['qwen-perception', '历史联合感知'] : deepseek ? [`deepseek-${slot}`, `${identities[slot][1]} · DeepSeek 4.1 Flash`] : identities[slot];
    const original = deepseek ? { ...baseline(slot, (slot==='dialogue'?deepseekFlashDialogueModel:deepseekFlashModel)(model.credentialFile)), adapterId: id } : { ...baseline(slot, model), adapterId: id };
    const choices: Choice[] = [{ label: `${original.model}（已登记基线）`, configuration: original,
      ...(slot === 'tts' ? { voices: voices() } : {}) }];
    // Only models that exist at this endpoint belong here. The previous list also offered
    // 'qwen3-tts-instruct-flash-2026-01-26' and 'qwen3-tts-instruct-flash'; both answer
    // model_not_found, exactly like an invented name, so selecting either made every synthesised turn
    // fail. The instruction-capable models do exist, but as qwen-audio-3.0-tts-flash / -plus on
    // .../audio/tts/SpeechSynthesizer with their own voices, which speech() does not describe — see the
    // note in providers/qwen-audio-tts.ts before offering them here.
    const reviewed = deepseek ? [] : slot === 'tts'
      ? [speech('qwen3-tts-flash')]
      : slot === 'perception' ? [omni(false, !!base.models.asr), omni(true, !!base.models.asr)]
      : slot === 'memory_turn' || slot === 'asr' ? [] : [chat(id, false), chat(id, true)];
    for (const configuration of reviewed) {
      if (choices.some(choice => choice.configuration.model === configuration.model)) continue;
      choices.push({ label: configuration.model === 'qwen3-tts-flash'
        ? `${configuration.model}（同系列滚动别名）` : configuration.model, configuration,
      ...(slot === 'tts' ? { voices: voices() } : {}) });
    }
    const specific = deepseek ? `DeepSeek 4.1 Flash，官网当前调用ID deepseek-flash；${slot === 'dialogue' ? '对话由本地规则按问题选择思考或非思考，保持JSON协议' : '非思考JSON协议'}。峰值未命中输入2元/百万、输出8元/百万保守估算，缓存与闲时折扣可能降低实际账单。${slot==='dialogue'?'前台默认输入目标200K，API输入容量1048576，总窗口1048576，输出预留393216，默认预留3.545728元':'后台独立输入32768、输出393216，单次预留3.211264元'}；沿原累计账，不自动回退千问文本。官方：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/` : slot === 'perception'
      ? '仅使用本轮摄像头画面判断情绪；语音由独立转写服务处理。沿用原累计总账保守预留。'
      : slot === 'tts'
        ? '仅已接入的指令型系列及预置音色；滚动别名当前对应 2026-01-26，同系列不代表跨系列切换。不支持声音复刻。按实际提交字符预留费用，计入原累计总账。'
        : slot === 'memory_turn'
          ? '保留严格语义记忆与 high 配置。官网当前说明 Pro 在 2026-09-14 后继续提供服务。现费率使用峰值未命中上界。'
          : '已接入非思考 JSON 对话协议；北京输入不超过 128K 的价格档。配置输入上限 32768，保留模型完整输出上限，预留不代表实际扣费。';
    return { id, label, slots: [slot], provider: original.provider,
      endpoints: [...new Set(choices.map(choice => choice.configuration.endpoint))],
      modelHint: original.model, models: choices.map(choice => choice.configuration.model), choices,
      capabilities: { instructions: slot === 'tts', cloning: false, voice: slot === 'tts',
        language: slot === 'tts', temperature: slot === 'dialogue' },
      status: 'available', note: `官方资料核对：${deepseek || slot === 'memory_turn' ? '2026-09-12' : '2026-09-10'}。${specific} 适配器已接入；账户可用性、音质与真实耗时未在本包调用验证。` };
  });
  const qwenAudio: Selection = { adapterId: 'qwen-audio-tts', provider: 'dashscope',
    model: 'qwen-audio-3.0-tts-flash',
    endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    inputTokenLimit: 0, outputTokenLimit: 0, inputMicrosPerToken: 0, outputMicrosPerToken: 0,
    characterMicros: 100, reservationMicros: 400_000, voice: 'longanfengyue' };
  const qwenAudioPlus: Selection = { ...qwenAudio, model: 'qwen-audio-3.0-tts-plus',
    characterMicros: 140, voice: 'longanlingxin' };
  // 3.1 shares the 3.0 endpoint but not the voices; the ids carry a _v3.1 suffix.
  const qwenAudioV31: Selection = { ...qwenAudio, model: QWEN_AUDIO_TTS_V31_MODEL, voice: 'longpaopao_v3.1' };
  catalog.push({ id: qwenAudio.adapterId, label: 'QwenAudio 情绪语音', slots: ['tts'], provider: 'dashscope',
    endpoints: [qwenAudio.endpoint], modelHint: qwenAudio.model,
    models: [qwenAudio.model, qwenAudioPlus.model, qwenAudioV31.model],
    choices: [{ label: 'QwenAudio 3.0 Flash（系统音色）', configuration: qwenAudio,
      voices: [{ id: 'longanfengyue', label: '龙安风悦' }, { id: 'longanlingxi', label: '龙安灵希' }] },
    { label: 'QwenAudio 3.0 Plus（旗舰系统音色）', configuration: qwenAudioPlus,
      voices: [{ id: 'longanlingxin', label: '龙安灵心' }] },
    { label: 'QwenAudio 3.1 Flash（含龙泡泡）', configuration: qwenAudioV31,
      voices: [
        { id: 'longpaopao_v3.1', label: '龙泡泡' },
        { id: 'qiaoxiaojiao_v3.1', label: '乔小娇 · 俏丽可爱' },
        { id: 'yuxiaoyun_v3.1', label: '于小云 · 元气亲切' },
        { id: 'xiaxiaochen_v3.1', label: '夏小晨 · 元气明亮' },
        { id: 'longanhuan_v3.1', label: '龙安欢' },
        { id: 'longanlingxin_v3.1', label: '龙安灵心' },
        { id: 'longanfengyue_v3.1', label: '龙安风悦' },
        { id: 'xunanchuan_v3.1', label: '许南川 · 男' },
        { id: 'anmingyuan_v3.1', label: '安明远 · 男' },
      ] }],
    capabilities: { instructions: true, cloning: false, voice: true, language: false, temperature: false },
    status: 'available',
    note: '官方资料核对：2026-09-11；3.1 音色表逐个实测。系统音色支持中文和英文；三代音色不能混用——3.1 的 id 必须带 _v3.1 后缀，用 3.0 的名字会被服务端拒绝（Engine error [411]）。此接入不提供语言参数、流式播放或声音复刻。北京每万计费字符Flash 1元、Plus 1.4元、3.1 Flash 1元，每段保守预留0.40元，按实际计费字符结算。' });
  const audio = catalog[catalog.length - 1]!;
  for (const choice of audio.choices!) {
    const compatible = registeredVoices.filter(voice => voice.provider === choice.configuration.provider
      && voice.endpoint === choice.configuration.endpoint && voice.targetModel === choice.configuration.model);
    choice.voices = [...(choice.voices ?? []), ...compatible.map(voice => ({ id: voice.voiceId, label: voice.label }))];
  }
  if (registeredVoices.some(voice => voice.endpoint === qwenAudio.endpoint && [qwenAudio.model, qwenAudioPlus.model, qwenAudioV31.model].includes(voice.targetModel))) {
    audio.capabilities.cloning = true;
    audio.note = '已登记的克隆音色与具体模型、服务地址和凭据绑定；保存选择时会核对，不支持任意输入音色ID。系统与克隆音色均可选择。北京每万计费字符Flash 1元、Plus 1.4元，每段预留0.40元，沿原账本按实际用量结算。完整WAV后播放；克隆相似度和听感需实际试听判断。';
  }
  const minimaxChoices: Choice[] = [];
  // Local registrations are exact reviewed pairings, not a claim that the supplier forbids cross-model reuse.
  // I appends the selected voice only after its first formal synthesis succeeds.
  for (const [model, label, characterMicros] of [[MINIMAX_TTS_MODEL, 'MiniMax Turbo', 200], ['MiniMax/speech-2.8-hd', 'MiniMax HD', 350]] as const) {
    const compatible = registeredVoices.filter(voice => voice.provider === 'dashscope' && voice.endpoint === MINIMAX_TTS_ENDPOINT && voice.targetModel === model);
    const configuration: Selection = { adapterId: 'minimax-tts', provider: 'dashscope', endpoint: MINIMAX_TTS_ENDPOINT,
      model, inputTokenLimit: 0, outputTokenLimit: 0, inputMicrosPerToken: 0, outputMicrosPerToken: 0,
      characterMicros, reservationMicros: 2400 * characterMicros, ...(compatible[0]?{voice:compatible[0].voiceId}:{}) };
    minimaxChoices.push({ label, configuration, voices: compatible.map(voice => ({ id: voice.voiceId, label: voice.label })) });
  }
  if (minimaxChoices.length) {
    catalog.push({ id: 'minimax-tts', label: 'MiniMax 语音（百炼托管）', slots: ['tts'], provider: 'dashscope',
      endpoints: [MINIMAX_TTS_ENDPOINT], modelHint: minimaxChoices[0]!.configuration.model,
      models: minimaxChoices.map(choice => choice.configuration.model), choices: minimaxChoices,
      capabilities: { instructions: false, cloning: true, voice: true, language: false, temperature: false }, status: 'available',
      note: '使用已登记的音色，按实际合成字符计费，Turbo每万字符2元，HD每万字符3.5元。不指定情绪参数，由模型根据文本生成语气；完整生成后播放。需要在百炼开通所选模型；保存Key不代表已开通。预设可先查看，完成音色复刻与首次正式启用后才可选择对应已登记音色。' });
  }
  // The operator-defined supplier appears only once one is configured: it is not a reviewed default,
  // so offering an empty shell would invite a selection that cannot work. Its entry mirrors the saved
  // customTts block so the console can display the exact address that will be called.
  if (base.customTts) {
    const custom = validateCustomTts(base.customTts);
    const endpoint = custom.baseUrl + '/audio/speech';
    catalog.push({ id: CUSTOM_TTS_ADAPTER_ID, label: `自定义语音 · ${custom.provider}`, slots: ['tts'],
      provider: custom.provider, endpoints: [endpoint], modelHint: custom.model, models: [custom.model],
      choices: [{ label: `${custom.model}（自定义服务商）`,
        configuration: { adapterId: CUSTOM_TTS_ADAPTER_ID, provider: custom.provider, model: custom.model,
          endpoint, inputTokenLimit: 0, outputTokenLimit: 0, inputMicrosPerToken: 0, outputMicrosPerToken: 0,
          characterMicros: base.models.tts.characterMicros ?? 0, reservationMicros: base.models.tts.reservationMicros,
          voice: custom.voice },
        voices: [{ id: custom.voice, label: custom.voice }] }],
      capabilities: { instructions: false, cloning: false, voice: true, language: false, temperature: false },
      status: 'available',
      note: `请求地址：${endpoint}。这是你自己填写的服务地址，请确认它是你信任的服务商。按你登记的字符费率记账；实际计费由该服务商决定。` });
  }
  return catalog;
}
