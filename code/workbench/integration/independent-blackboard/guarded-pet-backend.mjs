import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PetDeviceGate } from './pet-device-gate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const directory = resolve(root, 'artifacts/W0-I/model-evaluation/trial/isolated-device-gate');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const gate = new PetDeviceGate(directory);
const child = spawn(process.execPath, [resolve(root, 'code/desktop-pet/dist/app/trial-backend.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
let nativeConnected = true;
const send = value => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify(value) + '\n'); };
const log = (direction, value) => {
  const record = structuredClone(value);
  if (record.audioBase64) {
    const bytes = Buffer.from(record.audioBase64, 'base64');
    record.audioBytes = bytes.length; record.audioSha256 = createHash('sha256').update(bytes).digest('hex');
    delete record.audioBase64;
  }
  appendFileSync(resolve(directory, 'protocol.jsonl'), JSON.stringify({ at: new Date().toISOString(), direction, ...record }) + '\n', { mode: 0o600 });
};
const incoming = createInterface({ input: process.stdin });
incoming.on('line', line => {
  try { const value = JSON.parse(line); gate.input(value); log('native-to-backend', value); send(value); }
  catch { child.kill('SIGTERM'); }
});
const outgoing = createInterface({ input: child.stdout });
outgoing.on('line', line => {
  try {
    const value = JSON.parse(line); gate.observe(value); log('backend-to-native', value);
    if (!nativeConnected) return;
    if (gate.admit(value)) process.stdout.write(line + '\n');
    else {
      log('device-denied', { channel: value.channel, requestId: value.requestId, devicePlayed: false });
      send({ channel: 'rpc_error', requestId: value.requestId, scope: value.scope ?? value.tts.scope,
        message: 'Isolated test device output is not authorized.' });
    }
  } catch { child.kill('SIGTERM'); }
});
// Keep draining the original child's output while its normal cleanup releases
// its owner lock. A closed native pipe must not crash the instrumentation first.
incoming.once('close', () => { nativeConnected = false; child.stdin.end(); });
process.stdout.on('error', error => {
  nativeConnected = false; incoming.close(); child.stdin.end();
  if (error.code !== 'EPIPE') child.kill('SIGTERM');
});
child.stdin.on('error', () => { nativeConnected = false; incoming.close(); child.kill('SIGTERM'); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { nativeConnected = false; incoming.close(); child.kill(signal); });
child.once('error', () => { process.stderr.write('Isolated original backend unavailable.\n'); process.exit(1); });
child.once('exit', code => process.exit(code ?? 1));
