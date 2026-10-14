// One model per process. Exit this process before starting another model phase.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { loadConfig } from '../src/config.mjs';
import { createGateway } from '../src/server.mjs';
import { LocalAsrProvider, LocalTtsProvider } from '../../code/desktop-pet/dist/providers/local-speech.js';
import { MemoryMediaStore } from '../../code/desktop-pet/dist/media/store.js';
import { inspectPcmWav } from '../../code/desktop-pet/dist/media/wav.js';
const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const data = fileURLToPath(new URL('../../.local/local-models/', import.meta.url));
const model = option('--model'); if (!model) throw Error('--model is required; run each model in a separate process.');
const output = resolve(option('--output', resolve(data, 'reports/desktop-20261010')));
await mkdir(output, { recursive: true });
const exec = promisify(execFile);
async function resources() {
  const [ram, gpu] = await Promise.all([
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { windowsHide: true }),
    exec('nvidia-smi', ['--query-gpu=memory.used,memory.free,utilization.gpu', '--format=csv,noheader,nounits'], { windowsHide: true }),
  ]);
  const [gpuUsedMiB, gpuFreeMiB, gpuUtilization] = gpu.stdout.trim().split(',').map(Number);
  return { at: new Date().toISOString(), ramFreeMiB: Math.round(Number(ram.stdout.trim()) / 1024), gpuUsedMiB, gpuFreeMiB, gpuUtilization,
    nodeRssMiB: Math.round(process.memoryUsage().rss / 1048576) };
}
const baseline = await resources();
if (baseline.ramFreeMiB < 6144 || baseline.gpuFreeMiB < 4096) throw Error('Insufficient resource headroom; stop this phase before loading any model.');
const config = await loadConfig(resolve(data, 'config.local.json'));
config.routes = config.routes.filter(route => route.alias === model);
if (config.routes.length !== 1 || !['asr', 'tts'].includes(config.routes[0].kind)) throw Error('Select exactly one configured ASR or TTS model.');
const route = config.routes[0]; route.provider.numThreads = 2;
const report = { at: new Date().toISOString(), model, kind: route.kind, source: '3798c0e6 + Windows 0.3.0-dev.1',
  scope: 'Real current desktop provider -> loopback OpenAI gateway -> one local model. No cloud or dialogue calls.', baseline, resources: [], results: [], failures: [] };
const server = createGateway(config); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const controller = new AbortController(); let monitoring = false;
const sample = async () => {
  if (monitoring) return; monitoring = true;
  try { const current = await resources(); report.resources.push(current);
    if (current.ramFreeMiB < 4096 || current.gpuFreeMiB < 2048) controller.abort(Error('Resource floor reached; finish this phase and unload the model.'));
  } finally { monitoring = false; }
};
const timer = setInterval(() => sample().catch(() => {}), 2000);
const store = new MemoryMediaStore();
try {
  const texts = ['你好，今天我们一起测试本地语音。', '请在十月十日上午九点提醒我检查任务进度。', '本地语音已经启动，请把这个任务交给代码助手。'];
  const files = route.kind === 'asr' ? [resolve(data, 'models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav'),
    ...(await readdir(output)).filter(name => name.endsWith('.wav')).map(name => resolve(output, name))] : [];
  for (let i = 0; i < (route.kind === 'tts' ? texts.length : files.length); i++) {
    controller.signal.throwIfAborted();
    const scope = { characterId: 'friend', sessionId: 'desktop-local-benchmark', turnId: `${model}-${i}`, generation: 0 };
    try {
      const start = performance.now();
      if (route.kind === 'tts') {
        const voice = { 'gpt-sovits': 'pet-smoke', 'kokoro-82m': '3', 'qwen3-tts-0.6b': 'pet-reference' }[model];
        const provider = new LocalTtsProvider({ baseUrl, tts: { model, voice } }, store);
        const result = await provider.synthesize({ scope, text: texts[i], expression: { emotion: 'neutral', intensity: 0.5, gesture: null, delivery: '' } }, controller.signal);
        const ms = Math.round(performance.now() - start), bytes = await store.read(scope, result.audio), wav = inspectPcmWav(bytes);
        const file = resolve(output, `${model}-${i + 1}.wav`); await writeFile(file, bytes);
        const pcm = new DataView(wav.data.buffer, wav.data.byteOffset, wav.data.byteLength); let sum = 0;
        for (let j = 0; j < wav.data.length; j += 2) sum += (pcm.getInt16(j, true) / 32768) ** 2;
        const rms = Math.sqrt(sum / (wav.data.length / 2)); if (rms < 0.00001) throw Error('Silent audio output');
        report.results.push({ input: texts[i], file, ms, durationMs: wav.durationMs, sampleRate: wav.sampleRate, rms, realTimeFactor: ms / wav.durationMs });
      } else {
        const audio = await store.put(scope, await readFile(files[i]), 'audio/wav');
        const provider = new LocalAsrProvider({ baseUrl, asr: { model, language: 'zh' } }, store);
        const result = await provider.transcribe({ scope, audio }, controller.signal);
        report.results.push({ file: files[i], ms: Math.round(performance.now() - start), text: result.transcript });
      }
      console.log(JSON.stringify(report.results.at(-1)));
    } catch (error) { report.failures.push({ item: i, message: error.message }); }
    finally { await store.releaseScope(scope); }
  }
} finally {
  clearInterval(timer); await sample().catch(() => {});
  report.end = await resources(); report.complete = report.failures.length === 0 && report.results.length > 0;
  await writeFile(resolve(output, `${model}.json`), JSON.stringify(report, null, 2) + '\n');
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
if (!report.complete) process.exitCode = 1;
