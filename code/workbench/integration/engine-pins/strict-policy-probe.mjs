import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { engineEnvironment, verifyEngineRuntime } from './runtime.mjs';

// Diagnostic only: private empty home, ephemeral metadata, no turn/model RPC.
const [engineRoot, evidenceRoot] = process.argv.slice(2);
assert.ok(engineRoot && evidenceRoot && process.argv.length === 4);
const engine = verifyEngineRuntime(engineRoot), evidence = resolve(evidenceRoot);
const home = join(evidence, 'home'), cwd = join(evidence, 'workspace');
for (const path of [evidence, home, cwd]) mkdirSync(path, { recursive: true, mode: 0o700 });
const env = engineEnvironment(engine, home);
mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
writeFileSync(join(env.CODEX_HOME, 'config.toml'), `approvals_reviewer = "user"\nsandbox_mode = "danger-full-access"\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`, { mode: 0o600 });
const child = spawn(engine.codexExecutable, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(), notifications = []; let sequence = 0, stderr = '';
child.stderr.on('data', data => { stderr += data; });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const value = JSON.parse(line), waiter = pending.get(value.id);
  if (!waiter) { notifications.push(value); return; }
  pending.delete(value.id); clearTimeout(waiter.timer); waiter.resolve(value);
});
const rpc = (method, params) => {
  assert.ok(['initialize', 'thread/start', 'thread/read'].includes(method));
  if (method === 'thread/start') assert.equal(params.ephemeral, true);
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Metadata timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
};
const result = { engine: '0.160.0', ephemeral: true, sharedHomeMutated: false, turnStarts: 0, modelRequests: 0, cases: [] };
try {
  const initialized = await rpc('initialize', { clientInfo: { name: 'aaaagent_strict_policy_metadata_probe', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  assert.ok(initialized.result?.userAgent); child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  for (const [name, overrides] of [
    ['trusted-home-omitted-policy', {}],
    ['explicit-untrusted', { approvalPolicy: 'untrusted' }],
    ['config-untrusted', { config: { approval_policy: 'untrusted' } }],
  ]) {
    const params = { cwd, ephemeral: true, sandbox: 'read-only', approvalsReviewer: 'user', ...overrides };
    const response = await rpc('thread/start', params);
    const read = response.result?.thread?.id ? await rpc('thread/read', { threadId: response.result.thread.id, includeTurns: false }) : null;
    result.cases.push({ name, params, response, read });
    if (response.result) assert.deepEqual(response.result.thread.turns, []);
    if (read?.result) assert.deepEqual(read.result.thread.turns, []);
  }
} finally {
  child.stdin.end(); child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  if (child.exitCode === null && child.signalCode === null) await new Promise(done => child.once('exit', done));
  clearTimeout(timeout); lines.close();
  for (const item of pending.values()) clearTimeout(item.timer);
  result.notifications = notifications;
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(evidence, 'stderr.log'), stderr, { mode: 0o600 });
}
console.log(JSON.stringify(result.cases.map(({ name, response, read }) => ({ name, error: response.error, policy: response.result?.approvalPolicy, reviewer: response.result?.approvalsReviewer, sandbox: response.result?.sandbox, turns: response.result?.thread?.turns.length, metadataReadError: read?.error })), null, 2));
