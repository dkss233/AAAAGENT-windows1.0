import { access } from 'node:fs/promises';
import { ModelError } from './config.mjs';
import { audioTypes } from './audio.mjs';

export function credentials(provider) {
  if (!provider.apiKeyEnv) return {};
  const key = process.env[provider.apiKeyEnv]?.trim();
  if (!key || /[\s\x00-\x1f\x7f]/.test(key)) throw new ModelError(503, `Set ${provider.apiKeyEnv} before enabling this provider.`, 'credentials_missing');
  return { authorization: `Bearer ${key}` };
}

export async function upstream(route, path, body, signal, json = true) {
  let response;
  try {
    response = await fetch(`${route.provider.baseUrl}/${path}`, {
      method: 'POST', headers: { ...credentials(route.provider), ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? JSON.stringify(body) : body, signal, redirect: 'error',
    });
  } catch (error) {
    if (error instanceof ModelError || signal.aborted) throw error;
    throw new ModelError(502, `Cannot connect to ${route.providerId}. Check its local service and baseUrl.`, 'upstream_unavailable');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelError(502, `${route.providerId} returned HTTP ${response.status}.`, 'upstream_error');
  }
  return response;
}

export async function limitedBytes(response, signal, limit = 50 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new ModelError(502, 'Upstream response exceeds size limit.', 'upstream_error');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

// A GPT-SoVITS process has global weights. Serialize weight selection + complete
// synthesis together, including requests through multiple aliases for that URL.
export class SerialQueue {
  constructor() { this.tails = new Map(); }
  async run(key, signal, action) {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const task = previous.then(() => { signal.throwIfAborted(); return action(); });
    const tail = task.then(() => {}, () => {});
    this.tails.set(key, tail);
    tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    // Reject cancelled waiters promptly while keeping their queue position until
    // the previous native/backend operation really finishes.
    let abort;
    try {
      signal.throwIfAborted();
      return await Promise.race([task, new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
}

export function gptSessionKey(provider) {
  const url = new URL(provider.baseUrl);
  const host = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? 'loopback' : url.hostname;
  return `${url.protocol}//${host}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
}

export async function gptSovits(route, request, signal) {
  const voice = route.provider.voices?.[request.voice];
  if (!voice?.refAudioPath || !voice.promptLanguage || !voice.textLanguage) {
    throw new ModelError(503, 'Configure this GPT-SoVITS voice: refAudioPath, promptText, promptLanguage, textLanguage.', 'voice_not_ready');
  }
  const format = request.response_format ?? 'wav';
  if (!['wav', 'ogg', 'aac'].includes(format)) throw new ModelError(400, 'Use wav, ogg or aac for GPT-SoVITS. Raw PCM sample rates differ from the OpenAI 24 kHz convention.');
  try { await access(voice.refAudioPath); }
  catch { throw new ModelError(503, 'Configured GPT-SoVITS reference audio is missing.', 'voice_not_ready'); }
  for (const [key, endpoint] of [['gptWeightsPath', 'set_gpt_weights'], ['sovitsWeightsPath', 'set_sovits_weights']]) {
    if (!voice[key]) continue;
    try { await access(voice[key]); }
    catch { throw new ModelError(503, 'Configured GPT-SoVITS weights are missing.', 'voice_not_ready'); }
    let response;
    try {
      const url = new URL(`${route.provider.baseUrl}/${endpoint}`);
      url.searchParams.set('weights_path', voice[key]);
      response = await fetch(url, { headers: credentials(route.provider), signal, redirect: 'error' });
    } catch (error) {
      if (signal.aborted || error instanceof ModelError) throw error;
      throw new ModelError(502, 'Cannot select GPT-SoVITS weights.', 'upstream_unavailable');
    }
    const bytes = await limitedBytes(response, signal, 1024 * 1024);
    if (!response.ok) throw new ModelError(502, 'GPT-SoVITS rejected the configured weights.', 'upstream_error');
    let result;
    try { result = JSON.parse(bytes.toString()); } catch { /* Some versions return a plain success message. */ }
    if (result?.message && result.message !== 'success') throw new ModelError(502, 'GPT-SoVITS could not select weights.', 'upstream_error');
  }
  const response = await upstream(route, 'tts', {
    text: request.input, text_lang: voice.textLanguage, ref_audio_path: voice.refAudioPath,
    prompt_text: voice.promptText ?? '', prompt_lang: voice.promptLanguage,
    text_split_method: voice.textSplitMethod ?? 'cut5', batch_size: 1,
    media_type: format, streaming_mode: false,
    speed_factor: request.speed ?? 1,
  }, signal);
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    await response.body?.cancel();
    throw new ModelError(502, 'GPT-SoVITS returned an error instead of audio.', 'upstream_error');
  }
  const audio = await limitedBytes(response, signal);
  if (!audio.length || (format === 'wav' && audio.toString('ascii', 0, 4) !== 'RIFF')) throw new ModelError(502, 'GPT-SoVITS returned invalid audio.', 'upstream_error');
  return new Response(audio, { headers: { 'content-type': audioTypes[format] } });
}

export async function minimaxSpeech(route, request, signal) {
  const format = request.response_format ?? 'mp3';
  if (!['mp3', 'wav', 'pcm', 'flac'].includes(format)) throw new ModelError(400, 'Unsupported MiniMax speech format.');
  const response = await upstream(route, 't2a_v2', {
    model: route.upstreamModel, text: request.input, stream: false, output_format: 'hex',
    voice_setting: { voice_id: request.voice, speed: request.speed ?? 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 24000, format, channel: 1 },
  }, signal);
  let result;
  try { result = JSON.parse((await limitedBytes(response, signal)).toString('utf8')); }
  catch (error) {
    if (error instanceof ModelError || signal.aborted) throw error;
    throw new ModelError(502, 'MiniMax returned invalid JSON.', 'upstream_error');
  }
  if (result.base_resp?.status_code !== 0) throw new ModelError(502, `MiniMax synthesis failed (status ${Number(result.base_resp?.status_code) || 'unknown'}).`, 'upstream_error');
  const hex = result.data?.audio;
  if (typeof hex !== 'string' || !hex.length || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new ModelError(502, 'MiniMax returned invalid hex audio.', 'upstream_error');
  const audio = Buffer.from(hex, 'hex');
  if (format === 'wav' && audio.toString('ascii', 0, 4) !== 'RIFF') throw new ModelError(502, 'MiniMax returned invalid WAV audio.', 'upstream_error');
  return new Response(audio, { headers: { 'content-type': audioTypes[format] } });
}
