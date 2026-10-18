// Bundle and run the hidden-expression fade rig test the same way the other desktop rig tests run.
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const out = resolve('../../artifacts/W1/hidden-fade');
await mkdir(out, { recursive: true });
const dir = await mkdtemp(join(out, 'run-'));
try {
  const entry = join(dir, 'test.mjs');
  await build({ entryPoints: ['desktop/tests/hidden-fade-rig.test.mjs'], bundle: true, platform: 'node',
    format: 'esm', target: 'node22', outfile: entry, logLevel: 'warning', external: ['node:*'] });
  execFileSync(process.execPath, ['--test', entry], { stdio: 'inherit' });
} finally {
  await rm(dir, { recursive: true, force: true });
}
