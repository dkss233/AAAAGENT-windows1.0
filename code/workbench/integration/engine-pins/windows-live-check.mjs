/** Explicit Windows acceptance runner. Only isolated projects, no automatic replay. */
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { engineEnvironment, engineDirectory, verifyEngineRuntime } from './runtime.mjs';
import { T3ChildService } from '../t3-child-service.mjs';
import { T3HttpClient } from '../t3-http-client.mjs';
import { restrictPrivatePathSync } from '../../../desktop-pet/dist/core/platform-files.js';
import { nativePresetHostOverlay } from '../../../desktop-pet/dist/harness/preset.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const runtime = verifyEngineRuntime(join(root, engineDirectory));
const run = join(root, '.local/validation-20261010/live-' + new Date().toISOString().replaceAll(':', '-'));
const home = join(run, 'home'), t3Home = join(run, 't3-home'), sourceDir = join(root, 't3-source');
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
for (const dir of [run, home, t3Home, join(home, '.codex'), join(home, '.dsh')]) { mkdirSync(dir, { recursive: true }); restrictPrivatePathSync(dir); }
copyFileSync(join(process.env.USERPROFILE, '.codex/auth.json'), join(home, '.codex/auth.json'));
// A provider key is read directly into the isolated process, never printed or copied into evidence.
const config = JSON.parse(readFileSync(resolve(root, '../../.local/aaaagent-secrets/config.local.json'), 'utf8'));
const key = readFileSync(config.models.dialogue.credentialFile, 'utf8').trim();
const env = { ...process.env, ...engineEnvironment(runtime, home), DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: key };
const overlay = join(run, 'dsh-presets.patch.yml');
writeFileSync(overlay, nativePresetHostOverlay({ dshHome: env.DSH_HOME, projectRoot: root, nodeExecutable: runtime.nodeExecutable, managementDescriptor: join(run, 'unused-management.json') }));
const dshLog = join(run, 'dsh-host.private.log');
const dsh = spawn(runtime.nodeExecutable, [runtime.dshEntrypoint, 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let dshText = ''; const update = bytes => { dshText += bytes; writeFileSync(dshLog, dshText); };
dsh.stdout.on('data', update); dsh.stderr.on('data', update);
const delay = ms => new Promise(done => setTimeout(done, ms));
const waitFor = async (fn, timeout = 240000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(2000); } throw Error('Bounded readback timeout; never resend automatically'); };
await waitFor(() => { if(dsh.exitCode !== null) throw Error('DSH startup failed; private log retained'); return /dsh web:/.test(dshText); }, 45000);
const sourceLock = JSON.parse(readFileSync(join(root, 'code/workbench/integration/t3-source.json')));
const nativeLock = JSON.parse(readFileSync(join(root, 'code/workbench/integration/engine-pins/native-sync-source.json')));
save(join(sourceDir, '.aaaagent-prepared.json'), { commit: sourceLock.commit, licenseSha256: sourceLock.licenseSha256, patchSha256: nativeLock.patch_sha256 });
save(join(t3Home, 'userdata/settings.json'), { providers: Object.fromEntries(['codex','claudeAgent','cursor','grok','opencode','antigravity'].map(p => [p, { enabled: false }])),
  providerInstances: { codex: { driver: 'codex', enabled: true, config: { binaryPath: runtime.codexExecutable, homePath: env.CODEX_HOME } }, dsh: { driver: 'dsh', enabled: true, config: { agentPreset: 'desktop-pet-work-v1' } } } });
Object.assign(process.env, engineEnvironment(runtime, home));
const service = new T3ChildService({ sourceDir, nodeExecutable: runtime.nodeExecutable, baseDir: t3Home, logFile: join(run, 't3.log'), dshWebLogPath: dshLog });
const client = new T3HttpClient(service);
const result = { status: 'running', startedAt: new Date().toISOString(), run, versions: { node: '24.13.1', codex: '0.160.0', dsh: '0.2.0-rc.2', t3: sourceLock.commit }, tasks: [] };
save(join(run, 'result.json'), result);
console.log(JSON.stringify({ stage: 'ready', run }));
try {
  await service.start();
  for (const provider of (process.argv.includes('--only-dsh') ? ['dsh'] : ['codex', 'dsh'])) {
    const catalog = await client.providerModels(provider); save(join(run, provider + '-models.json'), catalog);
    const selected = catalog.providers.find(p => p.instanceId === provider);
    if (!selected || selected.status !== 'ready' || !selected.models.length) throw Error(provider + ' model catalogue unavailable');
    const model = provider === 'dsh' ? selected.models.find(m => m.id === 'deepseek-official/deepseek-flash') : selected.models.find(m => /gpt-6.*(mini|luna)/i.test(m.id)) ?? selected.models.find(m => /gpt-6/i.test(m.id)) ?? selected.models[0];
    if (!model) throw Error('Pinned DSH model unavailable');
    const workspace = join(run, provider); mkdirSync(workspace);
    execFileSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true });
    const projectId = randomUUID(), threadId = randomUUID();
    const modelSelection = { instanceId: provider, model: model.id, ...(provider === 'dsh' && model.reasoningEfforts?.length ? { options: [{ id: 'reasoningEffort', value: model.defaultReasoningEffort ?? model.reasoningEfforts[0].id }] } : {}) };
    const task = { provider, workspace, projectId, threadId, model: model.id, rounds: [] }; result.tasks.push(task);
    await client.createCommand({ type: 'project.create', commandId: randomUUID(), projectId, title: 'Windows actual ' + provider, workspaceRoot: workspace, createdAt: new Date().toISOString() });
    await client.createCommand({ type: 'thread.create', commandId: randomUUID(), threadId, projectId, title: 'Windows actual task', modelSelection, runtimeMode: 'full-access', interactionMode: 'default', branch: null, worktreePath: null, createdAt: new Date().toISOString() });
    const prompts = [
      'Only modify your current working directory. Use your native file tools to create result.json containing exactly {"add":5,"scale":20,"branch":17,"merge":37}. Then read it back and report the actual four values. Do not use network, subagents, or any other folder.',
      'Read the result.json you created in our previous turn. Create followup.txt in the same directory containing exactly "5 -> 20; 17; final=37". Read it back and report it. Do not create another result.json or touch other directories.',
    ];
    for (const [index, text] of prompts.entries()) {
      const commandId = randomUUID(), messageId = randomUUID();
      const round = { index: index + 1, commandId, messageId, input: text, sentAt: new Date().toISOString() }; task.rounds.push(round);
      // Save IDs before sending; after an uncertain response query this ID, never recreate it.
      save(join(run, 'result.json'), result);
      try { await client.dispatch({ type: 'thread.turn.start', commandId, threadId, message: { messageId, role: 'user', text, attachments: [] }, modelSelection, runtimeMode: 'full-access', interactionMode: 'default', createdAt: round.sentAt }); }
      catch (error) { round.transportError = error.code || error.message; const receipt = await client.readReceipt(commandId); if (receipt?.status !== 'accepted') throw error; }
      const snapshot = await waitFor(async () => { const s = await client.threadSnapshot(threadId); const turn = s.thread.latestTurn; const current = turn && Date.parse(turn.requestedAt) >= Date.parse(round.sentAt); if (current && turn.state === 'failed' || s.thread.activities.some(a => a.kind === 'provider.turn.start.failed' && a.payload?.requestId === messageId)) { save(join(run, provider + '-failed.json'), s); throw Error(provider + ' actual turn failed'); } return current && s.thread.messages.some(m => m.id === messageId) && turn.state === 'completed' ? s : null; });
      save(join(run, provider + '-round-' + (index + 1) + '.json'), snapshot);
      const db = new DatabaseSync(join(t3Home, 'userdata/state.sqlite'), { readOnly: true });
      try { const binding = db.prepare('SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id=?').get(threadId); const cursor = JSON.parse(binding.resume_cursor_json); round.nativeSid = cursor.threadId ?? cursor.sessionId; } finally { db.close(); }
      round.completedAt = new Date().toISOString(); round.receipt = await client.readReceipt(commandId);
      if (index && round.nativeSid !== task.rounds[0].nativeSid) throw Error('Native SID changed on continuation');
      const path = join(workspace, index ? 'followup.txt' : 'result.json');
      if (!existsSync(path)) throw Error('Native task did not create expected output');
      round.output = readFileSync(path, 'utf8').trim();
      if (!index && JSON.stringify(JSON.parse(round.output)) !== '{"add":5,"scale":20,"branch":17,"merge":37}') throw Error('Result file values differ');
      if (index && round.output !== '5 -> 20; 17; final=37') throw Error('Followup file differs');
      save(join(run, 'result.json'), result);
      console.log(JSON.stringify({ provider, round: index + 1, nativeSid: round.nativeSid, output: round.output }));
    }
  }
  result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = error.message; console.log(JSON.stringify({ status: result.status, error: result.error, run })); process.exitCode = 1; }
finally {
  await service.stop(); dsh.kill('SIGTERM');
  result.completedAt = new Date().toISOString(); save(join(run, 'result.json'), result);
  writeFileSync(dshLog, dshText.replace(/(token=)[^\s&)]+/g, '$1[redacted]'));
  setTimeout(() => process.exit(process.exitCode || 0), 1000).unref();
}
