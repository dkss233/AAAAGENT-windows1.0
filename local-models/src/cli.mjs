import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { once } from 'node:events';
import { createGateway } from './server.mjs';
import { loadConfig, nativeAsrProtocols, nativeModelPaths } from './config.mjs';
import { credentials, limitedBytes } from './providers.mjs';
import { version } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const command = args[0] ?? 'serve';
const configIndex = args.indexOf('--config');
if (configIndex >= 0 && !args[configIndex + 1]) throw new Error('--config needs a path.');
const configPath = resolve(configIndex < 0 ? resolve(root, '../.local/local-models/config.local.json') : args[configIndex + 1]);

async function doctor(config) {
  const results = [];
  for (const [id, provider] of Object.entries(config.providers)) {
    if (!provider.enabled) continue;
    try {
      if (nativeAsrProtocols.includes(provider.protocol)) {
        await Promise.all(nativeModelPaths[provider.protocol].map(key => access(provider[key])));
        results.push({ provider: id, status: 'weights_present', note: 'Use tools/smoke.mjs --audio FILE for inference.' });
      } else if (provider.protocol === 'kokoro') {
        await Promise.all(['model.int8.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data'].map(file => access(resolve(provider.modelDir, file))));
        results.push({ provider: id, status: 'weights_present' });
      } else if (provider.allowRemote && !args.includes('--include-remote')) {
        results.push({ provider: id, status: 'remote_check_skipped' });
      } else {
        const signal = AbortSignal.timeout(5000);
        if (provider.protocol === 'gpt-sovits') {
          if (!Object.keys(provider.voices ?? {}).length) throw new Error('Add a configured reference voice before synthesis.');
          for (const voice of Object.values(provider.voices)) {
            for (const key of ['refAudioPath', 'gptWeightsPath', 'sovitsWeightsPath']) if (voice[key]) await access(voice[key]);
          }
          const response = await fetch(`${provider.baseUrl}/openapi.json`, { headers: credentials(provider), redirect: 'error', signal });
          const schema = JSON.parse((await limitedBytes(response, signal, 4 * 1024 * 1024)).toString());
          if (!response.ok || !schema.paths?.['/tts']) throw new Error('Start GPT-SoVITS api_v2.py with a compatible /tts API.');
          results.push({ provider: id, status: 'service_and_reference_ready', note: 'Model quality requires a synthesis test with your fine-tuned voice.' });
        } else {
          const response = await fetch(`${provider.baseUrl}/${provider.protocol === 'ollama' ? 'api/tags' : 'models'}`, { headers: credentials(provider), redirect: 'error', signal });
          if (!response.ok) throw new Error(`Model list returned HTTP ${response.status}.`);
          const body = JSON.parse((await limitedBytes(response, signal, 4 * 1024 * 1024)).toString());
          const installed = new Set(provider.protocol === 'ollama' ? body.models?.map(model => model.name) : body.data?.map(model => model.id));
          const models = config.routes.filter(route => route.providerId === id).map(route => ({ model: route.alias, available: installed.has(route.upstreamModel) }));
          results.push({ provider: id, status: 'service_ready', models });
        }
      }
    } catch (error) {
      const message = error?.code === 'ENOENT' ? 'Required model or reference files are missing.' : error?.name === 'TimeoutError' ? 'Backend timed out.' :
        error?.message?.startsWith('fetch failed') ? 'Backend is not running.' : error?.message ?? 'Backend check failed.';
      results.push({ provider: id, status: 'not_ready', message });
    }
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => result.status === 'not_ready')) process.exitCode = 1;
}

try {
  if (command === 'init') {
    await mkdir(dirname(configPath), { recursive: true });
    const example = await readFile(resolve(root, 'config.example.json'), 'utf8');
    await writeFile(configPath, example, { flag: 'wx' });
    console.log(`Created ${configPath}`);
    console.log('GPT-SoVITS remains the primary TTS. Add your reference voice before using it.');
  } else if (command === 'serve' || command === 'doctor') {
    const config = await loadConfig(configPath);
    const onlyIndex = args.indexOf('--only-model');
    if (onlyIndex >= 0) {
      const selected = args[onlyIndex + 1];
      config.routes = config.routes.filter(route => route.alias === selected);
      if (config.routes.length !== 1) throw new Error('--only-model must name exactly one enabled model.');
      for (const [id, provider] of Object.entries(config.providers)) provider.enabled = id === config.routes[0].providerId;
    }
    if (command === 'doctor') await doctor(config);
    else {
      const server = createGateway(config);
      server.listen(config.port, config.host);
      await once(server, 'listening');
      console.log(`AAAAGENT local-models ${version}: http://${config.host}:${server.address().port}/v1`);
      console.log('Only explicitly selected models are called. No automatic cloud fallback.');
      const stop = () => { server.close(); server.closeAllConnections(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  } else throw new Error('Commands: init, serve, doctor; optional --config PATH.');
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Configuration already exists; edit it without resetting your settings.' : error.message);
  process.exitCode = 1;
}
