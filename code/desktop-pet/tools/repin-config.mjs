// Re-pin the prepared configuration to the current runtime files, in place.
//
// The launcher refuses to start when any hashed runtime file changed ("试用程序文件缺失或
// 已变化"). Rebuilding the desktop shell always changes those files, so this tool updates
// config.json's runtimeFiles/sourceRevision (and the matching activation digest) without
// touching credentials, model settings or the database.
//
// It refuses to change the *set* of pinned paths: if a build added or removed a runtime
// file, run the full first-run setup instead.
//
// Usage:
//   node tools/repin-config.mjs --check      # report staleness only
//   node tools/repin-config.mjs [--activate] # rewrite the pair (status: active)
import { readFile, writeFile, readdir, realpath, rename, unlink, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { relative, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = resolve(root, process.platform === 'win32'
  ? '.local/model-evaluation/trial/user-trial'
  : 'artifacts/W0-I/model-evaluation/trial/user-trial');
const configFile = resolve(directory, 'config.json');
const activationFile = resolve(directory, 'activation.json');
const checkOnly = process.argv.includes('--check');
const activate = process.argv.includes('--activate');
const hash = value => createHash('sha256').update(value).digest('hex');

// Same scan the first-run setup performs. Keeping it byte-identical matters: the set of
// pinned paths must match what setup would pin, or this tool would refuse every run.
// The cost is dominated by dist/ + desktop/ (69 MB); tools/ adds only ~0.4 MB.
async function runtimePins(projectRoot) {
  const files = {};
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('runtime_symlink: ' + file);
      if (entry.isDirectory()) { if (!['node_modules', '.cache', '.git'].includes(entry.name)) await scan(file); }
      else if (entry.isFile()) files[relative(projectRoot, file).split('\\').join('/')] = hash(await readFile(file));
    }
  }
  await scan(resolve(projectRoot, 'code/desktop-pet/dist'));
  await scan(resolve(projectRoot, 'code/desktop-pet/desktop'));
  await scan(resolve(projectRoot, 'code/desktop-pet/tools'));
  return files;
}

async function exists(p) { try { await lstat(p); return true; } catch { return false; } }

if (!await exists(configFile) || !await exists(activationFile)) {
  process.stderr.write('No prepared configuration pair. Run the first-run setup first.\n');
  process.exit(1);
}

const originalRaw = await readFile(configFile, 'utf8');
const config = JSON.parse(originalRaw);
const activation = JSON.parse(await readFile(activationFile, 'utf8'));
if (config.projectRoot !== root) {
  process.stderr.write(`Configuration belongs to ${config.projectRoot}, not ${root}.\n`);
  process.exit(1);
}

const pinned = Object.keys(config.runtimeFiles ?? {});
const observed = await runtimePins(config.projectRoot);
const observedPaths = Object.keys(observed);

const added = observedPaths.filter(p => !config.runtimeFiles[p]);
const removed = pinned.filter(p => !observed[p]);
const changed = observedPaths.filter(p => config.runtimeFiles[p] && config.runtimeFiles[p] !== observed[p]);

// A build may add or retire files (a new module, a dropped asset). Re-pinning the whole observed
// set keeps that recoverable in one command instead of forcing a full first-run setup; the
// additions and removals are reported so an unexpected one is still visible. Removals are safe
// to accept because the config is re-signed as a pair below.
const setChanged = [...added, ...removed];
if (setChanged.length) {
  process.stderr.write(`Pinned path set changed (added ${added.length}, removed ${removed.length}).\n`);
  for (const p of added.slice(0, 10)) process.stderr.write('  + ' + p + '\n');
  for (const p of removed.slice(0, 10)) process.stderr.write('  - ' + p + '\n');
}

if (!checkOnly && (changed.length || setChanged.length)) {
  const next = { ...config, runtimeFiles: observed, sourceRevision: hash(JSON.stringify(observed)).slice(0, 40) };
  const raw = JSON.stringify(next, null, 2) + '\n';

  // Atomic pair update: config must never be visible without its matching activation.
  const tempConfig = configFile + '.' + randomUUID() + '.next';
  const tempActivation = activationFile + '.' + randomUUID() + '.next';
  try {
    await writeFile(tempConfig, raw, { mode: 0o600 });
    await writeFile(tempActivation, JSON.stringify({ ...activation, status: activate ? 'active' : activation.status, configSha256: hash(raw) }) + '\n', { mode: 0o600 });
    await rename(tempConfig, configFile);
    await rename(tempActivation, activationFile);
  } catch (error) {
    await unlink(tempConfig).catch(() => {});
    await unlink(tempActivation).catch(() => {});
    throw error;
  }
  await realpath(configFile);
}

const total = changed.length + setChanged.length;
const status = total === 0 ? 'already current' : checkOnly ? 'stale' : 'repinned';
process.stdout.write(JSON.stringify({
  status, changed: changed.length, added: added.length, removed: removed.length, pinned: Object.keys(observed).length,
  sourceRevision: (total && !checkOnly ? hash(JSON.stringify(observed)) : config.sourceRevision).slice(0, 12),
  activation: !checkOnly && total ? (activate ? 'active' : activation.status) : activation.status,
  sample: [...changed, ...setChanged].slice(0, 5),
}, null, 2) + '\n');
process.exitCode = checkOnly && total ? 2 : 0;
