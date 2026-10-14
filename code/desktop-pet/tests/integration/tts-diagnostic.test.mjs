import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'; import { resolve } from 'node:path';
import { capturedFetch, safeFailure } from '../../tools/tts-diagnostic.mjs';
import { pcm16Wav } from '../../dist/media/wav.js';
for (const kind of ['valid', 'non_wav', 'wrong_rate']) test(`diagnostic retains ${kind} public bytes without the signed URL`, async t => {
  const parent = resolve('../../artifacts/W0-I/speech-control-02/tmp'); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(parent + '/diagnostic-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = kind === 'non_wav' ? Buffer.from('synthetic-not-wave') : pcm16Wav(new Float32Array(8), kind === 'wrong_rate' ? 22050 : 24000);
  const trace = {}, wrapped = capturedFetch(dir, trace, async () => new Response(bytes));
  const response = await wrapped('https://synthetic.invalid/a?Signature=SECRET');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(bytes));
  assert.deepEqual(new Uint8Array(await readFile(resolve(dir, 'provider-original.bin'))), new Uint8Array(bytes));
  assert.doesNotMatch(JSON.stringify(trace), /Signature|SECRET|https:/);
  if (kind === 'non_wav') assert.equal(trace.download.wavError.localMessage, 'Expected WAV audio');
  else assert.equal(trace.download.wav.sampleRate, kind === 'wrong_rate' ? 22050 : 24000);
  assert.equal(trace.stage, 'provider_audio_validation');
});
test('safe network diagnostics retain error code but redact arbitrary messages and URL', async () => {
  const trace = {}, error = new TypeError('fetch failed https://secret.invalid/?Signature=SECRET', { cause: { code: 'ECONNRESET' } });
  await assert.rejects(capturedFetch('/unused', trace, async () => { throw error; })('https://synthetic.invalid/audio'), e => e === error);
  const safe = safeFailure(error); assert.equal(safe.code, 'ECONNRESET'); assert.equal(safe.name, 'TypeError');
  assert.equal(trace.stage, 'audio_download_fetch'); assert.doesNotMatch(JSON.stringify(safe), /secret|Signature/);
});
