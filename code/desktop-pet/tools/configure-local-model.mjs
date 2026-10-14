// Local adapter for expression-only Live2D rigs (no bundled motion files).
// Derives from tools/configure-model.mjs but does not require Motions.Idle[0].
//
// Usage: node tools/configure-local-model.mjs [--write-catalog]
//
// Without the flag it only reports what it found and the fingerprint it computes.
// With --write-catalog it writes desktop/assets/jellyfish/presets.json.
import { readFile, writeFile, realpath, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const code = fileURLToPath(new URL('..', import.meta.url));
// This rig is loaded by readPresentationCatalog(), which reads this exact directory.
const base = await realpath(resolve(code, 'desktop/assets/jellyfish'));
const writeCatalog = process.argv.includes('--write-catalog');

const refs = JSON.parse(await readFile(resolve(base, 'pet.model3.json'), 'utf8')).FileReferences;
const missing = [];
if (!refs?.Moc) missing.push('Moc');
if (!refs?.Physics) missing.push('Physics');
if (!refs?.DisplayInfo) missing.push('DisplayInfo');
if (!Array.isArray(refs?.Textures) || !refs.Textures.length) missing.push('Textures[]');
if (!Array.isArray(refs?.Expressions) || !refs.Expressions.length) missing.push('Expressions[]');
if (missing.length) throw Error('Rig is missing required fields: ' + missing.join(', ') + '. Adapt the renderer for other rigs.');

// Motions are optional: an expression-only rig holds its pose instead of looping an idle motion.
const motionRefs = refs.Motions ? Object.values(refs.Motions).flat().map((m) => m.File) : [];
if (!motionRefs.length) console.log('note: this rig declares no motions; it will run without a looping idle motion.');

const paths = [...new Set(['pet.model3.json', refs.Moc, refs.Physics, ...refs.Expressions.map((x) => x.File), ...motionRefs])].sort();
const hash = (b) => createHash('sha256').update(b).digest('hex');

let binding = '';
for (const p of [...paths, ...refs.Textures, refs.DisplayInfo]) {
  if (typeof p !== 'string' || p.startsWith('/') || p.split('/').some((x) => !x || x === '.' || x === '..') || /[:%\\]/.test(p))
    throw Error('Unsafe model-relative path: ' + p);
  const actual = await realpath(resolve(base, p)), rel = relative(base, actual);
  if (rel.startsWith('..') || isAbsolute(rel)) throw Error('Model reference escapes its directory: ' + p);
  await access(actual);
  if (paths.includes(p)) binding += p + '\0' + hash(await readFile(actual)) + '\n';
}
const fingerprint = hash(binding);
console.log('fingerprinted files:', paths.length);
console.log('modelFingerprint:', fingerprint);

const examplePath = resolve(code, 'config/presets.example.json');
const catalog = JSON.parse(await readFile(examplePath, 'utf8'));
catalog.modelId = 'local-model';
catalog.modelFingerprint = fingerprint;

// Every expression the rig ships becomes a manual, previewable preset. Nothing is
// auto-enabled: an expression-only rig has no automatic category that is safe to
// switch on by itself (no blink group, no lip-sync group, no idle motion).
catalog.items = refs.Expressions.map((e, i) => ({
  id: 'expr-' + String(e.Name || i).toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
  label: e.Name || 'Expression ' + (i + 1),
  category: 'expression',
  source: 'model-expression',
  availability: 'manual',
  defaultEnabled: false,
  previewable: true,
}));
// A rig with a declared EyeBlink group can blink automatically.
const hasBlink = (JSON.parse(await readFile(resolve(base, 'pet.model3.json'), 'utf8')).Groups ?? [])
  .some((g) => g.Target === 'Parameter' && g.Name === 'EyeBlink' && Array.isArray(g.Ids) && g.Ids.length);
if (hasBlink) catalog.items.unshift({ id: 'proc-blink', label: '自动眨眼', category: 'idle', source: 'procedural', availability: 'automatic', defaultEnabled: true, previewable: true });
else console.log('note: EyeBlink group is empty; automatic blinking is not enabled for this rig.');

if (!writeCatalog) {
  console.log('\ndry run: pass --write-catalog to write ' + relative(code, resolve(base, 'presets.json')));
  console.log('planned catalog items:');
  for (const item of catalog.items) console.log('  ', JSON.stringify(item));
} else {
  // flag:'wx' semantics preserved: never clobber a hand-authored catalog.
  try {
    await access(resolve(base, 'presets.json'));
    throw Error('presets.json already exists; delete it first to rebind this rig.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await writeFile(resolve(base, 'presets.json'), JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
  console.log('\nwrote ' + relative(code, resolve(base, 'presets.json')));
}
