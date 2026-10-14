import { spawn } from 'node:child_process';
import { engineEnvironment, verifyEngineRuntime } from './runtime.mjs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { readCodexSharedConnection } from '../codex-shared-connection.mjs';
import { bridgeCodexSharedStdio } from '../codex-shared-stdio.mjs';

const [root, engine, ...args] = process.argv.slice(2);
if (!root || !['codex','dsh'].includes(engine)) throw Error('Usage: launch.mjs ENGINE_ROOT codex|dsh [ARGS]');
const runtime = verifyEngineRuntime(root);
if (process.execPath !== runtime.nodeExecutable) throw Error('Pinned engine Node required');
// The caller supplies an already fixed project home. No inherited global module loader.
const childEnvironment = { ...process.env, PATH: engineEnvironment(runtime, process.env.HOME || process.env.USERPROFILE).PATH, NODE_PATH: '', NODE_OPTIONS: '' };
// Desktop-origin metadata must not override the actual initializing child client.
if (engine === 'codex') delete childEnvironment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
if (engine === 'codex' && args.includes('--aaaagent-shared-unix')) {
  const projectRoot = resolve(runtime.root, '../../..');
  const connection = readCodexSharedConnection(projectRoot, childEnvironment.CODEX_HOME);
  if (args.length !== 3 || args[0] !== 'app-server' || args[1] !== '--aaaagent-shared-unix' ||
      !connection || args[2] !== connection.socketPath) throw Error('Verified original App shared transport required');
  const modulePath = resolve(projectRoot, 'artifacts/runtime/engine-pin-54/t3-runtime/apps/server/node_modules/ws/index.js');
  const WebSocket = createRequire(import.meta.url)(modulePath);
  const controller = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => controller.abort());
  try { await bridgeCodexSharedStdio({ home: connection.codexHome, WebSocket,
    input: process.stdin, output: process.stdout, signal: controller.signal }); }
  catch { process.stderr.write('Original App shared owner unavailable; no independent writer started\n'); process.exitCode = 1; }
} else {
const child = spawn(engine === 'codex' ? runtime.codexExecutable : runtime.nodeExecutable,
  engine === 'codex' ? args : [runtime.dshEntrypoint, ...args], {
    stdio: 'inherit', env: childEnvironment, windowsHide: true,
  });
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => child.kill(signal));
child.once('error', () => { process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
