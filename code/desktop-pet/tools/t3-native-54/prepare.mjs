import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolRoot = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(toolRoot, '../../../..');
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return resolve(args[index + 1]);
}
const source = option('--source', undefined);
if (!source) throw new Error('Supply --source with the exact pinned upstream checkout; see SOURCE.json');
const overlay = option('--overlay', join(workspace, 'code/desktop-pet/t3-native'));
// tools lives in code/desktop-pet/tools; the default stays in this registered tree.
const taskRoot = workspace;
const output = option('--output', join(taskRoot, 'artifacts/runtime/t3-native-ui-54'));
const preparedLock = option('--prepared-source-lock', undefined);
const pins = JSON.parse(readFileSync(preparedLock ?? join(overlay, 'SOURCE.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...a) => execFileSync('git', ['-C', source, ...a], { maxBuffer: 32 * 1024 * 1024 });
if (git('rev-parse', 'HEAD').toString().trim() !== pins.upstream_commit || sha(git('diff', '--binary', 'HEAD').toString().trim()) !== pins.applied_diff_sha256) {
  throw new Error('Fixed native source differs from SOURCE.json');
}
if (preparedLock) {
  const marker = JSON.parse(readFileSync(join(source, '.aaaagent-prepared.json'), 'utf8'));
  if (marker.commit !== pins.upstream_commit || marker.patchSha256 !== pins.patch_sha256 || marker.appliedDiffSha256 !== pins.applied_diff_sha256 || sha(readFileSync(join(source, 'LICENSE'))) !== marker.licenseSha256) throw new Error('Prepared source marker differs from fixed build lock');
}
for (const [file, expected] of Object.entries(pins.upstream_package_hashes)) {
  if (sha(readFileSync(join(source, file))) !== expected) throw new Error(`Fixed build input differs: ${file}`);
}
if (output === source || output.startsWith(source + '/') || !output.startsWith(join(taskRoot, 'artifacts/runtime/'))) throw new Error('Output must be this task artifacts/runtime');
if (existsSync(output)) {
  const receipt = JSON.parse(readFileSync(join(output, '.aaa-native-ui.json'), 'utf8'));
  if (receipt.source !== source || receipt.upstream_commit !== pins.upstream_commit) throw new Error('Existing output belongs to another source');
} else mkdirSync(output, { recursive: true });

const roots = ['apps/web', 'apps/server', 'packages', 'scripts', 'patches', 'assets', 'native', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vite.config.ts', 'tsconfig.base.json', 'third-party-licenses.config.json', 'LICENSE', 'apps/desktop/package.json', 'apps/mobile/modules/t3-markdown-text/LICENSE', 'apps/mobile/modules/t3-composer-editor/LICENSE'];
const files = git('ls-files', '-z', '--', ...roots).toString().split('\0').filter(Boolean);
let copied = 0;
for (const file of files) {
  if (/(^|\/)(node_modules|\.env(?:\..*)?|\.git|dist|data)(\/|$)/.test(file)) throw new Error(`Private/generated tracked input: ${file}`);
  const from = join(source, file);
  if (!existsSync(from) || lstatSync(from).isSymbolicLink()) throw new Error(`Missing/non-regular source: ${file}`);
  const to = join(output, file);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to); copied++;
}
// The endpoint belongs to the authenticated AAA mount. Assemble its DTO and
// typed client into the copied contracts without changing the original backend.
const independentContract = join(workspace, 'code/workbench/integration/independent-blackboard/t3-contracts.inc.ts');
const publicContractAssembly = [];
if (existsSync(independentContract) && !args.includes('--backend-only')) {
  const contractFile = join(output, 'packages/contracts/src/environmentHttp.ts');
  const marker = 'export class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")';
  const original = readFileSync(contractFile, 'utf8');
  if (original.split(marker).length !== 2) throw new Error('Exact orchestration contract assembly anchor changed');
  const schema = readFileSync(independentContract, 'utf8');
  const endpoint = '\n  .add(HttpApiEndpoint.get("independentBlackboard", "/api/orchestration/projects/:projectId/independent-blackboard", {\n    headers: OptionalBearerHeaders, params: Schema.Struct({ projectId: ProjectId }),\n    payload: { environmentId: TrimmedNonEmptyString }, success: IndependentBlackboardSnapshot,\n    error: EnvironmentOrchestrationThreadSnapshotErrors,\n  }).middleware(EnvironmentAuthenticatedAuth))';
  writeFileSync(contractFile, original.replace(marker, schema + '\n' + marker + endpoint));
  publicContractAssembly.push({ input: relative(workspace, independentContract), inputSha256: sha(readFileSync(independentContract)),
    output: 'packages/contracts/src/environmentHttp.ts', outputSha256: sha(readFileSync(contractFile)), endpoint: 'orchestration.independentBlackboard', apiVersion: '0.1.0' });
}
// Cached dependency trees stay immutable and no installer or network is invoked.
const workspacePackages = new Map();
for (const name of readdirSync(join(output, 'packages'))) {
  const directory = join(output, 'packages', name);
  const manifest = join(directory, 'package.json');
  if (existsSync(manifest)) workspacePackages.set(JSON.parse(readFileSync(manifest, 'utf8')).name, directory);
}
function linkDependencies(path) {
  const from = join(option('--dependency-source', source), path, 'node_modules');
  const to = join(output, path, 'node_modules');
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to) && lstatSync(to).isSymbolicLink()) {
    if (realpathSync(to) !== realpathSync(from)) throw new Error(`Dependency link changed: ${path}`);
    unlinkSync(to);
  }
  mkdirSync(to, { recursive: true });
  for (const cache of ['.vite', '.vite-temp', '.cache', '.cache-vp']) {
    const target = join(to, cache);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) unlinkSync(target);
  }
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (['.vite', '.vite-temp', '.cache', '.cache-vp'].includes(entry.name)) continue;
    const original = join(from, entry.name), dest = join(to, entry.name);
    if (entry.name === '@t3tools') {
      mkdirSync(dest, { recursive: true });
      for (const name of readdirSync(original)) {
        const target = realpathSync(join(original, name));
        // Workspace modules must resolve the assembled pinned source, not an old cached checkout.
        const assembled = workspacePackages.get(`@t3tools/${name}`) ?? target;
        const link = join(dest, name);
        if (existsSync(link)) unlinkSync(link);
        symlinkSync(assembled, link, 'dir');
      }
    } else if (!existsSync(dest)) symlinkSync(realpathSync(original), dest, 'dir');
  }
}
linkDependencies('');
linkDependencies('scripts');
for (const base of ['apps', 'packages', 'scripts']) {
  const from = join(output, base);
  if (!existsSync(from)) continue;
  for (const entry of readdirSync(from, { withFileTypes: true })) if (entry.isDirectory()) linkDependencies(`${base}/${entry.name}`);
}
// Build-time scripts also import workspace and Effect modules from the root.
// These are the same cached modules, with no package installation or lock edit.
if (args.includes('--backend-only')) {
  for (const name of ['effect', '@effect/vitest']) {
    const from = join(option('--dependency-source', source), 'apps/server/node_modules', name);
    const to = join(output, 'node_modules', name);
    if (existsSync(from) && !existsSync(to)) { mkdirSync(dirname(to), { recursive: true }); symlinkSync(realpathSync(from), to, 'dir'); }
  }
  for (const [name, target] of workspacePackages) {
    const to = join(output, 'node_modules', name);
    if (!existsSync(to)) { mkdirSync(dirname(to), { recursive: true }); symlinkSync(target, to, 'dir'); }
  }
}
const overlayFiles = [];
function apply(directory, root, moduleOnly = false) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'data', '.git', '.generated', '.vite', '.vite-temp', '.cache', '.cache-vp'].includes(entry.name) || /^\.env(?:\.|$)/.test(entry.name)) continue;
    const from = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Overlay symlinks are forbidden');
    if (entry.isDirectory()) { apply(from, root, moduleOnly); continue; }
    const file = relative(root, from);
    if (moduleOnly && !file.startsWith('apps/web/src/aaaagent/') && ![
      'apps/web/src/routes/_chat.tsx', 'apps/web/src/routes/_chat.index.tsx',
      'apps/web/src/components/ThreadRouteView.tsx', 'apps/web/src/components/ChatView.tsx',
      'apps/web/src/components/AppSidebarLayout.tsx',
      'apps/web/src/index.css', 'apps/web/src/hooks/useTheme.ts', 'apps/web/src/themePalette.ts',
    ].includes(file)) continue;
    const to = join(output, file);
    mkdirSync(dirname(to), { recursive: true }); cpSync(from, to);
    overlayFiles.push({ path: file, sha256: sha(readFileSync(from)) });
  }
}
const ownOverlay = join(workspace, 'code/desktop-pet/t3-native');
apply(join(ownOverlay, 'apps'), ownOverlay);
if (overlay !== ownOverlay) apply(join(overlay, 'apps'), overlay, true);
const preview = join(toolRoot, 'preview');
if (existsSync(preview)) cpSync(preview, join(output, 'apps/web/src/aaaIntegration'), { recursive: true });
// Upstream's locally generated terminal asset is an explicit public asset only.
const wasm = join(source, 'apps/web/public/libghostty.wasm');
if (existsSync(wasm)) cpSync(wasm, join(output, 'apps/web/public/libghostty.wasm'));
const noticeCache = '.generated/third-party-licenses/spdx/v3.28.0';
const noticePins = [];
const cachedNotices = join(toolRoot, 'notices');
if (existsSync(cachedNotices)) {
  mkdirSync(join(output, noticeCache), { recursive: true });
  for (const name of readdirSync(cachedNotices)) {
    if (!/^[A-Za-z0-9.-]+\.json$/.test(name)) throw new Error('Unexpected notice cache entry');
    const data = readFileSync(join(cachedNotices, name));
    const decoded = JSON.parse(data);
    if (typeof decoded.licenseId !== 'string' || typeof decoded.licenseText !== 'string') throw new Error('Invalid SPDX notice cache');
    writeFileSync(join(output, noticeCache, name), data);
    noticePins.push({ path: `${noticeCache}/${name}`, sha256: sha(data) });
  }
}
const receipt = { package: pins.package, source, overlay, output, upstream_commit: pins.upstream_commit, patch_sha256: pins.patch_sha256, applied_diff_sha256: pins.applied_diff_sha256, tracked_public_files: copied, overlays: overlayFiles, publicContractAssembly, notice_cache: noticePins, dependencies: 'cached read-only package links; workspace modules resolve assembled pinned source; mutable build caches isolated', env_auth_state_copied: false, generated_at: new Date().toISOString() };
writeFileSync(join(output, '.aaa-native-ui.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ output, tracked_public_files: copied, overlays: overlayFiles.length, no_install: true }));
