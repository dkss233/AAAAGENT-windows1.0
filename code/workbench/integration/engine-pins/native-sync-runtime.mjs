import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { engineInventory, here, sha256 } from './runtime.mjs';
import { verifyT3EngineAdapter } from './prepare-t3-adapter.mjs';

/** The previously installed complete graph remains an assembly input after its source lock advances. */
export function verifyNativeSyncAssemblyBaseline(directory) {
  const lock = JSON.parse(readFileSync(join(here, 'native-sync-source.json'), 'utf8'));
  const approved = lock.approved_assembly_baseline;
  if (!approved) return verifyT3EngineAdapter(directory);
  const inventorySha256 = sha256(JSON.stringify(engineInventory(resolve(directory))));
  const receiptPath = join(directory, '.aaaagent-native-sync-build.json');
  if (inventorySha256 !== approved.inventory_sha256 ||
      sha256(readFileSync(join(directory, 'apps/server/dist/bin.mjs'))) !== approved.server_bundle_sha256 ||
      sha256(readFileSync(receiptPath)) !== approved.build_receipt_sha256 ||
      JSON.parse(readFileSync(receiptPath, 'utf8')).sourceLockSha256 !== approved.source_lock_sha256 ||
      sha256(readFileSync(join(here, '../patches/0017-native-session-sync.patch'))) !== approved.source_patch_sha256 ||
      sha256(readFileSync(join(here, '../patches/0018-native-app-forwarded-input.patch'))) !== approved.forwarded_source_patch_sha256)
    throw Error('Approved native assembly baseline changed');
  return { package: approved.package, inventorySha256 };
}

/** Assemble complete reviewed server/web outputs over the immutable cached runtime dependency graph. */
export function prepareNativeSyncRuntime({ source, serverSource, webSource, originalRuntime, target }) {
  for (const path of [source, serverSource, webSource, originalRuntime, target]) if (!resolve(path).includes('/artifacts/runtime/')) throw Error('Owned runtime path required');
  if (existsSync(target)) throw Error('Candidate runtime already exists; verify instead of overwriting');
  const lockPath = join(here, 'native-sync-source.json'), lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const baseline = verifyNativeSyncAssemblyBaseline(originalRuntime);
  const marker = JSON.parse(readFileSync(join(source, '.aaaagent-prepared.json'), 'utf8'));
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: source, maxBuffer: 32 * 1024 * 1024 }).toString().trim();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source }).toString().trim();
  if (commit !== lock.upstream_commit || marker.commit !== lock.upstream_commit ||
      marker.patchSha256 !== lock.patch_sha256 || marker.appliedDiffSha256 !== lock.applied_diff_sha256 ||
      marker.appliedDiffSha256 !== sha256(diff)) throw Error('Fixed complete source mismatch');
  const files = execFileSync('git', ['ls-files', '-z', '--', 'apps/server', 'packages', 'scripts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vite.config.ts', 'tsconfig.base.json'], { cwd: source }).toString().split('\0').filter(Boolean);
  const inputs = {};
  for (const file of files) {
    if (file.includes('/dist/') || file.includes('/node_modules/')) throw Error('Generated source input');
    const bytes = readFileSync(join(source, file));
    if (sha256(bytes) !== sha256(readFileSync(join(serverSource, file)))) throw Error('Compiled source differs: ' + file);
    inputs[file] = sha256(bytes);
  }
  const web = JSON.parse(readFileSync(join(webSource, '.aaa-native-ui.json'), 'utf8'));
  if (web.upstream_commit !== lock.upstream_commit) throw Error('Web assembly upstream mismatch');
  // Backend-only repairs can reuse the fixed UI build when every upstream UI/shared build input is identical.
  const webFiles = execFileSync('git', ['ls-files', '-z', '--', 'apps/web', 'packages', 'scripts', 'patches', 'assets', 'native', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vite.config.ts', 'tsconfig.base.json', 'third-party-licenses.config.json', 'LICENSE'], { cwd: source }).toString().split('\0').filter(Boolean);
  const webInputs = {};
  for (const file of webFiles) {
    const current = sha256(readFileSync(join(source,file)));
    if(current !== sha256(readFileSync(join(web.source,file)))) throw Error('Fixed UI/shared source changed: ' + file);
    webInputs[file] = current;
  }
  const receipt = { version: 1, package: lock.package, sourceLockSha256: sha256(readFileSync(lockPath)), sourceInputsSha256: sha256(JSON.stringify(inputs)),
    webBasePatchSha256: web.patch_sha256, webInputSourceSha256: sha256(JSON.stringify(webInputs)), webAssemblySha256: sha256(readFileSync(join(webSource, '.aaa-native-ui.json'))),
    dependencyInventorySha256: baseline.inventorySha256, upstreamCommit: lock.upstream_commit, patchSha256: lock.patch_sha256 };
  mkdirSync(dirname(target), { recursive: true });
  cpSync(originalRuntime, target, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true });
  rmSync(join(target, 'apps/server/dist'), { recursive: true });
  cpSync(join(serverSource, 'apps/server/dist'), join(target, 'apps/server/dist'), { recursive: true });
  rmSync(join(target, 'apps/web/dist'), { recursive: true, force: true });
  cpSync(join(webSource, 'apps/web/dist'), join(target, 'apps/web/dist'), { recursive: true });
  cpSync(join(source, '.aaaagent-prepared.json'), join(target, '.aaaagent-prepared.json'));
  writeFileSync(join(target, '.aaaagent-native-sync-build.json'), JSON.stringify(receipt, null, 2) + '\n');
  const inventorySha256 = sha256(JSON.stringify(engineInventory(resolve(target))));
  return { ...receipt, inventorySha256, serverBundleSha256: sha256(readFileSync(join(target, 'apps/server/dist/bin.mjs'))) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, serverSource, webSource, originalRuntime, target] = process.argv.slice(2).map(path => resolve(path));
  if (!target) throw Error('Expected fixed source, compiled server source, assembled web, original runtime, target');
  console.log(JSON.stringify(prepareNativeSyncRuntime({ source, serverSource, webSource, originalRuntime, target })));
}
