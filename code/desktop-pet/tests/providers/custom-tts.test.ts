// Prove the custom-TTS path actually works end to end at the logic level, and that the address policy
// still refuses what it should.
//
// Types compiling is not evidence: the whole point of this feature is that a supplier NOT in the
// reviewed catalogue can be selected, so the checks that used to reject it are exactly what needs
// exercising.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCustomTts } from '../../providers/local-speech.js';
import { managementAdapterCatalog, CUSTOM_TTS_ADAPTER_ID } from '../../providers/management-catalog.js';
import { validateManagedSettings, defaultManagedSettings } from '../../management/settings.js';
import { validateTrialConfiguration } from '../../app/trial-config.js';
import { credentialRegistry } from '../../management/credentials.js';

const real = 'D:/AAAAGENT/windows/.local/model-evaluation/trial/user-trial/config.json';
const base = validateTrialConfiguration(JSON.parse(readFileSync(real, 'utf8')));

test('an operator-defined OpenAI endpoint is accepted, and the selectable entry mirrors it', () => {
  const customTts = { baseUrl: 'https://speech.example.com/v1', model: 'my-tts-1', voice: 'xiaorou',
    provider: 'myprovider', credentialRef: 'myprovider-0123456789ab' };
  const validated = validateCustomTts(customTts);
  assert.equal(validated.baseUrl, 'https://speech.example.com/v1');

  const withCustom = { ...base, customTts: validated };
  const entry = managementAdapterCatalog(withCustom).find(a => a.id === CUSTOM_TTS_ADAPTER_ID);
  assert.ok(entry, '自定义服务商应出现在目录里，否则控制台无法选择');
  assert.equal(entry.endpoints[0], 'https://speech.example.com/v1/audio/speech');
  assert.deepEqual(entry.models, ['my-tts-1']);
  assert.equal(entry.choices?.[0]?.voices?.[0]?.id, 'xiaorou');
  console.log(`  目录条目: ${entry.label} → ${entry.endpoints[0]}`);
});

test('the address policy refuses what could aim a key at an unintended host', () => {
  const good = { baseUrl: 'https://a.example.com/v1', model: 'm', voice: 'v', provider: 'p1', credentialRef: 'r' };
  // Each case is a way the key could end up somewhere the operator did not intend, or could be read
  // off the wire. Non-loopback http is refused because the API key travels with the request.
  const bad: [string, Record<string, string>][] = [
    ['非 http(s) 协议', { ...good, baseUrl: 'ftp://a.example.com/v1' }],
    ['非本机明文 http（Key 会在网络中可见）', { ...good, baseUrl: 'http://speech.example.com/v1' }],
    ['内网明文 http', { ...good, baseUrl: 'http://192.168.1.1/v1' }],
    ['内嵌用户名密码', { ...good, baseUrl: 'https://u:p@a.example.com/v1' }],
    ['带查询串', { ...good, baseUrl: 'https://a.example.com/v1?token=x' }],
    ['带锚点', { ...good, baseUrl: 'https://a.example.com/v1#x' }],
    ['路径不是 /v1', { ...good, baseUrl: 'https://a.example.com/api' }],
    ['服务商名非法', { ...good, provider: 'My Provider' }],
    ['缺模型', { ...good, model: '' }],
    ['缺音色', { ...good, voice: '' }],
    ['缺凭据引用', { ...good, credentialRef: '' }],
  ];
  for (const [label, value] of bad) assert.throws(() => validateCustomTts(value), label);
  // Loopback http stays allowed: that is what a self-hosted server on this machine needs.
  assert.doesNotThrow(() => validateCustomTts({ ...good, baseUrl: 'http://127.0.0.1:19380/v1' }));
  console.log(`  拒绝了 ${bad.length} 种危险形态，本机回环 http 仍可用`);
});

test('managed settings accept a custom TTS selection that is absent from the reviewed catalogue', () => {
  const customTts = { baseUrl: 'https://speech.example.com/v1', model: 'my-tts-1', voice: 'xiaorou',
    provider: 'myprovider', credentialRef: 'myprovider-0123456789ab' };
  const endpoint = 'https://speech.example.com/v1/audio/speech';
  // `withCustom` still carries the reviewed tts block (dashscope), so every assertion below builds the
  // tts model explicitly; otherwise the mismatch reported is the fixture's, not the feature's.
  const ttsModel = { ...base.models.tts, provider: 'myprovider', model: 'my-tts-1', endpoint,
    characterMicros: base.models.tts.characterMicros ?? 100 };
  const withCustom = validateTrialConfiguration({ ...base, customTts,
    models: { ...base.models, tts: ttsModel } });

  // The trial config must accept the operator's own address for tts, and reject a mismatch.
  assert.doesNotThrow(() => validateTrialConfiguration({ ...withCustom, customTts }));
  assert.throws(() => validateTrialConfiguration({ ...withCustom, customTts,
    models: { ...withCustom.models, tts: { ...ttsModel, endpoint: 'https://evil.example.com/v1/audio/speech' } } }),
    '地址与语音设置不一致时必须拒绝');

  // And the console validator must accept the matching selection for the custom adapter.
  //
  // Built from defaultManagedSettings rather than hand-assembled: the settings allow-list is exact, and
  // a hand-built payload failed on its own shape (missing/extra keys) instead of on the feature. Taking
  // the accepted baseline means any failure below is caused by the custom selection.
  const settings = defaultManagedSettings(withCustom);
  const adapter = managementAdapterCatalog(withCustom).find(a => a.id === CUSTOM_TTS_ADAPTER_ID)!;
  const consoleSettings = structuredClone(settings);
  consoleSettings.providers.tts = { ...adapter.choices![0]!.configuration,
    credentialRef: customTts.credentialRef, voice: customTts.voice };
  // Credentials are resolved directly so the test does not depend on a saved key existing on this
  // machine. The override must accept the custom supplier, because the whole point is that a supplier
  // outside the reviewed list can be selected once its key is stored; the real store does exactly that
  // through isCredentialProvider.
  const credentials = { ...credentialRegistry(withCustom),
    file: (_ref: string, provider: string) => `/synthetic/${provider}.key` } as never;
  const applied = validateManagedSettings(consoleSettings, withCustom, undefined, false, credentials, true);
  assert.equal(applied.providers.tts.adapterId, CUSTOM_TTS_ADAPTER_ID);
  console.log(`  控制台校验通过: ${applied.providers.tts.provider} → ${applied.providers.tts.endpoint}`);

  // A voice that does not match the saved block must be refused.
  assert.throws(() => validateManagedSettings({ ...consoleSettings,
    providers: { ...consoleSettings.providers, tts: { ...consoleSettings.providers.tts, voice: 'someone-else' } } },
    withCustom, undefined, false, credentials, true), '音色与已保存设置不一致时必须拒绝');
});
