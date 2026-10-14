import { stat } from 'node:fs/promises';
import { ModelError } from './config.mjs';
import { pcmWave } from './audio.mjs';
import { whisperVocabulary, decodeWhisperBytes } from './whisper-vocabulary.mjs';

// The multilingual Whisper-small vocabulary has 99 language tokens. Cantonese
// has a separate token only in newer Whisper models, so do not pass yue here.
const whisperLanguages = new Set(('en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su').split(' '));

function languageFor(protocol, language) {
  if (language === undefined || language === null || language === '' || language === 'auto') return '';
  if (typeof language !== 'string') throw new ModelError(400, 'language must be a language code.');
  if (protocol === 'paraformer') {
    if (!['zh', 'en'].includes(language)) throw new ModelError(400, 'This Paraformer model supports Chinese and English.');
  } else if (!whisperLanguages.has(language)) {
    throw new ModelError(400, 'Unsupported Whisper-small language code.');
  }
  return language;
}

function nativeConfig(provider, language) {
  const protocol = provider.protocol;
  if (!['paraformer', 'whisper'].includes(protocol)) throw new ModelError(400, 'Unsupported native ASR protocol.');
  const keys = protocol === 'paraformer' ? ['modelPath', 'tokensPath'] : ['encoderPath', 'decoderPath', 'tokensPath'];
  if (keys.some(key => typeof provider[key] !== 'string' || !provider[key])) {
    throw new ModelError(503, `Configure ${protocol} model paths before transcription.`, 'model_not_ready');
  }
  const numThreads = provider.numThreads ?? 4;
  if (!Number.isInteger(numThreads) || numThreads < 1 || numThreads > 16) throw new ModelError(400, 'numThreads must be between 1 and 16.');
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      ...(protocol === 'paraformer'
        ? { paraformer: { model: provider.modelPath } }
        : { whisper: { encoder: provider.encoderPath, decoder: provider.decoderPath, language, task: 'transcribe', tailPaddings: -1 } }),
      tokens: provider.tokensPath, numThreads, provider: 'cpu', debug: false,
    },
    decodingMethod: 'greedy_search',
  };
}

export class NativeAsr {
  constructor(loadSherpa = async () => (await import('sherpa-onnx-node')).default) {
    this.loadSherpa = loadSherpa;
    this.recognizers = new Map();
  }

  async transcribe(route, bytes, language, signal) {
    signal?.throwIfAborted();
    const provider = route.provider;
    if (!['paraformer', 'whisper'].includes(provider.protocol)) throw new ModelError(400, 'Unsupported native ASR protocol.');
    const lang = languageFor(provider.protocol, language);
    const waveform = pcmWave(bytes);
    const duration = waveform.samples.length / waveform.sampleRate;
    // v1.13.8 silently clips at 2950 mel frames. Leave a margin below that
    // cutoff so accepted requests cannot lose their final spoken words.
    if (provider.protocol === 'whisper' && duration > 29) {
      throw new ModelError(400, 'Whisper-small accepts at most 29 seconds per request; split using VAD.');
    }
    const config = nativeConfig(provider, lang);
    const paths = provider.protocol === 'paraformer' ? [provider.modelPath, provider.tokensPath] : [provider.encoderPath, provider.decoderPath, provider.tokensPath];
    try {
      const files = await Promise.all(paths.map(path => stat(path)));
      if (files.some(file => !file.isFile() || !file.size)) throw new Error('Invalid model file.');
    } catch {
      const model = provider.protocol === 'paraformer' ? 'paraformer' : 'whisper-small';
      throw new ModelError(503, `Native ASR weights missing. Run tools/prepare-asr.ps1 -Model ${model}.`, 'model_not_ready');
    }
    signal?.throwIfAborted();
    if (provider.protocol === 'whisper') config.modelConfig.tokens = await whisperVocabulary(provider.tokensPath);
    signal?.throwIfAborted();
    // Keep only the latest config per provider. Caching an entire Whisper model
    // for each requested language would leave hundreds of MB per language live.
    const key = `${route.providerId}:${provider.protocol}`;
    const fingerprint = JSON.stringify(config);
    let entry = this.recognizers.get(key);
    if (!entry || entry.fingerprint !== fingerprint) {
      const promise = (async () => {
        let sherpa;
        try { sherpa = await this.loadSherpa(); }
        catch { throw new ModelError(503, 'Install local-models dependencies using npm.cmd ci.', 'model_not_ready'); }
        return sherpa.OfflineRecognizer.createAsync(config);
      })();
      entry = { fingerprint, promise };
      this.recognizers.set(key, entry);
      promise.catch(() => { if (this.recognizers.get(key) === entry) this.recognizers.delete(key); });
    }
    const recognizer = await entry.promise;
    signal?.throwIfAborted();
    const stream = recognizer.createStream();
    stream.acceptWaveform(waveform); // Native code resamples 8–48kHz to 16kHz.
    // The native worker has no AbortSignal API. Keep awaiting its completion so
    // the caller's serial queue cannot release a running recognizer early.
    const result = await recognizer.decodeAsync(stream);
    signal?.throwIfAborted();
    return {
      text: (provider.protocol === 'whisper' ? decodeWhisperBytes(result.text ?? '') : String(result.text ?? '')).trim(),
      language: String(result.lang || lang || 'auto').replace(/^<\|(.+)\|>$/, '$1'),
      duration,
    };
  }
}
