import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCodex, codexLock } from '../prepare-codex.mjs';
import { prepareDshController } from '../dsh-controller.mjs';
// The session-entry navigation is a client plugin now (copied below), not a patch of DSH's bundle.
import { engineDirectory, engineInventory, engineLock, here, sha256, verifyEngineRuntime } from './runtime.mjs';

function checkedArchive(name, downloads) {
  const pin = engineLock[name], file = join(downloads, name + (pin.url.endsWith('.zip') ? '.zip' : '.tar.gz'));
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    const partial = file + '.partial-' + randomUUID();
    try {
      execFileSync(process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '180',
        '--output', partial, pin.url], { stdio: ['ignore', 'ignore', 'pipe'] });
      if (sha256(readFileSync(partial)) !== pin.sha256) throw Error('Engine archive digest mismatch');
      renameSync(partial, file);
    } finally { rmSync(partial, { force: true }); }
  }
  if (sha256(readFileSync(file)) !== pin.sha256) throw Error('Engine archive digest mismatch');
  return file;
}

/** Assemble exact archives and npm lock into an unused owned directory. Never changes source pins. */
export async function assembleEngines(stage, { downloads, cache }) {
  if (`${process.platform}-${process.arch}` !== engineLock.target) throw Error('Engine lock requires ' + engineLock.target);
  if (existsSync(stage)) throw Error('Unused engine stage required');
  if (codexLock.version !== engineLock.codex.version || codexLock.archiveSha256 !== engineLock.codex.sha256 ||
      sha256(readFileSync(join(here, 'package-lock.json'))) !== engineLock.dsh.packageLockSha256 ||
      sha256(readFileSync(join(here, '../dsh-controller-source.json'))) !== engineLock.dsh.controllerSourceSha256)
    throw Error('Inconsistent engine/dependency/adapter locks');
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const nodeArchive = checkedArchive('node', downloads);
  const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar';
  const nodeTarget = process.platform === 'win32' ? 'win-' + process.arch : engineLock.target;
  const names = execFileSync(tar, ['-tf', nodeArchive], { encoding: 'utf8' }).trim().split(/\r?\n/);
  if (names.some(n => n.startsWith('/') || n.split('/').includes('..') || !n.startsWith(`node-v${engineLock.node.version}-${nodeTarget}/`)))
    throw Error('Unexpected Node archive layout');
  const nodeRoot = join(stage, 'node'); mkdirSync(nodeRoot);
  execFileSync(tar, ['-xf', nodeArchive, '-C', nodeRoot, '--strip-components=1']);
  const node = join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'bin/node'), npm = join(nodeRoot, process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');
  if (execFileSync(node, ['--version'], { encoding: 'utf8' }).trim() !== `v${engineLock.node.version}` ||
      execFileSync(node, [npm, '--version'], { encoding: 'utf8' }).trim() !== engineLock.node.npm)
    throw Error('Engine Node/npm version mismatch');
  const prepared = prepareCodex(stage, checkedArchive('codex', downloads));
  renameSync(prepared.directory, join(stage, 'codex')); rmSync(join(stage, 'artifacts'), { recursive: true });
  const dsh = join(stage, 'dsh'); mkdirSync(dsh);
  for (const name of ['package.json', 'package-lock.json']) cpSync(join(here, name), join(dsh, name));
  const npmHome = join(dirname(stage), '.engine-npm-home-' + randomUUID()); mkdirSync(npmHome, { mode: 0o700 });
  for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(npmHome, name), '', { flag: 'wx', mode: 0o600 });
  try {
    // Lifecycle scripts and implicit global configuration cannot alter this graph.
    execFileSync(node, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], {
      cwd: dsh, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, HOME: npmHome, USERPROFILE: npmHome, PATH: dirname(node) + delimiter + (process.env.PATH || process.env.Path || ''), npm_config_cache: cache,
        npm_config_userconfig: join(npmHome, 'user.npmrc'), npm_config_globalconfig: join(npmHome, 'global.npmrc'), npm_config_update_notifier: 'false' },
    });
  } finally { rmSync(npmHome, { recursive: true, force: true }); }
  const controller = join(dsh, 'node_modules/@deepseek-ai/dsh-api-session-controller'), patched = controller + '.aaaagent-patched';
  await prepareDshController(controller, patched);
  rmSync(controller, { recursive: true }); renameSync(patched, controller);
  // Session-entry navigation ships as our own client plugin, so the published DSH browser bundle is
  // left byte-identical: no textual patching and no resulting hash to re-pin on every upgrade.
  const sessionEntry = resolve(here, '../../../desktop-pet/plugins/dsh-session-entry');
  if (!existsSync(join(sessionEntry, 'lib/client.js'))) throw Error('Session entry plugin missing');
  cpSync(sessionEntry, join(dsh, 'node_modules/@aaaagent/dsh-session-entry'), { recursive: true });
  const files = engineInventory(stage);
  writeFileSync(join(stage, '.aaaagent-engine.json'), JSON.stringify({ engines: engineLock, files }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { inventorySha256: sha256(JSON.stringify(files)), fileCount: Object.keys(files).length };
}

export async function prepareEngines(projectRoot, options = {}) {
  const target = resolve(projectRoot, engineDirectory);
  if (existsSync(target)) return { status: 'reused', ...verifyEngineRuntime(target) };
  // Require the reviewed inventory before fetching or installing a production candidate.
  const source = JSON.parse(readFileSync(join(here, 'runtime-source.json'), 'utf8'));
  if (source.lockSha256 !== sha256(readFileSync(join(here, 'engine-lock.json'))) ||
      source.packageLockSha256 !== sha256(readFileSync(join(here, 'package-lock.json')))) throw Error('Engine source changed');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const stage = target + '.stage-' + randomUUID();
  try {
    await assembleEngines(stage, { downloads: options.downloads ?? resolve(projectRoot, 'artifacts/runtime/engine-downloads'),
      cache: options.cache ?? resolve(projectRoot, 'artifacts/runtime/engine-npm-cache') });
    verifyEngineRuntime(stage); renameSync(stage, target);
    return { status: 'prepared', ...verifyEngineRuntime(target) };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, ...extra] = process.argv.slice(2);
  if (!root || extra.length) throw Error('Usage: prepare.mjs PROJECT_ROOT');
  console.log(JSON.stringify(await prepareEngines(resolve(root)), null, 2));
}
