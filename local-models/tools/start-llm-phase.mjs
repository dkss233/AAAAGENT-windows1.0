// An owned Ollama server, mutually exclusive with the speech-phase launcher.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freemem } from 'node:os';
import { mkdir, access, writeFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = resolve(root, '../.local/local-models');
const args = process.argv.slice(2), run = promisify(execFile);
const size = args.find(arg => arg.startsWith('--size='))?.slice(7) ?? '4b';
if (!['4b', '9b'].includes(size) || args.filter(arg => arg.startsWith('--size=')).length > 1) throw Error('Choose --size=4b or --size=9b.');
const source = `qwen3.5:${size}-q4_K_M`, model = `aaaagent-qwen35-${size}:review`;
const baseUrl = 'http://127.0.0.1:11435', context = 16384;
const executable = resolve(process.env.LOCALAPPDATA ?? '', 'Programs/Ollama/ollama.exe');
const logs = resolve(data, 'reports/llm-20261010', size);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.platform !== 'win32') throw Error('This launcher is for native Windows.');
if (args.some(arg => !['--pull', '--prepare-only', '--verify', '--size=4b', '--size=9b'].includes(arg))) throw Error('Options: --pull, --prepare-only, --verify, --size=4b|9b.');
if (args.includes('--prepare-only') && args.includes('--verify')) throw Error('Choose preparation or verification.');

async function busy(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    const done = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
  });
}
async function resources(initial = false) {
  const ramFreeMiB = Math.round(freemem() / 1048576);
  const { stdout } = await run('nvidia-smi', ['--query-gpu=memory.used,memory.free', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5000 });
  const [gpuUsedMiB, gpuFreeMiB] = stdout.trim().split('\n')[0].split(',').map(Number);
  const ramFloor = initial ? (size === '9b' ? 10240 : 8192) : 4096;
  const gpuFloor = initial ? (size === '9b' ? 11264 : 8192) : 2048;
  if (!Number.isFinite(gpuFreeMiB) || ramFreeMiB < ramFloor || gpuFreeMiB < gpuFloor)
    throw Error(`Insufficient RAM/VRAM headroom: free RAM ${ramFreeMiB} MiB / required ${ramFloor}, free VRAM ${gpuFreeMiB} MiB / required ${gpuFloor}. This LLM phase will stop.`);
  return { at: new Date().toISOString(), ramFreeMiB, gpuUsedMiB, gpuFreeMiB };
}
async function json(path, body, timeout = 10000) {
  if (aborted) throw Error('LLM phase cancelled.');
  const response = await fetch(baseUrl + path, { method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw Error(`Ollama ${path} returned HTTP ${response.status}.`);
  return response.json();
}
const lock = net.createServer(socket => socket.destroy());
lock.listen(19379, '127.0.0.1');
try { await once(lock, 'listening'); } catch { throw Error('Another speech/LLM phase owns port 19379. Stop it first.'); }
const children = []; let closing, monitor, monitorBusy = false, aborted = false, handles = [];
const evidence = { source, model, context, startedAt: new Date().toISOString(), samples: [] };
async function stop() {
  if (closing) return closing;
  aborted = true; clearInterval(monitor);
  closing = (async () => {
    for (const child of children.toReversed()) if (child.exitCode === null && child.pid) {
      try { await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
      catch { if (child.exitCode === null) { console.error('Could not confirm owned process exit: ' + child.pid); process.exitCode = 1; } }
    }
  })();
  return closing;
}
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
function child(file, argv, options = {}) {
  if (aborted) throw Error('LLM phase cancelled before process creation.');
  const proc = spawn(file, argv, { cwd: root, windowsHide: true, ...options }); children.push(proc);
  proc.once('error', error => { console.error(error.message); process.exitCode = 1; void stop(); }); return proc;
}
try {
  await mkdir(logs, { recursive: true }); await access(executable);
  for (const port of [11435, 19380, 9880, 8093]) if (await busy(port)) throw Error(`Port ${port} is occupied. Stop the previous model phase first.`);
  if (await busy(11434)) {
    const response = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const active = await response.json();
    if (!response.ok || !Array.isArray(active.models) || active.models.length) throw Error('The existing Ollama server has a loaded model. Unload it first.');
  }
  evidence.samples.push(await resources(true));
  handles = await Promise.all(['ollama.stdout.log', 'ollama.stderr.log'].map(file => open(resolve(logs, file), 'w')));
  const server = child(executable, ['serve'], { stdio: ['ignore', handles[0].fd, handles[1].fd], env: { ...process.env,
    OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: resolve(data, 'ollama-models'), OLLAMA_NO_CLOUD: '1',
    OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_MAX_QUEUE: '2',
    OLLAMA_CONTEXT_LENGTH: String(context), OLLAMA_KEEP_ALIVE: '60s', OMP_NUM_THREADS: '2' } });
  let ready = false;
  for (let i = 0; i < 60 && !aborted && server.exitCode === null; i++) {
    try { evidence.version = (await json('/api/version')).version; ready = true; break; } catch { await delay(500); }
  }
  if (!ready) throw Error('The owned Ollama server did not start. Inspect its local log.');
  monitor = setInterval(async () => {
    if (monitorBusy || aborted) return; monitorBusy = true;
    try { evidence.samples.push(await resources()); }
    catch (error) { evidence.error = error.message; console.error(error.message); process.exitCode = 1; await stop(); }
    finally { monitorBusy = false; }
  }, 2000);
  if (args.includes('--pull')) {
    const pull = child(executable, ['pull', source], { stdio: ['ignore', handles[0].fd, handles[1].fd],
      env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11435' } });
    console.log(`Downloading the explicit local ${size} Q4 model; inference is not started.`);
    const [code] = await once(pull, 'exit'); if (code !== 0 || aborted) throw Error('Model download failed or was cancelled.');
  }
  const tags = await json('/api/tags');
  if (!tags.models?.some(item => item.name === source)) throw Error('Run this launcher once with --pull --prepare-only to download the selected model.');
  evidence.sourceMetadata = tags.models.find(item => item.name === source);
  await json('/api/create', { model, from: source, stream: false,
    parameters: { num_ctx: context, num_predict: 768, num_thread: 4, temperature: 0.3, seed: 42 } }, 60000);
  console.log(`Ready: ${baseUrl}/v1; model=${model}; context=${context}; parallel=1; cloud disabled.`);
  if (args.includes('--verify')) {
    const test = child(process.execPath, [resolve(root, 'tools/verify-llm-phase.mjs'), `--size=${size}`], { stdio: 'inherit' });
    const [code] = await once(test, 'exit'); if (code !== 0) throw Error('LLM verification failed; see its report.');
  } else if (!args.includes('--prepare-only')) {
    console.log('Type stop + Enter or Ctrl+C to stop this owned server and model. Other Ollama services are left alone.');
    process.stdin.setEncoding('utf8');
    let input = '';
    process.stdin.on('data', chunk => {
      input += chunk;
      let newline;
      while ((newline = input.indexOf('\n')) >= 0) {
        if (input.slice(0, newline).trim().toLowerCase() === 'stop') void stop();
        input = input.slice(newline + 1);
      }
      if (input.length > 1024) input = '';
    });
    process.stdin.resume();
    while (!aborted && server.exitCode === null) await delay(1000);
    if (!aborted && server.exitCode !== 0) throw Error('Owned Ollama server exited unexpectedly.');
  }
} catch (error) { console.error(error.message); evidence.error = error.message; process.exitCode = 1; }
finally {
  await stop();
  process.stdin.pause();
  for (const handle of handles) await handle.close();
  // Keep the shared lock until the main flow can no longer create work.
  lock.close();
  evidence.finishedAt = new Date().toISOString();
  await mkdir(logs, { recursive: true });
  await writeFile(resolve(logs, 'last-phase.json'), JSON.stringify(evidence, null, 2) + '\n');
}
