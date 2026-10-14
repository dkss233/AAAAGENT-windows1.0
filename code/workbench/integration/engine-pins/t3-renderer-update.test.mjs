import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineInventory, sha256 } from './runtime.mjs';
import { prepareT3RendererUpdate, assertT3RendererUpdate, T3_RUNTIME, T3_ADAPTER_LOCK } from './t3-renderer-update.mjs';
import { isTrialRuntimePath } from '../../../desktop-pet/dist/app/trial-config.js';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
function fixture(t, { webChanged = true, extra } = {}) {
  const parent = join(workspace, 'artifacts/runtime'); mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, 'reviewed-server-companions-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'root'), candidate = join(temporary, 'candidate');
  const prefix = 'apps/server/dist/', old = prefix + 'claudeHistoryWorker-x3U5XeOc.mjs', next = prefix + 'claudeHistoryWorker-ChEliiLX.mjs';
  const inputs = { 'apps/web/dist/index.html': 'existing renderer', 'apps/web/dist/assets/original.js': 'old asset',
    'apps/server/dist/bin.mjs': 'old server', 'apps/server/dist/claude-history-worker.mjs': 'old wrapper',
    'apps/server/dist/claude-history-worker.mjs.map': 'old wrapper map', [old]: 'old shared chunk', [old + '.map']: 'old chunk map' };
  const outputs = { ...inputs, 'apps/server/dist/bin.mjs': 'new server', 'apps/server/dist/claude-history-worker.mjs': 'new wrapper',
    'apps/server/dist/claude-history-worker.mjs.map': 'new wrapper map', [next]: 'new shared chunk', [next + '.map']: 'new chunk map' };
  delete outputs[old]; delete outputs[old + '.map'];
  if (webChanged) { delete outputs['apps/web/dist/assets/original.js']; outputs['apps/web/dist/assets/current.js'] = 'new asset'; }
  if (extra) outputs[extra] = 'unreviewed resource';
  const write = (directory, files) => {
    for (const [path, bytes] of Object.entries(files)) { const file = join(directory, T3_RUNTIME, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); }
    const inventorySha256 = sha256(JSON.stringify(engineInventory(join(directory, T3_RUNTIME))));
    const lock = join(directory, T3_ADAPTER_LOCK); mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ nativeSyncRuntime: { inventorySha256 } }));
    return { 'artifacts/runtime/engine-profile.json': sha256('explicit controlled engine profile'), [T3_ADAPTER_LOCK]: sha256(readFileSync(lock)) };
  };
  return { root, candidate, beforePins: write(root, inputs), afterPins: write(candidate, outputs), old, next };
}

for (const webChanged of [true, false]) test(`exact compiled companion transition with webChanged=${webChanged} is pinned and retires only authenticated old files`, t => {
  const f = fixture(t, { webChanged }), plan = prepareT3RendererUpdate(f.root, f.candidate, f.beforePins, f.afterPins);
  assert.ok(plan); assert.ok(plan.paths.includes(T3_RUNTIME + '/' + f.next));
  assert.ok(plan.paths.includes(T3_RUNTIME + '/' + f.next + '.map')); assert.ok(plan.paths.every(isTrialRuntimePath));
  assert.deepEqual(plan.retired.filter(row => row.path.includes('/apps/server/')).map(row => row.path).sort(),
    [T3_RUNTIME + '/' + f.old, T3_RUNTIME + '/' + f.old + '.map'].sort());
  assert.ok(plan.retired.every(row => /^[a-f0-9]{64}$/.test(row.before)));
  const next = { runtimeFiles: { ...f.afterPins, ...Object.fromEntries(plan.paths.map(path => [path, sha256(readFileSync(join(f.candidate, path)))])) } };
  assert.deepEqual(assertT3RendererUpdate({ projectRoot: f.root, candidateRoot: f.candidate, t3RendererUpdate: plan },
    { runtimeFiles: f.beforePins }, next), plan);
  delete next.runtimeFiles[T3_RUNTIME + '/' + f.next];
  assert.throws(() => assertT3RendererUpdate({ projectRoot: f.root, candidateRoot: f.candidate, t3RendererUpdate: plan }, { runtimeFiles: f.beforePins }, next), /pin missing/);
});

test('a declared graph still rejects unrelated dependencies, private resources and unreviewed generated chunks', t => {
  for (const extra of ['apps/server/dist/claudeHistoryWorker-unreviewed.mjs', 'node_modules/private/index.js', 'auth.json']) {
    const f = fixture(t, { extra });
    assert.throws(() => prepareT3RendererUpdate(f.root, f.candidate, f.beforePins, f.afterPins), /unregistered/);
  }
});

test('changed chunk bytes and a forged retirement fail before a reviewed transition is returned', t => {
  const f = fixture(t), plan = prepareT3RendererUpdate(f.root, f.candidate, f.beforePins, f.afterPins);
  const pins = { runtimeFiles: { ...f.afterPins, ...Object.fromEntries(plan.paths.map(path => [path, 'a'.repeat(64)])) } };
  const forged = { ...plan, retired: [...plan.retired, { path: 'data/user.sqlite', before: 'a'.repeat(64) }] };
  assert.throws(() => assertT3RendererUpdate({ projectRoot: f.root, candidateRoot: f.candidate, t3RendererUpdate: forged }, { runtimeFiles: f.beforePins }, pins), /transition differs/);
  writeFileSync(join(f.candidate, T3_RUNTIME, f.next), 'changed reviewed bytes');
  assert.throws(() => prepareT3RendererUpdate(f.root, f.candidate, f.beforePins, f.afterPins), /graph differs/);
});
