import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createGateway } from '../src/server.mjs';
import { validateConfig } from '../src/config.mjs';
import { pcmWave } from '../src/audio.mjs';
import { SerialQueue, gptSessionKey } from '../src/providers.mjs';

async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const config = providers => validateConfig({ version: 1, host: '127.0.0.1', port: 0, timeoutMs: 5000, providers });
const provider = (baseUrl, protocol = 'openai', models = { chat: { 'local-chat': 'actual-model' } }) => ({ enabled: true, baseUrl, protocol, models });
const post = (base, path, body, options = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...options.headers }, body: JSON.stringify(body), signal: options.signal });
async function requestBody(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
function wav() {
  const out = Buffer.alloc(364);
  out.write('RIFF'); out.writeUInt32LE(356, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(320, 40);
  return out;
}

test('local HTTP is allowed; remote access requires explicit HTTPS; duplicate models fail', () => {
  assert.equal(config({ a: provider('http://127.0.0.1:8080/v1') }).routes.length, 1);
  assert.throws(() => config({ a: provider('http://example.com/v1') }), /remote providers/);
  assert.throws(() => config({ a: { ...provider('https://example.com/v1'), allowRemote: true, baseUrl: 'https://key@example.com/v1' } }), /baseUrl/);
  assert.throws(() => config({ a: provider('http://localhost:8080/v1'), b: provider('http://localhost:8081/v1') }), /Duplicate/);
});

test('catalog lists enabled models without probing backends; unknown model has no fallback', async t => {
  let calls = 0;
  const backend = await listen(http.createServer((req, res) => { calls++; res.end('{}'); }), t);
  const gateway = await listen(createGateway(config({ a: provider(backend), disabled: { ...provider(backend), enabled: false } })), t);
  const models = await (await fetch(`${gateway}/v1/models`)).json();
  assert.deepEqual(models.data.map(model => model.id), ['local-chat']);
  const rejected = await post(gateway, '/v1/chat/completions', { model: 'missing', messages: [{ role: 'user', content: 'test' }] });
  assert.equal(rejected.status, 404);
  assert.equal(calls, 0);
});

test('OpenAI chat preserves tools, image messages and complete SSE with model alias mapping', async t => {
  let received;
  const sse = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"x\\\":1}"}}]}}]}\n\ndata: [DONE]\n\n';
  const backend = await listen(http.createServer(async (req, res) => {
    received = { path: req.url, authorization: req.headers.authorization, body: JSON.parse((await requestBody(req)).toString()) };
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse.slice(0, 19)); setTimeout(() => res.end(sse.slice(19)), 5);
  }), t);
  const gateway = await listen(createGateway(config({ a: provider(`${backend}/v1`) })), t);
  const request = { model: 'local-chat', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,eA==' } }] }], tools: [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }] };
  const response = await post(gateway, '/v1/chat/completions', request, { headers: { authorization: 'Bearer client-placeholder' } });
  assert.equal(await response.text(), sse);
  assert.equal(received.path, '/v1/chat/completions');
  assert.equal(received.authorization, undefined);
  assert.deepEqual(received.body, { ...request, model: 'actual-model' });
});

test('Ollama accepts both native NDJSON and OpenAI routes', async t => {
  const paths = [];
  const backend = await listen(http.createServer(async (req, res) => {
    paths.push(req.url);
    const body = JSON.parse((await requestBody(req)).toString());
    assert.equal(body.model, 'qwen3.5:2b');
    res.setHeader('content-type', 'application/x-ndjson'); res.end('{"message":{"content":"你好"},"done":true}\n');
  }), t);
  const gateway = await listen(createGateway(config({ ollama: provider(backend, 'ollama', { chat: { small: 'qwen3.5:2b' } }) })), t);
  for (const path of ['/api/chat', '/v1/chat/completions']) {
    const response = await post(gateway, path, { model: 'small', messages: [{ role: 'user', content: '你好' }], stream: true });
    assert.match(await response.text(), /你好/);
  }
  assert.deepEqual(paths, ['/api/chat', '/v1/chat/completions']);
});

test('multipart ASR forwards original audio bytes, fields and upstream model', async t => {
  const original = wav();
  let parsed;
  const backend = await listen(http.createServer(async (req, res) => {
    assert.equal(req.url, '/v1/audio/transcriptions');
    const bytes = await requestBody(req);
    parsed = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: bytes }).formData();
    res.setHeader('content-type', 'text/plain'); res.end('测试语音');
  }), t);
  const gateway = await listen(createGateway(config({ asr: provider(`${backend}/v1`, 'openai', { asr: { 'whisper-small': 'small' } }) })), t);
  const form = new FormData();
  form.set('model', 'whisper-small'); form.set('language', 'zh'); form.set('response_format', 'text'); form.set('file', new Blob([original], { type: 'audio/wav' }), 'audio.wav');
  const response = await fetch(`${gateway}/v1/audio/transcriptions`, { method: 'POST', body: form });
  assert.equal(await response.text(), '测试语音');
  assert.equal(parsed.get('model'), 'small'); assert.equal(parsed.get('language'), 'zh');
  assert.deepEqual(Buffer.from(await parsed.get('file').arrayBuffer()), original);
});

test('SenseVoice validates WAV before native loading, including malformed lengths and unsupported channels', async t => {
  assert.equal(pcmWave(wav()).samples.length, 160);
  const broken = wav(); broken.writeUInt32LE(999999, 40);
  assert.throws(() => pcmWave(broken), /Truncated/);
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  assert.throws(() => pcmWave(stereo), /mono/);
  const gateway = await listen(createGateway(config({ asr: { enabled: true, protocol: 'sensevoice', modelPath: 'absent.onnx', tokensPath: 'absent.txt', models: { asr: ['sensevoice-small'] } } })), t);
  const form = new FormData(); form.set('model', 'sensevoice-small'); form.set('file', new Blob(['not wav']), 'test.mp3');
  const response = await fetch(`${gateway}/v1/audio/transcriptions`, { method: 'POST', body: form });
  assert.equal(response.status, 400); assert.match((await response.json()).error.message, /PCM16/);
});

test('GPT-SoVITS maps the reference and serializes complete weight-selection/synthesis transactions', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'aaaagent-local-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of ['ref.wav', 'a.ckpt', 'a.pth', 'b.ckpt', 'b.pth']) await writeFile(resolve(directory, file), file === 'ref.wav' ? wav() : 'weights-fixture');
  let selected, active = 0, peak = 0;
  const history = [];
  const backend = await listen(http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    history.push(url.pathname);
    if (url.pathname === '/set_gpt_weights') selected = url.searchParams.get('weights_path');
    if (url.pathname !== '/tts') return res.end('{"message":"success"}');
    const request = JSON.parse((await requestBody(req)).toString());
    assert.equal(request.ref_audio_path, resolve(directory, 'ref.wav')); assert.equal(request.streaming_mode, false); assert.equal(request.media_type, 'wav');
    assert.equal(selected, resolve(directory, `${request.text}.ckpt`));
    active++; peak = Math.max(peak, active);
    setTimeout(() => { active--; res.setHeader('content-type', 'audio/wav'); res.end(wav()); }, 20);
  }), t);
  const voice = letter => ({ refAudioPath: resolve(directory, 'ref.wav'), promptText: '参考语音', promptLanguage: 'zh', textLanguage: 'zh', gptWeightsPath: resolve(directory, `${letter}.ckpt`), sovitsWeightsPath: resolve(directory, `${letter}.pth`) });
  const gateway = await listen(createGateway(config({ gpt: { ...provider(backend, 'gpt-sovits', { tts: ['gpt-sovits'] }), voices: { a: voice('a'), b: voice('b') } } })), t);
  const responses = await Promise.all(['a', 'b'].map(letter => post(gateway, '/v1/audio/speech', { model: 'gpt-sovits', voice: letter, input: letter, response_format: 'wav' })));
  for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav()); }
  assert.equal(peak, 1);
  assert.deepEqual(history, ['/set_gpt_weights', '/set_sovits_weights', '/tts', '/set_gpt_weights', '/set_sovits_weights', '/tts']);
});

test('MiniMax native TTS decodes binary audio; HTTP-200 provider errors remain failures; keys stay upstream', async t => {
  const keyName = 'AAAAGENT_TEST_MINIMAX_KEY';
  process.env[keyName] = 'test.key.with.periods'; t.after(() => { delete process.env[keyName]; });
  let failed = false, calls = 0;
  const backend = await listen(http.createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/v1/t2a_v2'); assert.equal(req.headers.authorization, 'Bearer test.key.with.periods');
    const request = JSON.parse((await requestBody(req)).toString());
    assert.equal(request.voice_setting.voice_id, 'authorized-voice'); assert.equal(request.output_format, 'hex'); assert.equal(request.stream, false);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(failed ? { base_resp: { status_code: 1004, status_msg: 'private provider error' } } : { base_resp: { status_code: 0 }, data: { audio: wav().toString('hex') } }));
  }), t);
  const gateway = await listen(createGateway(config({ mini: { ...provider(`${backend}/v1`, 'minimax-speech', { tts: ['speech-2.8-turbo'] }), apiKeyEnv: keyName } })), t);
  const request = { model: 'speech-2.8-turbo', voice: 'authorized-voice', input: '测试', response_format: 'wav' };
  const response = await post(gateway, '/v1/audio/speech', request);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav());
  failed = true;
  const rejected = await post(gateway, '/v1/audio/speech', request);
  assert.equal(rejected.status, 502); assert.match((await rejected.json()).error.message, /1004/);
  delete process.env[keyName];
  const missing = await post(gateway, '/v1/audio/speech', request);
  assert.equal(missing.status, 503); assert.equal(calls, 2);
});

test('upstream errors do not expose provider response bodies or automatically retry', async t => {
  let calls = 0;
  const backend = await listen(http.createServer((req, res) => { calls++; res.writeHead(401); res.end('SECRET private prompt'); }), t);
  const gateway = await listen(createGateway(config({ a: provider(`${backend}/v1`) })), t);
  const response = await post(gateway, '/v1/chat/completions', { model: 'local-chat', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /SECRET/); assert.equal(calls, 1);
});

test('cross-origin browser calls, invalid bodies and oversized input are rejected', async t => {
  const source = config({ a: provider('http://127.0.0.1:1/v1') }); source.maxBodyBytes = 256;
  const gateway = await listen(createGateway(source), t);
  assert.equal((await post(gateway, '/v1/chat/completions', {}, { headers: { origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await post(gateway, '/v1/chat/completions', ['invalid'])).status, 400);
  assert.equal((await post(gateway, '/v1/chat/completions', { messages: ['x'.repeat(1024)] })).status, 413);
});

test('client cancellation closes an upstream stream without a retry', async t => {
  let calls = 0, upstreamClosed;
  const closed = new Promise(done => { upstreamClosed = done; });
  const backend = await listen(http.createServer((req, res) => {
    calls++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[]}\n\n'); res.on('close', upstreamClosed);
  }), t);
  const gateway = await listen(createGateway(config({ a: provider(`${backend}/v1`) })), t);
  const controller = new AbortController();
  const response = await post(gateway, '/v1/chat/completions', { model: 'local-chat', stream: true, messages: [{ role: 'user', content: 'hello' }] }, { signal: controller.signal });
  const reader = response.body.getReader(); await reader.read(); controller.abort();
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream did not close')), 2000); timer.unref(); })]);
  assert.equal(calls, 1);
});

test('cancelled queue waiters reject immediately without letting later jobs overtake active work', async () => {
  const queue = new SerialQueue();
  let release;
  const order = [];
  const first = queue.run('native', new AbortController().signal, () => new Promise(done => { release = () => { order.push('first'); done(); }; }));
  await new Promise(done => setImmediate(done));
  const controller = new AbortController();
  const second = queue.run('native', controller.signal, () => { order.push('cancelled-action'); });
  const third = queue.run('native', new AbortController().signal, () => { order.push('third'); });
  const rejected = assert.rejects(second, /cancelled/);
  controller.abort(new Error('cancelled'));
  await rejected;
  assert.deepEqual(order, []);
  release(); await Promise.all([first, third]); assert.deepEqual(order, ['first', 'third']);
});

test('GPT loopback aliases share a lock; mixed or incomplete voice weight pairs are refused', () => {
  assert.equal(gptSessionKey({ baseUrl: 'http://127.0.0.1:9880' }), gptSessionKey({ baseUrl: 'http://localhost:9880' }));
  const gpt = provider('http://127.0.0.1:9880', 'gpt-sovits', { tts: ['gpt-sovits'] });
  assert.throws(() => config({ gpt: { ...gpt, voices: { a: { gptWeightsPath: 'a.ckpt' } } } }), /both weights/);
  assert.throws(() => config({ gpt: { ...gpt, voices: { a: { gptWeightsPath: 'a.ckpt', sovitsWeightsPath: 'a.pth' }, b: {} } } }), /every voice/);
});

test('cancelling GPT playback keeps the backend transaction locked until synthesis completes', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'aaaagent-local-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(resolve(directory, 'ref.wav'), wav());
  let startFirst;
  const started = new Promise(done => { startFirst = done; });
  let firstRes, count = 0;
  const backend = await listen(http.createServer(async (req, res) => {
    await requestBody(req); count++;
    res.setHeader('content-type', 'audio/wav');
    if (count === 1) { firstRes = res; startFirst(); }
    else res.end(wav());
  }), t);
  const gateway = await listen(createGateway(config({ gpt: { ...provider(backend, 'gpt-sovits', { tts: ['gpt-sovits'] }), voices: { pet: { refAudioPath: resolve(directory, 'ref.wav'), promptText: '参考', promptLanguage: 'zh', textLanguage: 'zh' } } } })), t);
  const request = { model: 'gpt-sovits', voice: 'pet', input: 'test', response_format: 'wav' };
  const controller = new AbortController();
  const first = post(gateway, '/v1/audio/speech', request, { signal: controller.signal });
  const rejected = assert.rejects(first, /abort/i);
  await started; controller.abort(); await rejected;
  const next = post(gateway, '/v1/audio/speech', request);
  await new Promise(done => setTimeout(done, 30)); assert.equal(count, 1);
  firstRes.end(wav());
  const response = await next; assert.equal(response.status, 200); await response.arrayBuffer(); assert.equal(count, 2);
});

test('GPT PCM is refused before any synthesis because the raw sample rate is not OpenAI compatible', async t => {
  let count = 0;
  const backend = await listen(http.createServer((req, res) => { count++; res.end(); }), t);
  const gateway = await listen(createGateway(config({ gpt: { ...provider(backend, 'gpt-sovits', { tts: ['gpt-sovits'] }), voices: { pet: { refAudioPath: 'not-read.wav', promptLanguage: 'zh', textLanguage: 'zh' } } } })), t);
  const response = await post(gateway, '/v1/audio/speech', { model: 'gpt-sovits', voice: 'pet', input: 'test', response_format: 'pcm' });
  assert.equal(response.status, 400); assert.equal(count, 0);
});

test('a hard GPT backend timeout blocks subsequent synthesis until the service is restarted', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'aaaagent-local-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(resolve(directory, 'ref.wav'), wav());
  let count = 0;
  const backend = await listen(http.createServer(async req => { count++; await requestBody(req); }), t);
  const source = config({ gpt: { ...provider(backend, 'gpt-sovits', { tts: ['gpt-sovits'] }), voices: { pet: { refAudioPath: resolve(directory, 'ref.wav'), promptLanguage: 'zh', textLanguage: 'zh' } } } });
  source.timeoutMs = 80;
  const gateway = await listen(createGateway(source), t);
  const request = { model: 'gpt-sovits', voice: 'pet', input: 'test', response_format: 'wav' };
  const timedOut = await post(gateway, '/v1/audio/speech', request); assert.equal(timedOut.status, 504); await timedOut.text();
  const blocked = await post(gateway, '/v1/audio/speech', request); assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).error.code, 'backend_state_unknown'); assert.equal(count, 1);
});
