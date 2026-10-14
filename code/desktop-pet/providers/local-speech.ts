import type { AsrInput, AsrProvider, AsrResult, MediaStorePort, TtsProvider, TtsRequest, TtsResult } from '../contracts/index.js';
import { checkAbort } from '../media/scope.js';
import { inspectPcmWav, joinPcmWav } from '../media/wav.js';
import { splitSpeech } from './qwen-tts.js';

export interface LocalSpeechConfiguration {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly asr?: { readonly model: string; readonly language?: string };
  readonly tts?: { readonly model: string; readonly voice: string };
}
export function validateLocalSpeech(value: unknown): LocalSpeechConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('本地语音配置无效。');
  const c = value as LocalSpeechConfiguration;
  let url: URL;
  try { url = new URL(c.baseUrl); } catch { throw Error('本地语音服务地址无效。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
      url.username || url.password || url.search || url.hash || !['/v1', '/v1/'].includes(url.pathname))
    throw Error('本地语音服务须使用本机回环地址和 /v1 接口。');
  if (!c.asr && !c.tts) throw Error('至少选择一项本地语音功能。');
  if (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 180000)) throw Error('本地语音超时须为 1–180 秒。');
  if (c.asr && (!['sensevoice-small', 'paraformer-zh', 'whisper-small'].includes(c.asr.model) ||
      c.asr.language !== undefined && !/^[a-z]{2,3}$/.test(c.asr.language))) throw Error('本地识别模型或语言无效。');
  if (c.tts && (!['gpt-sovits', 'kokoro-82m', 'qwen3-tts-0.6b'].includes(c.tts.model) ||
      typeof c.tts.voice !== 'string' || !c.tts.voice.trim() || c.tts.voice.length > 128)) throw Error('本地合成模型和音色须明确选择。');
  return Object.freeze({ baseUrl: c.baseUrl.replace(/\/$/, ''), timeoutMs: c.timeoutMs ?? 120000,
    ...(c.asr ? { asr: Object.freeze({ ...c.asr }) } : {}), ...(c.tts ? { tts: Object.freeze({ ...c.tts }) } : {}) });
}

async function bytesLimited(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok) { await response.body?.cancel(); throw Error(`本地语音服务返回 HTTP ${response.status}；请检查当前模型服务。`); }
  const reader = response.body?.getReader();
  if (!reader) throw Error('本地语音服务未返回内容。');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > maximum) throw Error('本地语音返回内容超过限制。');
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } finally { await reader.cancel().catch(() => {}); }
}
// These adapters never read cloud keys or fall back to a paid service.
export class LocalAsrProvider implements AsrProvider {
  private readonly config: LocalSpeechConfiguration;
  constructor(config: LocalSpeechConfiguration, private readonly store: MediaStorePort, private readonly request: typeof fetch = fetch) {
    this.config = validateLocalSpeech(config); if (!this.config.asr) throw Error('本地 ASR 未配置。');
  }
  async transcribe(input: AsrInput, signal: AbortSignal): Promise<AsrResult> {
    checkAbort(signal);
    if (input.audio.mimeType !== 'audio/wav') throw Error('本地识别需要 PCM WAV 音频。');
    const bytes = await this.store.read(input.scope, input.audio);
    try {
      const info = inspectPcmWav(bytes), model = this.config.asr!;
      if (info.channels !== 1 || info.durationMs > (model.model === 'whisper-small' ? 29000 : 60000)) throw Error('本地识别需要单声道录音；Whisper 最长 29 秒，其余最长 60 秒。');
      const form = new FormData(); form.set('model', model.model); form.set('response_format', 'json');
      if (model.language) form.set('language', model.language);
      form.set('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'speech.wav');
      checkAbort(signal);
      const response = await this.request(this.config.baseUrl + '/audio/transcriptions', { method: 'POST', body: form,
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs!)]) });
      const raw = JSON.parse(new TextDecoder().decode(await bytesLimited(response, 1024 * 1024)));
      checkAbort(signal);
      if (typeof raw.text !== 'string') throw Error('本地识别未返回文本。');
      return { scope: input.scope, transcript: raw.text, ...(typeof raw.language === 'string' ? { language: raw.language } : {}) };
    } finally { bytes.fill(0); }
  }
}
export class LocalTtsProvider implements TtsProvider {
  private readonly config: LocalSpeechConfiguration;
  constructor(config: LocalSpeechConfiguration, private readonly store: MediaStorePort, private readonly request: typeof fetch = fetch) {
    this.config = validateLocalSpeech(config); if (!this.config.tts) throw Error('本地 TTS 未配置。');
  }
  async synthesize(input: TtsRequest, signal: AbortSignal): Promise<TtsResult> {
    checkAbort(signal); if (!input.text.trim()) throw Error('不能合成空文本。');
    if (Array.from(input.text).length > 2400) throw Error('本地语音单次回复最长 2400 字。');
    const clips: Uint8Array[] = [];
    try {
      for (const text of splitSpeech(input.text, 300)) {
        checkAbort(signal);
        const response = await this.request(this.config.baseUrl + '/audio/speech', { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs!)]),
          body: JSON.stringify({ model: this.config.tts!.model, voice: this.config.tts!.voice, input: text, response_format: 'wav', speed: 1 }) });
        const bytes = await bytesLimited(response, 12 * 1024 * 1024); clips.push(bytes); inspectPcmWav(bytes);
      }
      checkAbort(signal); const bytes = joinPcmWav(clips);
      try {
        const durationMs = inspectPcmWav(bytes).durationMs, audio = await this.store.put(input.scope, bytes, 'audio/wav');
        try { checkAbort(signal); } catch (error) { await this.store.releaseScope(input.scope); throw error; }
        return { scope: input.scope, audio, expression: input.expression, durationMs, synchronization: 'amplitude' };
      } finally { bytes.fill(0); }
    } finally { clips.forEach(clip => clip.fill(0)); }
  }
}
