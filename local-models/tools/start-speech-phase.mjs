// Keep one selected speech model alive; owned processes are released on Ctrl+C.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freemem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
const root = fileURLToPath(new URL('../', import.meta.url)), data = resolve(root, '../.local/local-models');
const model = process.argv[2];
if (process.platform !== 'win32' || !['sensevoice-small','paraformer-zh','whisper-small','kokoro-82m','gpt-sovits','qwen3-tts-0.6b'].includes(model))
  throw Error('Usage on Windows: node tools/start-speech-phase.mjs MODEL (one of the six speech model IDs).');
const gpu = ['gpt-sovits','qwen3-tts-0.6b'].includes(model), run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function headroom(initial = false) {
  const ramMiB = freemem() / 1048576;
  if (ramMiB < (initial ? 8192 : 4096)) throw Error(`Insufficient free RAM (${Math.round(ramMiB)} MiB); selected model stopped.`);
  if (gpu) {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=memory.free','--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5000 });
    if (Number(stdout.trim().split('\n')[0]) < (initial ? 8192 : 2048)) throw Error('Insufficient free VRAM; selected model stopped.');
  }
}
async function portBusy(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000); const done = busy => { socket.destroy(); resolve(busy); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
  });
}
// Acquire before any model initialization. OS ownership is released even after a
// crash, unlike a stale PID file. Port readiness alone cannot prevent two cold starts.
const phaseLock = net.createServer(socket => socket.destroy());
phaseLock.listen(19379, '127.0.0.1');
try { await once(phaseLock, 'listening'); }
catch { throw Error('Another speech phase owns port 19379. Close it before starting a model.'); }
try {
  for (const port of [19380, 9880, 8093]) if (await portBusy(port)) throw Error(`Port ${port} is occupied. Close the previous speech phase first.`);
  for (const port of [11434, 11435]) if (await portBusy(port)) {
    const response = await fetch(`http://127.0.0.1:${port}/api/ps`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const state = await response.json(); if (!response.ok || !Array.isArray(state.models) || state.models.length) throw Error(`Unload the Ollama model on port ${port} before starting a speech phase.`);
  }
  await headroom(true);
} catch (error) { phaseLock.close(); throw error; }
const children = []; let stopped = false;
async function cleanup() {
  if (stopped) return; stopped = true;
  for (const child of children.toReversed()) if (child.exitCode === null && child.pid)
    await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  phaseLock.close();
}
process.once('SIGINT', () => { void cleanup(); }); process.once('SIGTERM', () => { void cleanup(); });
function start(executable, args, cwd, extra = {}) {
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: 'inherit', env: { ...process.env,
    OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', GRADIO_ANALYTICS_ENABLED: 'False', ...extra } });
  children.push(child); child.once('error', error => { console.error(error.message); process.exitCode = 1; void cleanup(); }); return child;
}
try {
  let backend, health;
  if (model === 'gpt-sovits') {
    // The existing launcher creates the independent stock config when missing.
    backend = start('powershell.exe', ['-NoProfile','-NonInteractive','-File',resolve(root,'tools/start-gpt-sovits.ps1'),'-DataDir',data], root);
    health = 'http://127.0.0.1:9880/openapi.json';
  } else if (model === 'qwen3-tts-0.6b') {
    backend = start(resolve(data, 'venv-qwen/Scripts/python.exe'), [resolve(root, 'python/qwen_service.py')], root);
    health = 'http://127.0.0.1:8093/health';
  }
  if (backend) {
    console.log('Loading only ' + model + '...'); const deadline = Date.now() + 180000; let ready = false;
    while (!stopped && Date.now() < deadline && backend.exitCode === null) {
      await headroom();
      try { ready = (await fetch(health, { signal: AbortSignal.timeout(1500), redirect: 'error' })).ok; } catch {}
      if (ready) break; await delay(2000);
    }
    if (!ready) throw Error('Selected backend did not become ready. Inspect its output above.');
  }
  if (stopped) throw Error('Speech phase cancelled.');
  const verify = process.argv.includes('--verify');
  if (verify && process.argv.includes('--check-only')) throw Error('Choose --verify or --check-only, not both.');
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0 && (!verify || !process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith('--')))
    throw Error('--output DIRECTORY requires --verify.');
  const gateway = start(process.execPath, verify
    ? [resolve(root,'tools/verify-desktop-speech-phase.mjs'),'--model',model,
      ...(outputIndex >= 0 ? ['--output', process.argv[outputIndex + 1]] : [])]
    : [resolve(root,'src/cli.mjs'),'serve','--only-model',model], root);
  console.log('Single model phase: ' + model + '. Ctrl+C releases all processes started by this launcher.');
  if (process.argv.includes('--check-only')) {
    let catalog;
    for (let attempt = 0; attempt < 20 && gateway.exitCode === null; attempt++) {
      try { catalog = await (await fetch('http://127.0.0.1:19380/v1/models', { signal: AbortSignal.timeout(1000) })).json(); break; } catch { await delay(250); }
    }
    if (catalog?.data?.length !== 1 || catalog.data[0].id !== model) throw Error('Single-model catalog check failed.');
    console.log('Single-model catalog verified; releasing owned processes.');
    await cleanup();
  }
  while (!stopped && gateway.exitCode === null) {
    await delay(2000); await headroom();
    if (backend && backend.exitCode !== null) throw Error('Selected speech backend stopped.');
  }
  if (!stopped && gateway.exitCode !== 0) throw Error(`Speech gateway exited with code ${gateway.exitCode}.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await cleanup(); }
