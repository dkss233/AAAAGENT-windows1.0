import { access } from 'node:fs/promises';
import { ModelError } from './config.mjs';
import { pcmWave } from './audio.mjs';

export class SenseVoice {
  constructor() { this.recognizers = new Map(); }

  async transcribe(route, bytes, language, signal) {
    const waveform = pcmWave(bytes);
    const lang = language || 'auto';
    if (!['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(lang)) throw new ModelError(400, 'Unsupported SenseVoice language.');
    const provider = route.provider;
    try { await Promise.all([access(provider.modelPath), access(provider.tokensPath)]); }
    catch { throw new ModelError(503, 'SenseVoice weights missing. Run tools/prepare-sensevoice.ps1.', 'model_not_ready'); }
    signal.throwIfAborted();
    let sherpa;
    try { sherpa = (await import('sherpa-onnx-node')).default; }
    catch { throw new ModelError(503, 'Install local-models dependencies using npm.cmd ci.', 'model_not_ready'); }
    const key = `${route.providerId}:${lang}`;
    if (!this.recognizers.has(key)) {
      const promise = sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: { senseVoice: { model: provider.modelPath, language: lang, useInverseTextNormalization: 1 },
          tokens: provider.tokensPath, numThreads: provider.numThreads, provider: 'cpu', debug: false },
      });
      this.recognizers.set(key, promise);
      promise.catch(() => this.recognizers.delete(key));
    }
    const recognizer = await this.recognizers.get(key);
    signal.throwIfAborted();
    const stream = recognizer.createStream();
    stream.acceptWaveform(waveform);
    const result = await recognizer.decodeAsync(stream);
    signal.throwIfAborted();
    return { text: result.text ?? '', language: String(result.lang ?? lang).replace(/^<\|(.+)\|>$/, '$1'), duration: waveform.samples.length / waveform.sampleRate };
  }
}
