import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineInventory, here, sha256 } from './runtime.mjs';
import { verifyT3EngineAdapter } from './prepare-t3-adapter.mjs';

const ignored = new Set(['node_modules', '.git', 'dist', 'dist-exe', '.generated', '.vite', '.turbo', 'coverage', '.aaaagent-prepared.json']);
function sourceInventory(root) {
  const files = {};
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (ignored.has(entry.name)) continue;
      const key = prefix + entry.name, file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('Source fingerprint requires ordinary files');
      if (entry.isDirectory()) visit(file, key + '/');
      else if (entry.isFile()) files[key] = sha256(readFileSync(file));
    }
  }
  visit(root); return files;
}
function locatePackage(name, from, sourceRoot) {
  for (const base of createRequire(join(from, 'package.json')).resolve.paths(name) ?? []) {
    const file = join(base, name, 'package.json');
    if (existsSync(file)) return realpathSync(dirname(file));
  }
  // pnpm keeps undeclared transitive packages in its virtual store, without a root link.
  const store = join(sourceRoot, 'node_modules/.pnpm');
  const matches = readdirSync(store).filter(entry => entry.startsWith(name.replace('/', '+') + '@'))
    .map(entry => join(store, entry, 'node_modules', name)).filter(path => existsSync(join(path, 'package.json')));
  if (matches.length === 1) return realpathSync(matches[0]);
  throw Error('Missing installed runtime dependency: ' + name);
}
function platformMatches(value, actual) {
  if (!Array.isArray(value)) return true;
  if (value.includes('!' + actual)) return false;
  const positive = value.filter(x => !x.startsWith('!'));
  return !positive.length || positive.includes(actual);
}

/** Package only existing Windows build outputs and installed runtime dependencies; never install or rebuild. */
export function packageWindowsT3Runtime(source, target) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Windows x64 packaging required');
  source = realpathSync(source); target = resolve(target);
  if (existsSync(target)) throw Error('Runtime target already exists; retain it and choose a fresh target');
  for (const name of ['apps/server/dist/bin.mjs', 'apps/web/dist/index.html']) if (!statSync(join(source, name)).isFile()) throw Error('Build output missing');
  const sourceFiles = sourceInventory(source);
  mkdirSync(target, { recursive: true });
  cpSync(join(source, 'apps/server/dist'), join(target, 'apps/server/dist'), { recursive: true, dereference: true });
  cpSync(join(source, 'apps/web/dist'), join(target, 'apps/web/dist'), { recursive: true, dereference: true });
  cpSync(join(source, 'apps/web/dist'), join(target, 'apps/server/dist/client'), { recursive: true, dereference: true });
  cpSync(join(source, 'apps/server/package.json'), join(target, 'apps/server/package.json'));
  cpSync(join(source, 'LICENSE'), join(target, 'LICENSE'));
  const packages = new Map(), modules = join(target, 'apps/server/node_modules');
  function copyPackage(name, from, optional = false) {
    let directory;
    try { directory = locatePackage(name, from, source); } catch (error) { if (optional) return; throw error; }
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (!platformMatches(pkg.os, 'win32') || !platformMatches(pkg.cpu, 'x64')) {
      if (optional) return;
      throw Error('Runtime dependency has the wrong platform: ' + name);
    }
    const previous = packages.get(name);
    if (previous) { if (previous !== pkg.version) throw Error('Runtime dependency version conflict: ' + name); return; }
    packages.set(name, pkg.version);
    cpSync(directory, join(modules, name), { recursive: true, dereference: true,
      filter: path => path === directory || !['node_modules', '.git'].includes(path.slice(directory.length + 1).split(/[\\/]/)[0]) });
    for (const child of Object.keys(pkg.dependencies ?? {}).sort()) copyPackage(child, directory);
    for (const child of Object.keys(pkg.optionalDependencies ?? {}).sort()) copyPackage(child, directory, true);
  }
  // ws is also consumed directly by the companion's authenticated local bridge.
  for (const name of ['node-pty', '@ff-labs/fff-node', 'ws']) copyPackage(name, join(source, 'apps/server'));
  return writeWindowsRuntimeLock(target, sourceFiles, packages);
}

function writeWindowsRuntimeLock(target, sourceFiles, packages) {
  const sourceLock = JSON.parse(readFileSync(join(here, '../t3-source.json'), 'utf8'));
  const nativeLock = JSON.parse(readFileSync(join(here, 'native-sync-source.json'), 'utf8'));
  const marker = { commit: sourceLock.commit, licenseSha256: sourceLock.licenseSha256, patchSha256: nativeLock.patch_sha256 };
  if (sha256(readFileSync(join(target, 'LICENSE'))) !== marker.licenseSha256) throw Error('T3 license pin changed');
  writeFileSync(join(target, '.aaaagent-prepared.json'), JSON.stringify(marker, null, 2) + '\n');
  const sourceReceipt = { version: 1, platform: 'win32', arch: 'x64', sourceCommit: sourceLock.commit,
    importedProjectRevision: '3798c0e6da49fc03dec6a0b05bb4beb46d99edfe',
    patchSha256: marker.patchSha256, files: sourceFiles, packages: Object.fromEntries([...packages].sort()) };
  const sourceReceiptBytes = JSON.stringify(sourceReceipt, null, 2) + '\n';
  writeFileSync(join(here, 'windows-t3-source.json'), sourceReceiptBytes);
  const inventory = engineInventory(target), lockFile = join(here, 't3-adapter-source.json');
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  lock.windowsRuntime = { version: 1, package: 'AAAAGENT-WINDOWS-T3-20261010', platform: 'win32', arch: 'x64',
    sourceCommit: sourceLock.commit, sourceLockSha256: sha256(sourceReceiptBytes),
    inventorySha256: sha256(JSON.stringify(inventory)), serverBundleSha256: sha256(readFileSync(join(target, 'apps/server/dist/bin.mjs'))),
    markerSha256: sha256(readFileSync(join(target, '.aaaagent-prepared.json'))) };
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  return { target, packageCount: packages.size, fileCount: Object.keys(inventory).length,
    sourceFileCount: Object.keys(sourceFiles).length, inventorySha256: lock.windowsRuntime.inventorySha256 };
}

/** Refresh the server after a reviewed source fix without replacing the normal web renderer. */
export function refreshWindowsT3Server(source, target) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Windows x64 packaging required');
  source = realpathSync(source); target = realpathSync(target);
  verifyT3EngineAdapter(target);
  const receipt = JSON.parse(readFileSync(join(here, 'windows-t3-source.json'), 'utf8'));
  const sourceDirectory = join(source, 'apps/server/dist'), targetDirectory = join(target, 'apps/server/dist');
  const output = readdirSync(sourceDirectory, { withFileTypes: true });
  if (!output.some(entry => entry.name === 'bin.mjs' && entry.isFile()) || output.some(entry => !entry.isFile() || !/\.mjs(?:\.map)?$/.test(entry.name)))
    throw Error('Expected only ordinary server bundle files');
  const names = new Set(output.map(entry => entry.name));
  for (const entry of readdirSync(targetDirectory, { withFileTypes: true })) {
    if (entry.name === 'client' && entry.isDirectory()) continue;
    if (!entry.isFile() || !/\.mjs(?:\.map)?$/.test(entry.name)) throw Error('Unexpected runtime server file');
    if (!names.has(entry.name)) unlinkSync(join(targetDirectory, entry.name));
  }
  for (const name of names) cpSync(join(sourceDirectory, name), join(targetDirectory, name));
  return writeWindowsRuntimeLock(target, sourceInventory(source), new Map(Object.entries(receipt.packages)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(here, '../../../..');
  const refresh = process.argv[2] === '--refresh-server', args = process.argv.slice(refresh ? 3 : 2);
  console.log(JSON.stringify((refresh ? refreshWindowsT3Server : packageWindowsT3Runtime)(args[0] ?? join(root, 't3-source'),
    args[1] ?? join(root, 'artifacts/runtime/engine-pin-54/t3-runtime'))));
}
