import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { NativeAsr } from '../src/asr-native.mjs';

function wav(seconds = 0.02) {
  const size = Math.floor(seconds * 16000) * 2;
  const out = Buffer.alloc(44 + size);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(size, 40);
  return out;
}
const file = fileURLToPath(import.meta.url);
const route = protocol => ({ providerId: protocol, provider: { protocol, modelPath: file, tokensPath: file, encoderPath: file, decoderPath: file, numThreads: 2 } });

test('Whisper rejects a 30-second segment before the native 2950-frame truncation cutoff', async () => {
  const asr = new NativeAsr(() => { throw new Error('Native loading must not happen.'); });
  await assert.rejects(asr.transcribe(route('whisper'), wav(30), 'zh'), error => error.status === 400 && /29 seconds/.test(error.message));
});

test('Unsupported model languages and missing weights are actionable client errors', async () => {
  const asr = new NativeAsr(() => { throw new Error('Native loading must not happen.'); });
  await assert.rejects(asr.transcribe(route('paraformer'), wav(), 'fr'), error => error.status === 400);
  await assert.rejects(asr.transcribe(route('whisper'), wav(), 'yue'), error => error.status === 400);
  const missing = route('whisper'); missing.provider.encoderPath = `${file}.absent`;
  await assert.rejects(asr.transcribe(missing, wav(), 'zh'), error => error.status === 503 && error.code === 'model_not_ready');
});

test('Already-cancelled requests do not load or execute native ASR', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  const asr = new NativeAsr(() => { throw new Error('Native loading must not happen.'); });
  await assert.rejects(asr.transcribe(route('paraformer'), wav(), 'zh', controller.signal), /cancelled/);
});

test('An empty native language field retains the requested language', async () => {
  const asr = new NativeAsr(async () => ({ OfflineRecognizer: { createAsync: async () => ({
    createStream: () => ({ acceptWaveform() {} }),
    decodeAsync: async () => ({ text: '测试', lang: '' }),
  }) } }));
  const result = await asr.transcribe(route('paraformer'), wav(), 'zh');
  assert.equal(result.language, 'zh');
});

test('Cancelled decoding waits for the native worker to finish before rejecting', async () => {
  let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  const asr = new NativeAsr(async () => ({ OfflineRecognizer: { createAsync: async () => ({
    createStream: () => ({ acceptWaveform() {} }),
    decodeAsync: () => { started(); return new Promise(resolve => { finish = resolve; }); },
  }) } }));
  const controller = new AbortController();
  let settled = false;
  const result = asr.transcribe(route('paraformer'), wav(), 'zh', controller.signal).finally(() => { settled = true; });
  await began;
  controller.abort(new Error('cancelled'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish({ text: 'unused' });
  await assert.rejects(result, /cancelled/);
});
