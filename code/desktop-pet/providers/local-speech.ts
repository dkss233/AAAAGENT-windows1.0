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
/** Marks a configuration that already passed its own validator.
 *
 *  LocalTtsProvider used to re-run validateLocalSpeech unconditionally, which pinned tts.model to the
 *  three reviewed local weights — so an operator-defined model could never reach the request, even
 *  though the transport is identical. This mark means "the address policy has been applied"; only this
 *  module can create it, so a caller cannot use it to smuggle an unchecked address past the check. */
const SELF_VALIDATED = Symbol('aaaagent.customTts.validated');

export class LocalTtsProvider implements TtsProvider {
  private readonly config: LocalSpeechConfiguration;
  constructor(config: LocalSpeechConfiguration, private readonly store: MediaStorePort, private readonly request: typeof fetch = fetch) {
    // Only a config this module marked is trusted; everything else still goes through validation.
    this.config = (config as { [SELF_VALIDATED]?: true })[SELF_VALIDATED] === true ? config : validateLocalSpeech(config);
    if (!this.config.tts) throw Error('本地 TTS 未配置。');
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

/** An operator-configured OpenAI-compatible speech endpoint.
 *
 *  This exists because adding a supplier used to require a source change: the catalogue, the credential
 *  provider union and the endpoint assertion were all closed lists. Almost every TTS service — hosted or
 *  self-run — speaks the same shape local-speech already implements (`POST {baseUrl}/audio/speech`),
 *  so the *transport* did not need to change; only the address check did. LocalTtsProvider is reused as
 *  is, which keeps one reviewed request path instead of a second implementation to keep in step. */
export interface CustomTtsConfiguration {
  readonly baseUrl: string;
  readonly model: string;
  readonly voice: string;
  readonly provider: string;
  readonly credentialRef: string;
  readonly timeoutMs?: number;
}

/**
 * Rejects anything that could aim a key at an unintended host.
 *
 * The safety boundary moved here from the supplier name, and it is deliberately tighter than "any
 * http(s) URL": a non-loopback address must be https, because the API key is sent with the request and
 * plain http would put it on the wire in clear text. Loopback may stay http, which is what a
 * self-hosted server on the same machine needs. Embedded credentials, a query string, a fragment and
 * any path other than /v1 are refused, and the operator must confirm the exact URL — the console shows
 * it in full before saving. */
export function validateCustomTts(value: unknown): CustomTtsConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('自定义语音配置无效。');
  const c = value as CustomTtsConfiguration;
  let url: URL;
  try { url = new URL(c.baseUrl); } catch { throw Error('服务地址无效，请填写完整的 http 或 https 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('服务地址只允许 http 或 https。');
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback)
    throw Error('非本机地址必须使用 https：API Key 会随请求发送，明文 http 会让它在网络中可见。');
  if (url.username || url.password) throw Error('服务地址不能包含用户名或密码，凭据请单独填写。');
  if (url.search || url.hash) throw Error('服务地址不能带查询串或锚点。');
  if (!url.hostname) throw Error('服务地址缺少主机名。');
  if (!['/v1', '/v1/'].includes(url.pathname)) throw Error('服务地址应指向 /v1，例如 https://example.com/v1。');
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(c.provider)) throw Error('服务商名称只能用 2–32 位小写字母、数字、下划线或连字符。');
  if (typeof c.credentialRef !== 'string' || !c.credentialRef.trim()) throw Error('请先保存该服务商的 API Key。');
  if (typeof c.model !== 'string' || !c.model.trim() || c.model.length > 128) throw Error('请填写模型名称。');
  if (typeof c.voice !== 'string' || !c.voice.trim() || c.voice.length > 128) throw Error('请填写音色名称。');
  if (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 180000)) throw Error('超时须为 1–180 秒。');
  return Object.freeze({ ...c, baseUrl: c.baseUrl.replace(/\/$/, ''), timeoutMs: c.timeoutMs ?? 120000 });
}

/** One reviewed request path: the local and custom cases differ only in the address policy. */
export function createCustomTtsProvider(config: CustomTtsConfiguration, store: MediaStorePort, request: typeof fetch = fetch): TtsProvider {
  const validated = validateCustomTts(config);
  // Marked because validateCustomTts, not validateLocalSpeech, is this config's authority: the model
  // name is the operator's own and is deliberately absent from the reviewed local weights list.
  const bridge = { baseUrl: validated.baseUrl,
    ...(validated.timeoutMs === undefined ? {} : { timeoutMs: validated.timeoutMs }),
    tts: { model: validated.model, voice: validated.voice } } as LocalSpeechConfiguration & { [SELF_VALIDATED]?: true };
  bridge[SELF_VALIDATED] = true;
  return new LocalTtsProvider(bridge, store, request);
}
