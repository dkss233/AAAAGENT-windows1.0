import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pcmWave } from '../src/audio.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const data = fileURLToPath(new URL('../../.local/local-models/', import.meta.url));
const base = option('--url', 'http://127.0.0.1:19380').replace(/\/$/, '');
const model = option('--chat-model', undefined);
const sample = option('--audio', resolve(data, 'models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav'));
const report = { platform: process.platform, arch: process.arch, node: process.version, at: new Date().toISOString(), checks: [] };
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
async function checkResponse(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response;
}
async function timed(name, action) {
  const begin = performance.now();
  const result = await action();
  report.checks.push({ name, ms: Math.round(performance.now() - begin), ...result });
}
async function transcribe(bytes) {
  const form = new FormData();
  form.set('model', 'sensevoice-small'); form.set('language', 'zh'); form.set('response_format', 'verbose_json');
  form.set('file', new Blob([bytes], { type: 'audio/wav' }), 'speech.wav');
  const response = await checkResponse(await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) }));
  const result = await response.json(); assert.ok(result.text.trim(), 'ASR returned empty text'); return result;
}

if (model) await timed('openai-chat', async () => {
  const response = await checkResponse(await post('/v1/chat/completions', { model, stream: false, reasoning_effort: 'none', max_tokens: 128, messages: [{ role: 'user', content: '只用中文回复：本地接口已经接通。' }] }));
  const result = await response.json(); const text = result.choices?.[0]?.message?.content;
  assert.ok(text?.trim(), 'OpenAI chat returned empty content'); return { model, text, usage: result.usage };
});
if (model) await timed('openai-chat-stream', async () => {
  const response = await checkResponse(await post('/v1/chat/completions', { model, stream: true, reasoning_effort: 'none', max_tokens: 128, messages: [{ role: 'user', content: '只回复：你好。' }] }));
  const sse = await response.text(); assert.match(sse, /data: \[DONE\]/);
  const text = sse.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '').join('');
  assert.ok(text.trim(), 'Streaming chat returned empty content'); return { model, text };
});
if (model && args.includes('--ollama-native')) await timed('ollama-native-chat', async () => {
  const response = await checkResponse(await post('/api/chat', { model, think: false, stream: false, options: { num_predict: 128 }, messages: [{ role: 'user', content: '只回复：本地模型正常。' }] }));
  const result = await response.json(); assert.ok(result.message?.content?.trim()); assert.equal(result.done, true);
  return { model, text: result.message.content };
});
await timed('sensevoice-official-sample', async () => transcribe(await readFile(sample)));
const ttsModel = option('--tts-model', undefined);
if (ttsModel) {
  const output = resolve(option('--output', resolve(data, 'samples/kokoro-smoke.wav')));
  let audio;
  await timed('tts-wav', async () => {
    const response = await checkResponse(await post('/v1/audio/speech', { model: ttsModel, input: '你好，今天我们一起测试本地语音。', voice: option('--voice', '3'), response_format: 'wav' }));
    audio = Buffer.from(await response.arrayBuffer());
    const parsed = pcmWave(audio); assert.ok(parsed.samples.some(value => value !== 0), 'TTS output is silent');
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, audio);
    return { model: ttsModel, bytes: audio.length, sampleRate: parsed.sampleRate, seconds: Number((parsed.samples.length / parsed.sampleRate).toFixed(2)), output };
  });
  await timed('tts-to-asr-roundtrip', async () => transcribe(audio));
}
const reportPath = resolve(data, 'validation.json');
await mkdir(data, { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
console.log(`Saved ${reportPath}`);
