import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineInventory, sha256 } from '../../../../workbench/integration/engine-pins/runtime.mjs';
import { T3_RUNTIME, T3_ADAPTER_LOCK, prepareT3RendererUpdate } from '../../../../workbench/integration/engine-pins/t3-renderer-update.mjs';
import { isTrialRuntimePath } from '../../../dist/app/trial-config.js';
import { inspectTrialUpdate, installTrialUpdate } from '../../../tools/install-trial-update.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const quiet = async () => {};
async function fixture(t) {
  const parent = resolve(project, 'artifacts/W0-I/web-execution-56/cross-page-draft-snapshot-01/update-fixtures');
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(resolve(parent, 'native-renderer-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = resolve(temp, 'root'), candidate = resolve(temp, 'candidate');
  const put = async (base, p, data) => { await mkdir(dirname(resolve(base, p)), { recursive: true }); await writeFile(resolve(base, p), data); };
  const old = T3_RUNTIME + '/apps/web/dist/assets/old.js', fresh = T3_RUNTIME + '/apps/web/dist/assets/new.js';
  const index = T3_RUNTIME + '/apps/web/dist/index.html', profile = 'artifacts/runtime/engine-profile.json';
  const required = ['dist/app/trial-backend.js', 'dist/app/trial-launcher.js', 'desktop/build/renderer.js', 'desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet'].map(p => 'code/desktop-pet/' + p);
  for (const base of [root, candidate]) {
    for (const p of required) await put(base, p, 'unchanged application');
    await put(base, profile, 'same profile');
    await put(base, index, base === root ? 'old index' : 'new index');
    await put(base, base === root ? old : fresh, base === root ? 'old asset' : 'new asset');
    await put(base, T3_RUNTIME + '/apps/server/dist/bin.mjs', 'unchanged engine');
    const inventorySha256 = sha256(JSON.stringify(engineInventory(resolve(base, T3_RUNTIME))));
    await put(base, T3_ADAPTER_LOCK, JSON.stringify({ nativeSyncRuntime: { inventorySha256 } }));
  }
  const chat = { provider: 'dashscope', model: 'controlled', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    credentialFile: '/nonexistent-key', reservationMicros: 100000, inputTokenLimit: 100, outputTokenLimit: 100, inputMicrosPerToken: 1, outputMicrosPerToken: 1 };
  const pins = {};
  for (const p of [...required, profile, T3_ADAPTER_LOCK, index, T3_RUNTIME + '/apps/server/dist/bin.mjs']) pins[p] = sha256(await readFile(resolve(root, p)));
  const c = { version: 1, projectRoot: root, phaseId: 'local-trial-update-fixture', purpose: 'user-trial', sourceRevision: 'a'.repeat(40), runtimeFiles: pins,
    database: resolve(root, 'artifacts/W0-I/model-evaluation/trial/user-trial/state.sqlite'), budgetFile: resolve(root, 'artifacts/W0-I/model-evaluation/budget.json'),
    budgetBatchId: 'original', limitMicros: 20000000, phaseLimitMicros: 20000000, maxCalls: 6,
    operationLimits: { dialogue: 1, admission: 1, memory_turn: 1, summary: 1, perception: 1, tts: 1 },
    memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
    models: { dialogue: chat, admission: chat, summary: chat, perception: chat, memory_turn: { ...chat, provider: 'deepseek', endpoint: 'https://api.deepseek.com/chat/completions' },
      tts: { ...chat, endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', characterMicros: 1 } } };
  const configFile = 'artifacts/W0-I/model-evaluation/trial/user-trial/config.json', activationFile = 'artifacts/W0-I/model-evaluation/trial/user-trial/activation.json';
  const raw = JSON.stringify(c), activation = JSON.stringify({ version: 1, phaseId: c.phaseId, status: 'active', configSha256: sha256(raw) });
  const budget = JSON.stringify({ batchId: 'original', limitMicros: 20000000, entries: [{ operationId: 'old', status: 'settled' }] });
  await put(root, configFile, raw); await put(root, activationFile, activation); await put(root, 'artifacts/W0-I/model-evaluation/budget.json', budget);
  await put(root, 'artifacts/W0-I/model-evaluation/trial/user-trial/state.sqlite', 'preserved user data');
  const candidatePins = { [T3_ADAPTER_LOCK]: sha256(await readFile(resolve(candidate, T3_ADAPTER_LOCK))) };
  const transition = prepareT3RendererUpdate(root, candidate, pins, candidatePins);
  const nextPins = {}, files = [];
  for (const p of [...new Set([...Object.keys(pins), ...transition.paths])]) {
    const after = sha256(await readFile(resolve(candidate, p))); nextPins[p] = after;
    let before = null; try { before = sha256(await readFile(resolve(root, p))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!pins[p] || before !== after) files.push({ path: p, before, after });
  }
  const next = JSON.stringify({ ...c, sourceRevision: 'b'.repeat(40), runtimeFiles: nextPins });
  await put(candidate, 'next.json', next);
  const plan = { version: 1, projectRoot: root, candidateRoot: candidate, currentConfigSha256: sha256(raw), currentActivationSha256: sha256(activation),
    nextConfigFile: resolve(candidate, 'next.json'), nextConfigSha256: sha256(next), files, activateOnSuccess: true, retiredRuntimePaths: [], t3RendererUpdate: transition };
  return { root, candidate, old, fresh, c, raw, budget, configFile, activationFile, transition, plan, put };
}

test('normal update retires authenticated previously unpinned native assets, backs up bytes, pins the new complete renderer and preserves user state', async t => {
  const f = await fixture(t);
  const installed = await installTrialUpdate(f.plan, { quiescent: quiet });
  assert.equal(installed.status, 'installed_active');
  assert.equal(installed.retiredRendererFiles, 1);
  assert.equal(await readFile(resolve(installed.backup, f.old), 'utf8'), 'old asset');
  await assert.rejects(readFile(resolve(f.root, f.old)), { code: 'ENOENT' });
  assert.equal(await readFile(resolve(f.root, f.fresh), 'utf8'), 'new asset');
  assert.equal(sha256(JSON.stringify(engineInventory(resolve(f.root, T3_RUNTIME)))), f.transition.afterInventorySha256);
  assert.equal(await readFile(f.c.database, 'utf8'), 'preserved user data');
  assert.equal(await readFile(f.c.budgetFile, 'utf8'), f.budget);
  assert.equal((await installTrialUpdate(f.plan, { quiescent: quiet })).status, 'already_active');
});

test('failure after native asset retirement restores the exact old complete graph and leaves activation prepared', async t => {
  const f = await fixture(t);
  await assert.rejects(installTrialUpdate(f.plan, { quiescent: quiet, afterWrite: async p => { if (p === f.old) throw Error('controlled retirement failure'); } }), /controlled retirement failure/);
  assert.equal(sha256(JSON.stringify(engineInventory(resolve(f.root, T3_RUNTIME)))), f.transition.beforeInventorySha256);
  assert.equal(await readFile(resolve(f.root, f.configFile), 'utf8'), f.raw);
  assert.equal(JSON.parse(await readFile(resolve(f.root, f.activationFile), 'utf8')).status, 'prepared');
  assert.equal(await readFile(f.c.database, 'utf8'), 'preserved user data');
  assert.equal(await readFile(f.c.budgetFile, 'utf8'), f.budget);
});

for (const defect of ['old-graph-tamper', 'retirement-omission', 'candidate-dependency-change']) test(`refuse ${defect} before any writes`, async t => {
  const f = await fixture(t), activation = await readFile(resolve(f.root, f.activationFile));
  if (defect === 'old-graph-tamper') await f.put(f.root, f.old, 'unreviewed old asset');
  if (defect === 'retirement-omission') f.plan.t3RendererUpdate = { ...f.transition, retired: [] };
  if (defect === 'candidate-dependency-change') {
    await f.put(f.candidate, T3_RUNTIME + '/auth.json', 'unregistered');
    await f.put(f.candidate, T3_ADAPTER_LOCK, JSON.stringify({ nativeSyncRuntime: { inventorySha256: sha256(JSON.stringify(engineInventory(resolve(f.candidate, T3_RUNTIME)))) } }));
    f.plan.files.find(x => x.path === T3_ADAPTER_LOCK).after = sha256(await readFile(resolve(f.candidate, T3_ADAPTER_LOCK)));
    const next = JSON.parse(await readFile(f.plan.nextConfigFile)); next.runtimeFiles[T3_ADAPTER_LOCK] = f.plan.files.find(x => x.path === T3_ADAPTER_LOCK).after;
    const raw = JSON.stringify(next); await writeFile(f.plan.nextConfigFile, raw); f.plan.nextConfigSha256 = sha256(raw);
  }
  await assert.rejects(inspectTrialUpdate(f.plan, quiet), /Complete engine graph|renderer transition|non-renderer graph/);
  assert.ok(activation.equals(await readFile(resolve(f.root, f.activationFile))));
  assert.equal(await readFile(f.c.budgetFile, 'utf8'), f.budget);
});

test('native renderer admission rejects credentials, arbitrary server paths and traversal', () => {
  for (const p of [T3_RUNTIME + '/auth.json', T3_RUNTIME + '/apps/server/dist/arbitrary.js', T3_RUNTIME + '/apps/web/dist/auth.json',
    T3_RUNTIME + '/apps/web/dist/assets/../auth.json']) assert.equal(isTrialRuntimePath(p), false);
  assert.equal(isTrialRuntimePath(T3_RUNTIME + '/apps/web/dist/assets/new.js'), true);
});
