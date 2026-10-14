import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const markerName = '.aaaagent-codex.json';
export const codexLock = JSON.parse(readFileSync(join(here, 'codex-source.json'), 'utf8'));
export const codexDirectory = `artifacts/runtime/codex-${codexLock.version}-${codexLock.target}-${codexLock.archiveSha256.slice(0, 12)}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function inventory(directory, prefix = '') {
  const entries = {};
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw Error('Invalid Codex directory');
  for (const name of readdirSync(directory).sort()) {
    if (!prefix && name === markerName) continue;
    const path = join(directory, name), stat = lstatSync(path), relative = prefix + name;
    if (stat.isSymbolicLink()) throw Error('Codex runtime contains a symbolic link');
    if (stat.isDirectory()) Object.assign(entries, inventory(path, relative + '/'));
    else if (stat.isFile()) entries[relative] = hash(readFileSync(path));
    else throw Error('Codex runtime contains an unsupported file');
  }
  return entries;
}

export function verifyCodex(directory, lock = codexLock) {
  const markerPath = join(directory, markerName);
  if (!lstatSync(markerPath).isFile() || lstatSync(markerPath).isSymbolicLink()) throw Error('Invalid Codex marker');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (JSON.stringify(marker.source) !== JSON.stringify(lock)) throw Error('Codex source lock changed');
  const files = inventory(directory);
  if (JSON.stringify(files) !== JSON.stringify(marker.files)) throw Error('Codex runtime changed');
  const metadata = JSON.parse(readFileSync(join(directory, 'codex-package.json'), 'utf8'));
  if (metadata.version !== lock.version || metadata.target !== lock.target || metadata.entrypoint !== lock.entrypoint ||
      !files[lock.entrypoint] || process.platform !== 'win32' && !(lstatSync(join(directory, lock.entrypoint)).mode & 0o111)) throw Error('Codex package layout mismatch');
  return marker;
}

export function prepareCodex(root, archive) {
  const target = resolve(root, codexDirectory);
  if (existsSync(target)) return { status: 'reused', directory: target, ...verifyCodex(target) };
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Pinned Codex package requires Windows x64');
  mkdirSync(dirname(target), { recursive: true });
  const stage = join(dirname(target), '.codex-prepare-' + randomUUID());
  mkdirSync(stage, { mode: 0o700 });
  try {
    const downloaded = join(stage, 'download.tar.gz');
    if (!archive) execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '180',
      '--output', downloaded, codexLock.url], { stdio: ['ignore', 'ignore', 'pipe'] });
    const input = archive ? resolve(archive) : downloaded;
    if (hash(readFileSync(input)) !== codexLock.archiveSha256) throw Error('Codex archive digest mismatch');
    // Only the exact official archive is extracted. Validate names before extracting it.
    const names = execFileSync('tar', ['-tzf', input], { encoding: 'utf8' }).trim().split('\n');
    if (names.some(name => name.startsWith('/') || name.split('/').includes('..'))) throw Error('Invalid Codex archive path');
    const unpacked = join(stage, 'unpacked'); mkdirSync(unpacked);
    execFileSync('tar', ['-xzf', input, '-C', unpacked]);
    const files = inventory(unpacked);
    writeFileSync(join(unpacked, markerName), JSON.stringify({ source: codexLock, files }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const marker = verifyCodex(unpacked);
    const version = execFileSync(join(unpacked, codexLock.entrypoint), ['--version'], { encoding: 'utf8' }).trim();
    if (version !== `codex-cli ${codexLock.version}`) throw Error('Codex executable version mismatch');
    renameSync(unpacked, target);
    return { status: 'prepared', directory: target, ...marker };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--archive')) throw Error('Usage: prepare-codex.mjs [--archive PATH]');
  console.log(JSON.stringify(prepareCodex(resolve(here, '../../..'), args[1]), null, 2));
}
