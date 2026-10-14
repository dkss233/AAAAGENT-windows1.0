/** Run after integration has applied common patch 0007 and the W3 provider projection patch. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.argv[2] ?? '');
const reactor = join(root, 'apps/server/src/orchestration/Layers/ProviderCommandReactor.ts');
const contract = join(root, 'packages/contracts/src/orchestration.ts');
if (!process.argv[2] || !existsSync(reactor) || !existsSync(contract)) {
  throw new Error('Usage: node w3-provider-projection-54.test.mjs <patched-t3-root>');
}
if (!readFileSync(contract, 'utf8').includes('ProviderOnlyProjectContext') ||
    !readFileSync(reactor, 'utf8').includes('Frozen project context does not match this turn.')) {
  throw new Error('Apply common patch 0007 and the W3 provider projection patch first.');
}
if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Run with the pinned T3 Node 24 toolchain.');
}

const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
for (const [binary, args] of [
  ['node_modules/.bin/vp', ['test', 'run', 'apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts']],
  ['node_modules/.bin/tsc', ['--noEmit', '-p', 'apps/server/tsconfig.json']],
]) {
  const result = spawnSync(join(root, binary), args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
