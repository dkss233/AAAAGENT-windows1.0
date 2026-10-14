import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class ModelError extends Error {
  constructor(status, message, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const loopback = host => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host);
export const nativeAsrProtocols = ['sensevoice', 'paraformer', 'whisper'];
export const nativeModelPaths = {
  sensevoice: ['modelPath', 'tokensPath'], paraformer: ['modelPath', 'tokensPath'],
  whisper: ['encoderPath', 'decoderPath', 'tokensPath'], kokoro: ['modelDir'],
};
const protocols = ['ollama', 'openai', ...nativeAsrProtocols, 'kokoro', 'gpt-sovits', 'minimax-speech'];
const capabilities = {
  ollama: ['chat'], openai: ['chat', 'asr', 'tts'], sensevoice: ['asr'], paraformer: ['asr'], whisper: ['asr'],
  'gpt-sovits': ['tts'], 'minimax-speech': ['tts'], kokoro: ['tts'],
};

export function validateConfig(source, directory = process.cwd()) {
  const config = structuredClone(source);
  if (config.version !== 1 || !loopback(config.host)) throw new Error('Config version must be 1 and host must be loopback.');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid gateway port.');
  config.timeoutMs ??= 120000;
  config.maxBodyBytes ??= 25 * 1024 * 1024;
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 600000) throw new Error('Invalid timeoutMs.');
  if (!Number.isInteger(config.maxBodyBytes) || config.maxBodyBytes < 1 || config.maxBodyBytes > 100 * 1024 * 1024) throw new Error('Invalid maxBodyBytes.');
  if (!config.providers || typeof config.providers !== 'object' || Array.isArray(config.providers)) throw new Error('Missing providers.');
  const aliases = new Set();
  config.routes = [];
  for (const [id, provider] of Object.entries(config.providers)) {
    if (typeof provider.enabled !== 'boolean' || !protocols.includes(provider.protocol)) throw new Error(`Invalid provider: ${id}`);
    if (nativeModelPaths[provider.protocol]) {
      for (const key of nativeModelPaths[provider.protocol]) {
        if (typeof provider[key] !== 'string' || !provider[key]) throw new Error(`Missing ${id}.${key}`);
        provider[key] = resolve(directory, provider[key]);
      }
      provider.numThreads ??= 4;
      if (!Number.isInteger(provider.numThreads) || provider.numThreads < 1 || provider.numThreads > 16) throw new Error(`Invalid ${id}.numThreads`);
    } else {
      const url = new URL(provider.baseUrl);
      if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error(`Invalid baseUrl: ${id}`);
      if (!loopback(url.hostname) && (provider.allowRemote !== true || url.protocol !== 'https:')) throw new Error(`${id}: remote providers require allowRemote=true and HTTPS.`);
      provider.baseUrl = url.href.replace(/\/$/, '');
    }
    if (provider.apiKeyEnv !== undefined && (typeof provider.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv))) throw new Error(`Invalid apiKeyEnv: ${id}`);
    for (const voice of Object.values(provider.voices ?? {})) {
      for (const key of ['refAudioPath', 'gptWeightsPath', 'sovitsWeightsPath']) {
        if (voice[key]) voice[key] = resolve(directory, voice[key]);
      }
    }
    if (provider.protocol === 'gpt-sovits') {
      const voices = Object.values(provider.voices ?? {});
      const explicit = voices.filter(voice => voice.gptWeightsPath || voice.sovitsWeightsPath);
      if (explicit.some(voice => !voice.gptWeightsPath || !voice.sovitsWeightsPath) || (explicit.length && explicit.length !== voices.length)) {
        throw new Error(`${id}: configure both weights for every voice, or let every voice use the API's fixed weights.`);
      }
    }
    for (const [kind, entries] of Object.entries(provider.models ?? {})) {
      if (!capabilities[provider.protocol].includes(kind)) throw new Error(`Unsupported ${id} capability: ${kind}`);
      const mapping = Array.isArray(entries) ? Object.fromEntries(entries.map(name => [name, name])) : entries;
      if (!mapping || typeof mapping !== 'object') throw new Error(`Invalid ${id}.models`);
      for (const [alias, upstreamModel] of Object.entries(mapping)) {
        if (!alias || typeof upstreamModel !== 'string' || !upstreamModel || /[\r\n]/.test(alias + upstreamModel)) throw new Error(`Invalid model alias: ${id}`);
        if (provider.enabled) {
          if (aliases.has(`${kind}:${alias}`)) throw new Error(`Duplicate ${kind} model: ${alias}`);
          aliases.add(`${kind}:${alias}`);
          config.routes.push({ alias, upstreamModel, kind, providerId: id, provider });
        }
      }
    }
  }
  return config;
}

export async function loadConfig(path) {
  return validateConfig(JSON.parse(await readFile(path, 'utf8')), dirname(resolve(path)));
}

export function modelRoute(config, kind, alias) {
  if (typeof alias !== 'string' || !alias) throw new ModelError(400, 'model is required.');
  const route = config.routes.find(route => route.kind === kind && route.alias === alias);
  if (!route) throw new ModelError(404, `Unknown or disabled ${kind} model: ${alias}`, 'model_not_found');
  return route;
}
