import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const lock = JSON.parse(readFileSync(join(here, 't3-source.json'), 'utf8'));
const patchDirs = [join(root, 'code/workbench/patches'), join(here, 'patches')];
const patchFiles = patchDirs.flatMap(directory => existsSync(directory)
  ? readdirSync(directory).filter(name => name.endsWith('.patch')).sort().map(name => join(directory, name))
  : []);
const patchName = (filename) => filename.slice(root.length + 1).replaceAll('\\', '/');
const digest = createHash('sha256');
for (const filename of patchFiles) {
  digest.update(patchName(filename));
  digest.update(readFileSync(filename));
}
const patchSha256 = digest.digest('hex');
const target = join(root, 'artifacts/runtime', `t3-${lock.commit.slice(0, 8)}-${patchSha256.slice(0, 12)}`);
const markerName = '.aaaagent-prepared.json';
const expected = { repository: lock.repository, commit: lock.commit, licenseSha256: lock.licenseSha256,
  patchSha256, patches: patchFiles.map(patchName) };

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  return result.stdout.trim();
}
function sha256(filename) { return createHash('sha256').update(readFileSync(filename)).digest('hex'); }
function diffSha256(directory) { return createHash('sha256').update(git(directory, 'diff', '--binary', 'HEAD')).digest('hex'); }
function verify(directory) {
  if (git(directory, 'rev-parse', 'HEAD') !== lock.commit) throw new Error('T3 commit does not match lock');
  if (sha256(join(directory, 'LICENSE')) !== lock.licenseSha256) throw new Error('T3 MIT license does not match lock');
}

if (process.argv.includes('--verify-source')) {
  const position = process.argv.indexOf('--verify-source');
  const directory = process.argv[position + 1];
  if (!directory) throw new Error('--verify-source requires an existing checkout path');
  verify(resolve(directory));
  process.stdout.write(JSON.stringify({ status: 'source_verified', commit: lock.commit, licenseSha256: lock.licenseSha256 }) + '\n');
  process.exit(0);
}
const localSourceIndex = process.argv.indexOf('--local-source');
const localSource = localSourceIndex < 0 ? undefined : process.argv[localSourceIndex + 1];
if (localSourceIndex >= 0 && (!localSource || process.argv.length !== 4)) throw new Error('--local-source requires one existing checkout');
if (localSourceIndex < 0 && process.argv.length > 2) throw new Error('Unexpected arguments');
if (localSource) verify(resolve(localSource));
if (existsSync(target)) {
  const marker = JSON.parse(readFileSync(join(target, markerName), 'utf8'));
  const { appliedDiffSha256, ...base } = marker;
  if (JSON.stringify(base) !== JSON.stringify(expected) ||
      (appliedDiffSha256 === undefined && patchFiles.length > 0) ||
      (appliedDiffSha256 !== undefined && diffSha256(target) !== appliedDiffSha256) ||
      (appliedDiffSha256 === undefined && git(target, 'diff', '--name-only', 'HEAD'))) {
    throw new Error('Existing prepared T3 directory does not match lock and patch state');
  }
  verify(target);
  process.stdout.write(JSON.stringify({ status: 'reused', path: target, ...expected }) + '\n');
  process.exit(0);
}
mkdirSync(dirname(target), { recursive: true });
const temporary = join(dirname(target), `.prepare-${randomUUID()}`);
try {
  if (localSource) {
    git(dirname(temporary), 'clone', '--quiet', '--shared', '--no-checkout', resolve(localSource), temporary);
    git(temporary, 'checkout', '--quiet', '--detach', lock.commit);
  } else {
    mkdirSync(temporary);
    git(temporary, 'init', '-q');
    git(temporary, 'remote', 'add', 'origin', lock.repository);
    git(temporary, 'fetch', '--quiet', '--filter=blob:none', '--depth=1', 'origin', lock.commit);
    git(temporary, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
  }
  verify(temporary);
  for (const filename of patchFiles) {
    git(temporary, 'apply', '--check', filename);
    git(temporary, 'apply', filename);
  }
  // Include newly added public source files in the fixed full diff fingerprint.
  git(temporary, 'add', '--intent-to-add', '.');
  if (sha256(join(temporary, 'LICENSE')) !== lock.licenseSha256) throw new Error('Patch changed T3 license');
  writeFileSync(join(temporary, markerName), JSON.stringify({ ...expected, appliedDiffSha256: diffSha256(temporary) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, target);
  process.stdout.write(JSON.stringify({ status: 'prepared', path: target, ...expected }) + '\n');
} catch (error) {
  if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  throw error;
}
