/** Run against fixed T3 c13f7d93 with common patches 0001-0008 already applied. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.argv[2] ?? '');
const proof = join(root, 'apps/server/src/orchestration/ProviderContextProof.ts');
const engine = join(root, 'apps/server/src/orchestration/Layers/OrchestrationEngine.ts');
if (!process.argv[2] || !existsSync(proof) || !existsSync(engine) ||
    !readFileSync(engine, 'utf8').includes('verifyProviderContextProof')) {
  throw new Error('Usage: node provider-proof-54.test.mjs <T3 root patched through 0008>');
}
if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Run with the pinned T3 Node 24 toolchain.');
}
const environment = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
for (const [binary, args] of [
  ['node_modules/.bin/vp', ['test', 'run',
    'apps/server/src/orchestration/ProviderContextProof.test.ts',
    'apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts']],
  ['node_modules/.bin/tsc', ['--noEmit', '-p', 'apps/server/tsconfig.json']],
]) {
  const result = spawnSync(join(root, binary), args, { cwd: root, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
