import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ModelError } from './config.mjs';

function wave(samples, rate) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return bytes;
}

export class Kokoro {
  constructor() { this.engines = new Map(); }
  async speak(route, request, signal) {
    if ((request.response_format ?? 'wav') !== 'wav') throw new ModelError(400, 'Kokoro returns PCM16 WAV; use response_format=wav.');
    if (request.input.length > 2000) throw new ModelError(400, 'Split Kokoro input into segments of at most 2000 characters.');
    if (!/^(0|[1-9]\d{0,2})$/.test(request.voice)) throw new ModelError(400, 'Kokoro voice must be an integer speaker ID; see the model speaker table.');
    const dir = route.provider.modelDir;
    const required = ['model.int8.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'phone-zh.fst', 'date-zh.fst', 'number-zh.fst'];
    try { await Promise.all(required.map(name => access(resolve(dir, name)))); }
    catch { throw new ModelError(503, 'Kokoro weights missing. Run tools/prepare-model.ps1 -Model kokoro.', 'model_not_ready'); }
    signal.throwIfAborted();
    if (!this.engines.has(route.providerId)) {
      const promise = import('sherpa-onnx-node').then(({ default: sherpa }) => sherpa.OfflineTts.createAsync({
        model: { kokoro: { model: resolve(dir, 'model.int8.onnx'), voices: resolve(dir, 'voices.bin'), tokens: resolve(dir, 'tokens.txt'),
          dataDir: resolve(dir, 'espeak-ng-data'), lexicon: `${resolve(dir, 'lexicon-us-en.txt')},${resolve(dir, 'lexicon-zh.txt')}` },
          numThreads: route.provider.numThreads, provider: 'cpu', debug: false },
        maxNumSentences: 1,
        ruleFsts: ['phone-zh.fst', 'date-zh.fst', 'number-zh.fst'].map(name => resolve(dir, name)).join(','),
      }));
      this.engines.set(route.providerId, promise);
      promise.catch(() => this.engines.delete(route.providerId));
    }
    const engine = await this.engines.get(route.providerId);
    const sid = Number(request.voice);
    if (sid >= engine.numSpeakers) throw new ModelError(400, `Kokoro voice must be between 0 and ${engine.numSpeakers - 1}.`);
    signal.throwIfAborted();
    const audio = await engine.generateAsync({ text: request.input, sid, speed: request.speed ?? 1, onProgress: () => signal.aborted ? 0 : 1 });
    signal.throwIfAborted();
    if (!audio.samples?.length) throw new ModelError(502, 'Kokoro returned no audio.', 'upstream_error');
    return new Response(wave(audio.samples, audio.sampleRate), { headers: { 'content-type': 'audio/wav' } });
  }
}
