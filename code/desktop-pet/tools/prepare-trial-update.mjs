import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRuntimeRetirements, isTrialRuntimePath, validateTrialConfiguration, T3_ENGINE_BUNDLE_SUPPORT_PATHS } from '../dist/app/trial-config.js';
import { companionDatabaseFile } from '../dist/app/companion-data.js';
import { verifyT3EngineAdapter } from '../../workbench/integration/engine-pins/prepare-t3-adapter.mjs';
import { prepareT3RendererUpdate, T3_ADAPTER_LOCK } from '../../workbench/integration/engine-pins/t3-renderer-update.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function bytes(root, name, optional = false) {
  const file = resolve(root, name);
  if (!file.startsWith(root + '/')) throw new Error('File outside project');
  for (let p = file; p !== root; p = dirname(p)) {
    try { if ((await lstat(p)).isSymbolicLink()) throw new Error('Symlink in update input'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { if (!(await lstat(file)).isFile()) throw new Error('Update input is not a regular file'); return await readFile(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

/** Same-database preparation. Only explicit accounting migration reads ledger metadata; no DB/key/process access. */
export async function prepareTrialUpdate({ projectRoot, candidateRoot, sourceRevision, newRuntimePaths = [], retiredRuntimePaths = [], reviewedUnknownCosts, unlimitedAccounting = false, workbenchDshWebLog,
  baselineDirectory, outputDirectory = 'artifacts/W0-I/companion-feedback-01/update' }) {
  const root = await realpath(projectRoot), candidate = await realpath(candidateRoot);
  if (root !== projectRoot || candidate !== candidateRoot || root === candidate || !/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error('Separate canonical roots and exact source revision required');
  const baseline = baselineDirectory ? await realpath(baselineDirectory) : null;
  if (baseline && (baseline !== baselineDirectory || !baseline.startsWith(resolve(root, 'artifacts/worktrees/W0-I-') + ''))) throw new Error('Baseline backup must be a canonical integration artifact');
  if (typeof outputDirectory !== 'string' || !outputDirectory.startsWith('artifacts/W0-I/')
    || outputDirectory.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Update evidence must stay in the integration artifact directory');
  const output = resolve(candidate, outputDirectory);
  for (let p = output; p !== candidate; p = dirname(p)) {
    try { if ((await lstat(p)).isSymbolicLink()) throw new Error('Symlink in update output'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const directory = 'artifacts/W0-I/model-evaluation/trial/user-trial';
  const currentBytes = await bytes(root, `${directory}/config.json`), activationBytes = await bytes(root, `${directory}/activation.json`);
  const current = validateTrialConfiguration(JSON.parse(currentBytes)), activation = JSON.parse(activationBytes);
  if (current.product !== 'companion-v1' || current.projectRoot !== root || current.database !== companionDatabaseFile(root)
    || current.purpose !== 'user-trial' || activation.status !== 'active' || activation.phaseId !== current.phaseId
    || activation.configSha256 !== digest(currentBytes)) throw new Error('Expected active existing companion trial');
  if (current.runtimeFiles['artifacts/runtime/engine-profile.json'])
    newRuntimePaths = [...new Set([...newRuntimePaths, ...T3_ENGINE_BUNDLE_SUPPORT_PATHS])];
  const t3RendererUpdate = current.runtimeFiles['artifacts/runtime/engine-profile.json']
    ? prepareT3RendererUpdate(root, candidate, current.runtimeFiles,
      { [T3_ADAPTER_LOCK]: digest(await bytes(candidate, T3_ADAPTER_LOCK)) }) : null;
  if (t3RendererUpdate) {
    newRuntimePaths = [...new Set([...newRuntimePaths, ...t3RendererUpdate.paths])];
    retiredRuntimePaths = [...new Set([...retiredRuntimePaths,
      ...t3RendererUpdate.retired.filter(p => current.runtimeFiles[p.path]).map(p => p.path)])];
  }
  if (newRuntimePaths.some(p => !isTrialRuntimePath(p)
    || p.includes('/tests/') || p.includes('/node_modules/') &&
      p !== 'artifacts/runtime/engines-codex-0.160.0-dsh-0.2.0-rc.2-darwin-arm64/dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js')) throw new Error('Invalid added runtime path');
  assertRuntimeRetirements(current.runtimeFiles, newRuntimePaths, retiredRuntimePaths);
  for (const path of retiredRuntimePaths) if (digest(await bytes(root, path)) !== current.runtimeFiles[path]) throw Error('Retired runtime changed');
  const runtimeFiles = {}, files = [], stagedBaselineDriftPaths = [];
  for (const path of [...new Set([...Object.keys(current.runtimeFiles).filter(p => !retiredRuntimePaths.includes(p)), ...newRuntimePaths])].sort()) {
    let before = await bytes(root, path, !current.runtimeFiles[path]);
    if (current.runtimeFiles[path] && digest(before) !== current.runtimeFiles[path] && baseline) {
      before = await bytes(baseline, path);
      stagedBaselineDriftPaths.push(path);
    }
    const after = await bytes(candidate, path);
    if (current.runtimeFiles[path] && digest(before) !== current.runtimeFiles[path]) throw new Error('Installed runtime changed');
    runtimeFiles[path] = digest(after);
    if (!current.runtimeFiles[path] || !before || digest(before) !== digest(after)) files.push({ path, before: before ? digest(before) : null, after: digest(after) });
  }
  if (runtimeFiles['artifacts/runtime/engine-profile.json']) {
    const profile = JSON.parse(await bytes(candidate, 'artifacts/runtime/engine-profile.json'));
    if (profile.projectRoot !== root || profile.home !== resolve(root, 'data/desktop-pet/engine-home') ||
        profile.codexLauncher !== resolve(root, 'artifacts/runtime/engine-bindings/codex') ||
        profile.dshPresetOverlay !== resolve(root, 'artifacts/runtime/engine-bindings/dsh-presets.patch.yml')) {
      throw new Error('Candidate engine bindings must target the original installed project');
    }
    // This complete graph includes resources outside the trial's direct file
    // pins. Verify it before producing a plan, while the old app is still usable.
    verifyT3EngineAdapter(resolve(candidate, 'artifacts/runtime/engine-pin-54/t3-runtime'));
  }
  const desired={ ...current, sourceRevision, runtimeFiles, ...(reviewedUnknownCosts ? { reviewedUnknownCosts } : {}),
    ...(workbenchDshWebLog === undefined ? {} : { workbenchDshWebLog }) };
  const workbenchDshUpdate = workbenchDshWebLog === undefined ? undefined :
    { before: current.workbenchDshWebLog ?? null, after: workbenchDshWebLog };
  let accountingUpdate;
  if(unlimitedAccounting){
    if(current.budgetMode==='unlimited')throw Error('Accounting is already unlimited');
    desired.budgetMode='unlimited';desired.limitMicros=null;delete desired.phaseLimitMicros;delete desired.maxCalls;delete desired.operationLimits;
    const ledgerBytes=await readFile(current.budgetFile),ledger=JSON.parse(ledgerBytes);
    accountingUpdate={mode:'unlimited',ledgerBeforeSha256:digest(ledgerBytes),entriesSha256:digest(JSON.stringify(ledger.entries))};
  }
  const next = validateTrialConfiguration(desired);
  const nextBytes = JSON.stringify(next, null, 2) + '\n', nextConfigFile = resolve(output, 'next-config.json');
  const plan = { version: 1, projectRoot: root, candidateRoot: candidate, currentConfigSha256: digest(currentBytes),
    currentActivationSha256: digest(activationBytes), retiredRuntimePaths, nextConfigFile, nextConfigSha256: digest(nextBytes), files, activateOnSuccess: true, ...(accountingUpdate?{accountingUpdate}:{}),
    ...(reviewedUnknownCosts ? { reviewedUnknownCosts } : {}), ...(workbenchDshUpdate ? { workbenchDshUpdate } : {}),
    ...(t3RendererUpdate ? { t3RendererUpdate } : {}) };
  const review = { version: 1, status: 'ordinary_update_prepared_not_installed', sourceRevision, runtimeFiles: Object.keys(runtimeFiles).length,
    changedFiles: files.length, sameDatabase: current.database === next.database, legacyRetirement: false,
    preserves: unlimitedAccounting?'Existing data/models/settings and exact ledger entries; only reviewed accounting mode/limit headers change':'Existing companion database, chats/memory/Prompt, phase/models/credential references/ledger policy; exact file/config hashes',
    databaseRead: false, ledgerRead: unlimitedAccounting, calls: 0, stagedBaselineDriftPaths, plan };
  await mkdir(output, { recursive: true });
  for (const [file, value] of [['next-config.json', nextBytes], ['plan.json', JSON.stringify(plan, null, 2) + '\n'], ['review.json', JSON.stringify(review, null, 2) + '\n']])
    await writeFile(resolve(output, file), value, { flag: 'wx', mode: 0o600 });
  return review;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, candidate, revision, additionsFile, outputDirectory, baselineDirectory] = process.argv.slice(2);
    if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim() !== revision) throw new Error('Candidate HEAD differs from reviewed source');
    const result = await prepareTrialUpdate({ projectRoot: root, candidateRoot: candidate, sourceRevision: revision,
      newRuntimePaths: additionsFile ? JSON.parse(await readFile(additionsFile, 'utf8')) : [], outputDirectory, baselineDirectory });
    console.log(JSON.stringify({ status: result.status, runtimeFiles: result.runtimeFiles, changedFiles: result.changedFiles,
      stagedBaselineDrift: result.stagedBaselineDriftPaths.length, databaseRead: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
