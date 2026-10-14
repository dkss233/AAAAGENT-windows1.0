// Exercise the actual local service, including a client disconnect during GPU
// inference. Run while Qwen is idle; no mocked engine or remote request is used.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const base = option('--url', 'http://127.0.0.1:8093').replace(/\/$/, '');
const data = resolve(option('--data-dir', fileURLToPath(new URL('../../.local/local-models/', import.meta.url))));
const valid = { model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base', input: '你好，今天我们一起测试本地语音。', voice: 'pet-reference', response_format: 'wav', speed: 1 };
const report = { at: new Date().toISOString(), url: base, checks: [] };
const speech = (body, signal = AbortSignal.timeout(15000)) => fetch(`${base}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
const health = async () => (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })).json();
try {
  assert.equal((await health()).busy, false, 'Run protocol tests while Qwen is idle');
  for (const [name, fields] of [
    ['unloaded model', { model: 'another-model' }],
    ['unknown voice', { voice: 'another-voice' }],
    ['client audio file path', { ref_audio: 'C:/Windows/win.ini' }],
    ['client audio URL', { ref_audio: 'https://example.com/voice.wav' }],
    ['client weight path', { weights: 'C:/Windows/win.ini' }],
    ['stream request', { stream: true }],
    ['MP3 format', { response_format: 'mp3' }],
    ['unsupported speed', { speed: 2 }],
    ['whitespace input', { input: '   ' }],
    ['overlong input', { input: '测'.repeat(301) }],
  ]) {
    const started = performance.now();
    const response = await speech({ ...valid, ...fields });
    assert.equal(response.status, 400, `${name} must be rejected before inference`);
    const error = await response.json();
    assert.ok(error.error.message);
    report.checks.push({ name, status: response.status, ms: Math.round(performance.now() - started) });
  }
  const controller = new AbortController();
  const started = performance.now();
  const running = speech(valid, controller.signal).then(value => value, error => error);
  let busy = false;
  for (let index = 0; index < 100; index++) {
    busy = (await health()).busy;
    if (busy) break;
    await delay(50);
  }
  assert.equal(busy, true, 'Actual GPU generation must start before disconnecting');
  controller.abort();
  const aborted = await running;
  assert.equal(aborted.name, 'AbortError', 'The client should stop waiting immediately');
  const stillBusy = (await health()).busy;
  assert.equal(stillBusy, true, 'Client cancellation must not release the native inference lock');
  const overlap = await speech(valid);
  assert.equal(overlap.status, 503, 'A new request must not overlap the cancelled client generation');
  await overlap.json();
  for (let index = 0; index < 600; index++) {
    if (!(await health()).busy) { busy = false; break; }
    await delay(100);
  }
  assert.equal(busy, false, 'The lock must release once actual generation finishes');
  report.checks.push({ name: 'client cancellation retains GPU inference lock until completion', busyAfterClientAbort: stillBusy, overlappingStatus: overlap.status, completedMs: Math.round(performance.now() - started) });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  throw error;
} finally {
  const destination = resolve(data, 'qwen-protocol-validation.json');
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Saved ${destination}`);
}
