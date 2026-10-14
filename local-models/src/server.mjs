import http from 'node:http';
import { once } from 'node:events';
import { ModelError, modelRoute, loopback, nativeAsrProtocols } from './config.mjs';
import { SenseVoice } from './sensevoice.mjs';
import { NativeAsr } from './asr-native.mjs';
import { version } from './version.mjs';
import { Kokoro } from './kokoro.mjs';
import { upstream, SerialQueue, gptSovits, gptSessionKey, minimaxSpeech } from './providers.mjs';

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function bodyBytes(req, limit, signal) {
  const length = Number(req.headers['content-length']);
  if (length > limit) throw new ModelError(413, 'Request body exceeds size limit.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > limit) throw new ModelError(413, 'Request body exceeds size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(bytes, contentType) {
  if (!/^application\/json(?:;|$)/i.test(contentType)) throw new ModelError(415, 'Use Content-Type: application/json.');
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ModelError(400, 'Invalid JSON request.'); }
}

async function copyResponse(res, response, signal) {
  res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' });
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(value)) await once(res, 'drain', { signal });
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  }
  res.end();
}

export function createGateway(config) {
  const sensevoice = new SenseVoice();
  const nativeAsr = new NativeAsr();
  const kokoro = new Kokoro();
  const serial = new SerialQueue();
  const stalledGpt = new Set();
  let active = 0;
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Model request timed out.')), config.timeoutMs);
    timeout.unref();
    const abort = () => { if (!res.writableFinished) controller.abort(new Error('Client disconnected.')); };
    res.on('close', abort);
    req.on('aborted', abort);
    const signal = controller.signal;
    let counted = false;
    try {
      let host;
      try { host = new URL(`http://${req.headers.host}`); } catch { throw new ModelError(403, 'Invalid Host.'); }
      if (!loopback(host.hostname) || Number(host.port || 80) !== server.address().port) throw new ModelError(403, 'Invalid Host.');
      if (req.headers.origin && req.headers.origin !== host.origin) throw new ModelError(403, 'Cross-origin requests are not accepted.');
      const path = req.url?.split('?')[0];
      if (req.method === 'GET' && path === '/health') {
        return json(res, 200, { status: 'ok', version, models: config.routes.map(({ alias, kind, providerId }) => ({ id: alias, kind, provider: providerId })), readiness: 'configured; run doctor to check backends' });
      }
      if (req.method === 'GET' && path === '/v1/models') {
        return json(res, 200, { object: 'list', data: config.routes.map(route => ({ id: route.alias, object: 'model', created: 0, owned_by: route.providerId, capability: route.kind })) });
      }
      if (req.method === 'GET' && path === '/api/tags') {
        return json(res, 200, { models: config.routes.filter(route => route.provider.protocol === 'ollama').map(route => ({ name: route.alias, model: route.alias })) });
      }
      if (req.method !== 'POST' || !['/v1/chat/completions', '/api/chat', '/v1/audio/transcriptions', '/v1/audio/speech'].includes(path)) throw new ModelError(404, 'Unknown endpoint.');
      if (active >= 4) throw new ModelError(429, 'Gateway is busy; wait for current requests to finish.', 'busy');
      active++;
      counted = true;
      const contentType = req.headers['content-type'] ?? '';
      const bytes = await bodyBytes(req, config.maxBodyBytes, signal);
      if (path === '/v1/audio/transcriptions') {
        if (!/^multipart\/form-data;/i.test(contentType)) throw new ModelError(415, 'Transcription requires multipart/form-data.');
        let form;
        try { form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType }, body: bytes }).formData(); }
        catch { throw new ModelError(400, 'Invalid multipart audio request.'); }
        const route = modelRoute(config, 'asr', form.get('model'));
        const file = form.get('file');
        if (!file || typeof file.arrayBuffer !== 'function' || !file.size) throw new ModelError(400, 'A nonempty file is required.');
        if (nativeAsrProtocols.includes(route.provider.protocol)) {
          const format = form.get('response_format') ?? 'json';
          if (!['json', 'text', 'verbose_json'].includes(format)) throw new ModelError(400, 'Local ASR supports json, text or verbose_json.');
          if (form.get('stream') === 'true') throw new ModelError(400, 'Local ASR is utterance-based; use VAD segments, not partial-token streaming.');
          const audio = Buffer.from(await file.arrayBuffer());
          const recognizer = route.provider.protocol === 'sensevoice' ? sensevoice : nativeAsr;
          const result = await serial.run(`asr:${route.providerId}`, signal, () => recognizer.transcribe(route, audio, form.get('language'), signal));
          if (format === 'text') {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(result.text);
          }
          return json(res, 200, format === 'verbose_json' ? result : { text: result.text });
        }
        form.set('model', route.upstreamModel);
        return await copyResponse(res, await upstream(route, 'audio/transcriptions', form, signal, false), signal);
      }
      const request = parseJson(bytes, contentType);
      if (path === '/v1/chat/completions' || path === '/api/chat') {
        const route = modelRoute(config, 'chat', request.model);
        if (!Array.isArray(request.messages) || !request.messages.length) throw new ModelError(400, 'messages must be a nonempty array.');
        if (path === '/api/chat' && route.provider.protocol !== 'ollama') throw new ModelError(400, '/api/chat requires an Ollama model.');
        const endpoint = route.provider.protocol === 'ollama' ? (path === '/api/chat' ? 'api/chat' : 'v1/chat/completions') : 'chat/completions';
        return await copyResponse(res, await upstream(route, endpoint, { ...request, model: route.upstreamModel }, signal), signal);
      }
      const route = modelRoute(config, 'tts', request.model);
      if (typeof request.input !== 'string' || !request.input.trim() || request.input.length > 10000) throw new ModelError(400, 'input must contain 1–10000 characters.');
      if (typeof request.voice !== 'string' || !request.voice) throw new ModelError(400, 'voice is required.');
      if (request.speed !== undefined && (!Number.isFinite(request.speed) || request.speed < 0.25 || request.speed > 4)) throw new ModelError(400, 'speed must be between 0.25 and 4.');
      if (['gpt-sovits', 'minimax-speech', 'kokoro'].includes(route.provider.protocol) && (request.stream === true || (request.stream_format && request.stream_format !== 'audio'))) throw new ModelError(400, 'This speech adapter returns complete binary audio.');
      if (route.provider.protocol === 'kokoro') {
        const response = await serial.run(`kokoro:${route.providerId}`, signal, () => kokoro.speak(route, request, signal));
        return await copyResponse(res, response, signal);
      }
      if (route.provider.protocol === 'gpt-sovits') {
        const key = gptSessionKey(route.provider);
        const response = await serial.run(key, signal, async () => {
          if (stalledGpt.has(key)) throw new ModelError(503, 'Previous GPT-SoVITS operation timed out. Restart its API and the gateway before changing weights.', 'backend_state_unknown');
          // Disconnecting a client does not cancel Python inference. Keep the
          // global-weight lock until the backend returns, even if playback stops.
          const backendSignal = AbortSignal.timeout(config.timeoutMs);
          try { return await gptSovits(route, request, backendSignal); }
          catch (error) { if (backendSignal.aborted) stalledGpt.add(key); throw error; }
        });
        return await copyResponse(res, response, signal);
      }
      const response = route.provider.protocol === 'minimax-speech' ? await minimaxSpeech(route, request, signal) : await upstream(route, 'audio/speech', { ...request, model: route.upstreamModel }, signal);
      await copyResponse(res, response, signal);
    } catch (error) {
      if (res.destroyed) return;
      const status = signal.aborted ? 504 : (error instanceof ModelError ? error.status : 500);
      const message = signal.aborted ? 'Model request timed out or was cancelled.' : (error instanceof ModelError ? error.message : 'Model adapter failed; check backend configuration.');
      if (res.headersSent) res.destroy();
      else json(res, status, { error: { message, type: status === 500 ? 'server_error' : 'invalid_request_error', code: error.code ?? 'model_error' } });
    } finally {
      clearTimeout(timeout);
      res.off('close', abort);
      req.off('aborted', abort);
      if (counted) active--;
    }
  });
  server.requestTimeout = config.timeoutMs;
  return server;
}
