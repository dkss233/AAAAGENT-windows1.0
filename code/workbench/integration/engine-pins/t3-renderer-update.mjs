import { readFileSync, lstatSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { engineInventory, sha256 } from './runtime.mjs';

export const T3_RUNTIME = 'artifacts/runtime/engine-pin-54/t3-runtime';
export const T3_ADAPTER_LOCK = 'code/workbench/integration/engine-pins/t3-adapter-source.json';
const web = 'apps/web/dist/';
// Exact companions of the reviewed original and B57 compiled server graph.
// A different generated chunk needs its own reviewed source/runtime pin.
const companions = new Set(['claude-history-worker.mjs', 'claude-history-worker.mjs.map',
  'claudeHistoryWorker-x3U5XeOc.mjs', 'claudeHistoryWorker-x3U5XeOc.mjs.map',
  'claudeHistoryWorker-ChEliiLX.mjs', 'claudeHistoryWorker-ChEliiLX.mjs.map'].map(name => 'apps/server/dist/' + name));
for (const name of ['claudeHistoryWorker-Bz1ZNa3x.mjs', 'claudeHistoryWorker-Bz1ZNa3x.mjs.map',
  'claudeHistoryWorker-CNFf2jAS.mjs', 'claudeHistoryWorker-CNFf2jAS.mjs.map'])
  companions.add('apps/server/dist/' + name);
const support = new Set(['.aaaagent-prepared.json', '.aaaagent-native-sync-build.json',
  'apps/server/dist/bin.mjs', 'apps/server/dist/bin.mjs.map', ...companions]);
const safe = p => !p.split('/').some(x => !x || x === '.' || x === '..');
export const isT3RendererPath = p => typeof p === 'string' && safe(p) &&
  p.startsWith(T3_RUNTIME + '/' + web) && /^(?:assets\/[A-Za-z0-9._/-]+|\.vite\/manifest\.json|index\.html|aaa-native-read-build\.json|favicon(?:-16x16|-32x32)?\.(?:png|ico)|apple-touch-icon\.png|third-party-licenses\.json|manifest\.webmanifest)$/.test(p.slice((T3_RUNTIME + '/' + web).length));
const plain = (root, path) => {
  const file = resolve(root, path);
  for (let p = file; p !== root; p = dirname(p)) if (lstatSync(p).isSymbolicLink()) throw Error('Engine update input cannot follow links');
  if (!lstatSync(file).isFile()) throw Error('Engine update input must be a file');
  return readFileSync(file);
};

/** The pinned adapter lock authenticates the entire graph, including old unpinned static files. */
export function inspectT3UpdateGraph(root, pins) {
  const lockBytes = plain(root, T3_ADAPTER_LOCK);
  if (pins[T3_ADAPTER_LOCK] !== sha256(lockBytes)) throw Error('Engine adapter lock differs from runtime pin');
  const lock = JSON.parse(lockBytes), inventory = engineInventory(resolve(root, T3_RUNTIME));
  const inventorySha256 = sha256(JSON.stringify(inventory));
  if (![lock.adaptedInventorySha256, lock.nativeSyncRuntime?.inventorySha256].includes(inventorySha256))
    throw Error('Complete engine graph differs from pinned adapter lock');
  return { inventory, inventorySha256 };
}

/** Only renderer files and exact reviewed server bundles may differ; dependencies/auth remain fixed. */
export function prepareT3RendererUpdate(root, candidate, currentPins, candidatePins) {
  if (!currentPins['artifacts/runtime/engine-profile.json']) return null;
  const before = inspectT3UpdateGraph(root, currentPins), after = inspectT3UpdateGraph(candidate, candidatePins);
  const changed = [...new Set([...Object.keys(before.inventory), ...Object.keys(after.inventory)])].sort()
    .filter(p => JSON.stringify(before.inventory[p]) !== JSON.stringify(after.inventory[p]));
  for (const p of changed) if (!support.has(p) && !isT3RendererPath(T3_RUNTIME + '/' + p))
    throw Error('Engine update changes an unregistered non-renderer graph resource');
  const webChanged = changed.some(p => p.startsWith(web)), companionChanges = changed.filter(p => companions.has(p));
  if (!webChanged && !companionChanges.length) return null;
  const paths = [...Object.keys(after.inventory).filter(p => webChanged && p.startsWith(web)),
    ...companionChanges.filter(p => after.inventory[p])].map(p => T3_RUNTIME + '/' + p);
  if (!paths.length || paths.some(p => (!isT3RendererPath(p) && !companions.has(p.slice(T3_RUNTIME.length + 1))) || !after.inventory[p.slice(T3_RUNTIME.length + 1)]?.sha256))
    throw Error('Candidate renderer has unsupported resources');
  const retired = Object.keys(before.inventory).filter(p => (p.startsWith(web) || companions.has(p)) && !after.inventory[p]).map(p => {
    if ((!companions.has(p) && (!p.startsWith(web + 'assets/') || !isT3RendererPath(T3_RUNTIME + '/' + p))) || !before.inventory[p]?.sha256)
      throw Error('Only exact authenticated renderer assets may retire');
    return { path: T3_RUNTIME + '/' + p, before: before.inventory[p].sha256 };
  });
  return { version: 1, beforeInventorySha256: before.inventorySha256,
    afterInventorySha256: after.inventorySha256, paths, retired };
}

export function assertT3RendererUpdate(plan, current, next) {
  const actual = prepareT3RendererUpdate(plan.projectRoot, plan.candidateRoot, current.runtimeFiles, next.runtimeFiles);
  if (JSON.stringify(actual) !== JSON.stringify(plan.t3RendererUpdate ?? null)) throw Error('Exact engine renderer transition differs from reviewed plan');
  if (actual && actual.paths.some(p => !next.runtimeFiles[p])) throw Error('Engine renderer runtime pin missing');
  return actual;
}
