import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineEnvironment, verifyEngineRuntime } from './runtime.mjs';

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(done => child.once('exit', done)); child.kill('SIGTERM');
  let timer; await Promise.race([exited, new Promise(done => { timer = setTimeout(done, 5000); })]); clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
const wait = ms => new Promise(done => setTimeout(done, ms));

/** Actual engine processes and local transport; the whitelist contains no model/turn operation. */
export async function probeEngines(directory, evidence) {
  const runtime = verifyEngineRuntime(directory), run = join(resolve(evidence), 'protocol-' + randomUUID());
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const home = join(run, 'home'), workspace = join(run, 'workspace');
  for (const p of [home, workspace]) mkdirSync(p, { mode: 0o700 });
  const skill = join(workspace, '.agents/skills/pin-probe'); mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: pin-probe\ndescription: Isolated protocol probe; no tasks.\n---\nRead only.\n');
  const result = { engines: { codex: '0.160.0', dsh: '0.2.0-rc.2' }, run, modelRequests: 0, turnStarts: 0, checks: [], status: 'failed' };
  const env = { ...engineEnvironment(runtime, home), DSH_TELEMETRY_DISABLED: '1', LANG: 'en_US.UTF-8' };
  for (const p of [env.CODEX_HOME, env.DSH_HOME]) mkdirSync(p, { mode: 0o700 });
  const child = spawn(runtime.codexExecutable, ['app-server'], { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0, log = ''; const pending = new Map();
  child.stderr.on('data', b => { log += b; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const value = JSON.parse(line), p = pending.get(value.id); if (!p) return;
    pending.delete(value.id); clearTimeout(p.timer); value.error ? p.reject(Error(JSON.stringify(value.error))) : p.done(value.result); });
  child.on('error', e => { for (const p of pending.values()) p.reject(e); });
  child.on('exit', () => { for (const p of pending.values()) p.reject(Error('Codex exited before the read-only reply')); });
  const rpc = (method, params) => {
    assert.ok(['initialize','skills/list','thread/list','thread/start','thread/read'].includes(method));
    const id = ++seq; return new Promise((done, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('Codex no-model RPC timeout: ' + method)); }, 15000);
      pending.set(id, { done, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  };
  try {
    const initialized = await rpc('initialize', { clientInfo: { name: 'aaaagent_engine_pin_probe', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'); assert.ok(initialized.userAgent);
    const skills = await rpc('skills/list', { cwds: [workspace], forceReload: true });
    assert.ok(JSON.stringify(skills).includes('pin-probe'));
    const before = await rpc('thread/list', { limit: 10, cwd: workspace }); assert.equal(before.data.length, 0);
    const started = await rpc('thread/start', { cwd: workspace, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
    const read = await rpc('thread/read', { threadId: started.thread.id, includeTurns: false });
    assert.equal(read.thread.id, started.thread.id); assert.deepEqual(read.thread.turns, []);
    result.codex = { initialized: true, skillsListed: true, emptyOwnedHome: true, ephemeralSessionRead: true, threadId: read.thread.id };
    result.checks.push('real Codex initialize, skills discovery, owned empty session list and ephemeral session read; zero turns');
  } finally { lines.close(); for (const p of pending.values()) clearTimeout(p.timer); await stop(child);
    writeFileSync(join(run, 'codex-stderr.log'), log, { mode: 0o600 }); }

  const dsh = spawn(runtime.nodeExecutable, [runtime.dshEntrypoint, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; dsh.stdout.on('data', b => { stdout += b; }); dsh.stderr.on('data', b => { stderr += b; });
  try {
    const deadline = Date.now() + 40000; let url;
    while (Date.now() < deadline) {
      const match = stdout.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
      if (match) { url = new URL(match[1]); break; }
      if (dsh.exitCode !== null) throw Error('DSH Host exited; see private startup log'); await wait(100);
    }
    assert.ok(url, 'Actual DSH launch URL required');
    const exchanged = await fetch(url, { redirect: 'manual' }); assert.equal(exchanged.status, 303);
    const cookie = exchanged.headers.get('set-cookie').split(';')[0]; await exchanged.body?.cancel();
    const call = async (method, request) => {
      assert.ok(['session/list','session/modelCatalog','session/create','session/rename','session/selectModel','session/page'].includes(method));
      const rpcId = randomUUID(), args = method === 'session/list' ? { _request: request ?? {} } : request === undefined ? {} : { request };
      const reply = await fetch(url.origin + '/api/' + method, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Cookie: cookie, Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) });
      const value = await reply.json(); assert.equal(reply.status, 200); assert.equal(value.rpcId, rpcId);
      if (!value.result.ok) throw Error(JSON.stringify(value.result.error)); return value.result.value;
    };
    const before = await call('session/list'); assert.equal(before.items.length, 0);
    const catalog = await call('session/modelCatalog'); assert.equal(catalog.sessionModelSelectionVersion, 1);
    const a = 'pin-a-' + randomUUID(), b = 'pin-b-' + randomUUID();
    await call('session/create', { sessionId: a, cwd: workspace }); await call('session/create', { sessionId: b, cwd: workspace });
    await call('session/rename', { sessionId: a, title: 'AAAAGENT isolated engine protocol' });
    const bBefore = (await call('session/list')).items.find(s => s.sessionId === b);
    const selection = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
    const selected = await call('session/selectModel', { sessionId: a, ...selection, scope: 'session' });
    assert.equal(selected.scope, 'session'); assert.deepEqual(selected.selected, selection);
    const after = await call('session/modelCatalog'); assert.deepEqual(after.default, catalog.default);
    const sessions = await call('session/list'); assert.equal(sessions.items.length, 2);
    assert.deepEqual(sessions.items.find(s => s.sessionId === b), bBefore);
    const page = await call('session/page', { address: { kind: 'session', sessionId: a },
      throughSeq: sessions.items.find(s => s.sessionId === a).projections.asOfSeq, maxMessages: 10 });
    assert.ok(!JSON.stringify(page).includes('turn/start'));
    result.dsh = { realHost: true, sessionModelSelectionVersion: 1, sessionCount: 2, defaultsPreserved: true,
      isolatedHome: env.DSH_HOME, authenticatedLocalTransport: true, nativeRouteSelection: selected.selected, providerRequestVerified: false };
    result.checks.push('real matching DSH Host, authenticated session/list/create/rename/page and scoped native model selection; global default preserved, zero prompts');
    result.status = 'passed'; return result;
  } finally { await stop(dsh); writeFileSync(join(run, 'dsh-launch.log'), (stdout + stderr).replace(/(token=)[^\s&)]+/g, '$1[redacted]'), { mode: 0o600 });
    writeFileSync(join(run, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, evidence, ...extra] = process.argv.slice(2); if (!directory || !evidence || extra.length) throw Error('Usage: probe.mjs ENGINE_ROOT EVIDENCE_DIR');
  console.log(JSON.stringify(await probeEngines(directory, evidence), null, 2));
}
