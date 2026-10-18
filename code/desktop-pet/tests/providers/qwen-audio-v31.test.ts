// The 3.1 voice family must not be usable by 3.0, and vice versa.
//
// Verified against the live endpoint: a foreign-generation id is answered with
// "[cosyvoice:]Engine error [411]: TTS speak operation failed". That makes the generation a real
// constraint on the id, so it is pinned here — otherwise a future edit that merges the lists would
// only fail at synthesis time, in front of the operator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QWEN_AUDIO_TTS_MODEL, QWEN_AUDIO_TTS_PLUS_MODEL, QWEN_AUDIO_TTS_V31_MODEL,
  QWEN_AUDIO_TTS_VOICES, QWEN_AUDIO_TTS_V31_VOICES, isQwenAudioTtsModel } from '../../providers/qwen-audio-tts.js';
import { managementAdapterCatalog } from '../../providers/management-catalog.js';
import { validateTrialConfiguration } from '../../app/trial-config.js';
import { readFileSync } from 'node:fs';

const real = 'D:/AAAAGENT/windows/.local/model-evaluation/trial/user-trial/config.json';
const base = validateTrialConfiguration(JSON.parse(readFileSync(real, 'utf8')));

/** Mirrors the private supportedVoice(); the module does not export it, so the same rule is restated
 *  here to assert the DATA, which is what an edit would break. */
const accepts = (model: string, voice: string): boolean => model === QWEN_AUDIO_TTS_PLUS_MODEL
  ? voice === 'longanlingxin'
  : model === QWEN_AUDIO_TTS_V31_MODEL ? QWEN_AUDIO_TTS_V31_VOICES.some((v) => v === voice)
    : model === QWEN_AUDIO_TTS_MODEL && QWEN_AUDIO_TTS_VOICES.some((v) => v === voice);

test('the 3.1 model is recognised and its voices carry the _v3.1 suffix', () => {
  assert.ok(isQwenAudioTtsModel(QWEN_AUDIO_TTS_V31_MODEL), '3.1 必须被 isQwenAudioTtsModel 认出来');
  assert.ok(isQwenAudioTtsModel(QWEN_AUDIO_TTS_MODEL));
  assert.ok(isQwenAudioTtsModel(QWEN_AUDIO_TTS_PLUS_MODEL));
  assert.ok(!isQwenAudioTtsModel('qwen-audio-3.2-tts-flash'), '未登记的一代必须被拒');
  for (const voice of QWEN_AUDIO_TTS_V31_VOICES) assert.match(voice, /_v3\.1$/, voice + ' 应带 _v3.1 后缀');
  assert.ok(QWEN_AUDIO_TTS_V31_VOICES.includes('longpaopao_v3.1'), '龙泡泡必须在 3.1 列表里');
  console.log(`  3.1 音色 ${QWEN_AUDIO_TTS_V31_VOICES.length} 个，全部带 _v3.1`);
});

test('voice ids cannot cross model generations', () => {
  // 3.1 ids fail on 3.0 and on Plus; 3.0 ids fail on 3.1.
  for (const voice of QWEN_AUDIO_TTS_V31_VOICES) {
    assert.ok(accepts(QWEN_AUDIO_TTS_V31_MODEL, voice), voice + ' 应被 3.1 接受');
    assert.ok(!accepts(QWEN_AUDIO_TTS_MODEL, voice), voice + ' 不应被 3.0 接受');
    assert.ok(!accepts(QWEN_AUDIO_TTS_PLUS_MODEL, voice), voice + ' 不应被 Plus 接受');
  }
  for (const voice of QWEN_AUDIO_TTS_VOICES) {
    assert.ok(!accepts(QWEN_AUDIO_TTS_V31_MODEL, voice), voice + ' 不应被 3.1 接受');
  }
  assert.ok(!accepts(QWEN_AUDIO_TTS_V31_MODEL, 'longpaopao'), '裸名属于 3.0，必须被 3.1 拒绝');
  console.log('  跨代音色全部被拒');
});

test('the console offers 3.1 with 龙泡泡 and the config accepts its endpoint', () => {
  const entry = managementAdapterCatalog({ ...base, registeredVoices: [] } as never)
    .find((a) => a.id === 'qwen-audio-tts');
  assert.ok(entry, 'QwenAudio 适配器应在目录里');
  assert.ok(entry.models.includes(QWEN_AUDIO_TTS_V31_MODEL), '目录应包含 3.1 型号');
  const choice = entry.choices?.find((c) => c.configuration.model === QWEN_AUDIO_TTS_V31_MODEL);
  assert.ok(choice, '目录应有 3.1 选项');
  assert.ok(choice.voices?.some((v) => v.id === 'longpaopao_v3.1'), '选项里应有龙泡泡');
  assert.equal(choice.configuration.endpoint, 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');

  // And the trial config must accept 3.1 on that endpoint (the isQwenAudioTtsModel branch).
  const tts = { ...base.models.tts, model: QWEN_AUDIO_TTS_V31_MODEL,
    endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer' };
  assert.doesNotThrow(() => validateTrialConfiguration({ ...base, models: { ...base.models, tts } }));
  assert.throws(() => validateTrialConfiguration({ ...base,
    models: { ...base.models, tts: { ...tts, endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' } } }),
    '3.1 用了文本端点必须被拒');
  console.log(`  目录选项: ${choice.label}，音色数 ${choice.voices?.length}`);
});
