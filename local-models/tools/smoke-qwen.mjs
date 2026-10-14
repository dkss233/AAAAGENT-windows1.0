import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pcmWave } from '../src/audio.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const data = resolve(option('--data-dir', fileURLToPath(new URL('../../.local/local-models/', import.meta.url))));
const base = option('--url', 'http://127.0.0.1:8093').replace(/\/$/, '');
const asrBase = option('--asr-url', 'http://127.0.0.1:19380').replace(/\/$/, '');
const metadataBase = option('--service-url', 'http://127.0.0.1:8093').replace(/\/$/, '');
const model = option('--model', 'Qwen/Qwen3-TTS-12Hz-0.6B-Base');
const texts = args.reduce((values, value, index) => value === '--text' ? [...values, args[index + 1]] : values, []);
if (!texts.length) texts.push('你好，今天我们一起测试本地语音。');
const normalize = text => text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
const report = { at: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, model, voice: 'pet-reference', ttsUrl: base, asrUrl: asrBase, checks: [] };
async function checked(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response;
}
await mkdir(resolve(data, 'samples'), { recursive: true });
try {
  report.service = await (await checked(await fetch(`${metadataBase}/health`, { signal: AbortSignal.timeout(5000) }))).json();
  assert.equal(report.service.ready, true, 'Qwen service must have loaded the real model and reference prompt');
  const models = await (await checked(await fetch(`${metadataBase}/v1/models`, { signal: AbortSignal.timeout(5000) }))).json();
  assert.ok(models.data.some(entry => entry.id === 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'));
  for (let index = 0; index < texts.length; index++) {
    const input = texts[index];
    const started = performance.now();
    const response = await checked(await fetch(`${base}/v1/audio/speech`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input, voice: 'pet-reference', response_format: 'wav', speed: 1 }),
      signal: AbortSignal.timeout(180000),
    }));
    const bytes = Buffer.from(await response.arrayBuffer());
    const parsed = pcmWave(bytes);
    assert.ok(parsed.samples.length && parsed.samples.some(value => value !== 0), 'Qwen generated a silent WAV');
    const rms = Math.sqrt(parsed.samples.reduce((sum, value) => sum + value * value, 0) / parsed.samples.length);
    const output = resolve(data, `samples/qwen-smoke-${index + 1}.wav`);
    await writeFile(output, bytes);
    const item = { name: 'qwen-chinese-wav-to-sensevoice', input, bytes: bytes.length, sampleRate: parsed.sampleRate, seconds: Number((parsed.samples.length / parsed.sampleRate).toFixed(3)), rms, synthesisMs: Math.round(performance.now() - started), backendSynthesisMs: Number(response.headers.get('x-synthesis-ms')) || undefined, output };
    report.checks.push(item);
    const asrStarted = performance.now();
    const form = new FormData();
    form.set('model', 'sensevoice-small');
    form.set('language', 'zh');
    form.set('response_format', 'verbose_json');
    form.set('file', new Blob([bytes], { type: 'audio/wav' }), 'qwen.wav');
    const transcript = await (await checked(await fetch(`${asrBase}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) }))).json();
    item.asr = transcript;
    item.asrMs = Math.round(performance.now() - asrStarted);
    item.matchesIgnoringPunctuation = normalize(transcript.text) === normalize(input);
    assert.equal(item.matchesIgnoringPunctuation, true, `Generated speech transcription differs: ${transcript.text}`);
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  throw error;
} finally {
  const destination = resolve(data, option('--report', 'qwen-validation.json'));
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Saved ${destination}`);
}
