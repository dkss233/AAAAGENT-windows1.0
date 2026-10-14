import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAsrProvider, LocalTtsProvider, validateLocalSpeech } from '../../providers/local-speech.js';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav, inspectPcmWav } from '../../media/wav.js';
const scope = { characterId: 'friend', sessionId: 'local-test', turnId: 't', generation: 0 };
const expression = { emotion: 'neutral', intensity: 0.4, delivery: '', gesture: null };
const config = { baseUrl: 'http://127.0.0.1:19380/v1', asr: { model: 'sensevoice-small' }, tts: { model: 'kokoro-82m', voice: '3' } };
const wav = () => pcm16Wav(Float32Array.from([0, 0.2, -0.2]), 24000);

test('local speech configuration rejects remote URLs, URL credentials and unknown models', () => {
  for (const baseUrl of ['https://remote.test/v1', 'http://localhost:19380/v1', 'http://127.0.0.1:19380/v1?key=x', 'http://user:pw@127.0.0.1:19380/v1', 'http://127.0.0.1:19380/other'])
    assert.throws(() => validateLocalSpeech({ ...config, baseUrl }));
  assert.throws(() => validateLocalSpeech({ ...config, tts: { model: 'unknown', voice: '3' } }));
  assert.equal(validateLocalSpeech(config).baseUrl, config.baseUrl);
});
test('desktop ASR sends scoped WAV through multipart without cloud credentials', async () => {
  const store = new MemoryMediaStore(), audio = await store.put(scope, wav(), 'audio/wav');
  const provider = new LocalAsrProvider(config, store, async (url, init) => {
    assert.equal(url, config.baseUrl + '/audio/transcriptions'); assert.equal(init?.redirect, 'error');
    assert.equal(init?.headers, undefined); assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get('model'), 'sensevoice-small'); assert.ok(init.body.get('file') instanceof Blob);
    return Response.json({ text: '你好，世界。', language: 'zh' });
  });
  assert.equal((await provider.transcribe({ scope, audio }, new AbortController().signal)).transcript, '你好，世界。');
  await assert.rejects(provider.transcribe({ scope: { ...scope, turnId: 'other' }, audio }, new AbortController().signal));
});
test('desktop TTS splits long replies sequentially and uses configured local voice', async () => {
  const store = new MemoryMediaStore(); let calls = 0; const texts: string[] = [];
  const provider = new LocalTtsProvider(config, store, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls++; texts.push(body.input);
    assert.equal(body.voice, '3'); assert.equal(body.response_format, 'wav');
    return new Response(wav().slice().buffer);
  });
  const text = '你好'.repeat(200), result = await provider.synthesize({ scope, text, expression, voiceId: 'cloud-only' }, new AbortController().signal);
  assert.equal(calls, 2); assert.equal(texts.join(''), text);
  assert.equal(inspectPcmWav(await store.read(scope, result.audio)).data.length, 12);
  assert.equal(result.synchronization, 'amplitude');
});
test('provider failure and cancellation do not produce audio or fall back', async () => {
  const store = new MemoryMediaStore(); let calls = 0;
  const provider = new LocalTtsProvider(config, store, async () => { calls++; return new Response('failure', { status: 503 }); });
  await assert.rejects(provider.synthesize({ scope, text: '你好', expression }, new AbortController().signal), /503/);
  assert.equal(calls, 1); assert.equal(store.count, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.synthesize({ scope, text: '你好', expression }, controller.signal));
  assert.equal(calls, 1);
});
test('Whisper refuses an overlong recording before submitting a truncated request', async () => {
  const store = new MemoryMediaStore(), audio = await store.put(scope, pcm16Wav(new Float32Array(30 * 8000), 8000), 'audio/wav');
  const provider = new LocalAsrProvider({ ...config, asr: { model: 'whisper-small' } }, store, async () => { throw Error('must not send'); });
  await assert.rejects(provider.transcribe({ scope, audio }, new AbortController().signal), /29/);
});
