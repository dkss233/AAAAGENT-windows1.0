import {inspectUnlimitedAccountingUpdate} from './unlimited-accounting-update.mjs';
import { inspectVoiceUpdate } from './voice-pipeline-update.mjs';
import { inspectTextUpdate } from './deepseek-text-update.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, lstat, realpath, rename, unlink, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRuntimeRetirements, isTrialRuntimePath, validateTrialConfiguration } from '../dist/app/trial-config.js';
import { assertReviewedUnknownCosts } from '../dist/app/trial-authorizer.js';
import { validateCompanionTransition, verifyLegacyData, assertNewCompanionDataAbsent, prepareRetirement, readRetirementReceipt, retireLegacyData } from '../dist/app/companion-data-transition.js';
import { legacyTrialDatabaseFile } from '../dist/app/companion-data.js';
import { assertT3RendererUpdate, inspectT3UpdateGraph } from '../../workbench/integration/engine-pins/t3-renderer-update.mjs';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function localFile(root, name, optional = false) {
  if (typeof name !== 'string' || !isTrialRuntimePath(name)) fail('Invalid update file path');
  const path = resolve(root, name);
  let parent = path;
  while (parent !== resolve(root)) {
    if (await exists(parent) && (await lstat(parent)).isSymbolicLink()) fail('Update paths cannot follow symbolic links');
    parent = dirname(parent);
  }
  if (!await exists(path)) { if (optional) return null; fail('Update file missing'); }
  if (!(await lstat(path)).isFile()) fail('Update input is not a regular file');
  return { path, bytes: await readFile(path), mode: (await lstat(path)).mode & 0o777 };
}

/** Read-only process/lock checks. No signal, device, database-content or credential access. */
export async function assertTrialQuiescent(configuration, { allowWorkbenchRunning = false } = {}) {
  const root = configuration.projectRoot;
  for (const path of [resolve(root, 'artifacts/W0-I/model-evaluation/backend.lock'), `${configuration.budgetFile}.lock`,
    ...(allowWorkbenchRunning ? [] : [resolve(root, 'data/desktop-pet/t3-home/.aaaagent-t3-owner.json'),
    resolve(root, 'data/desktop-pet/t3-home/.aaaagent-t3-host.lock'), resolve(root, 'data/desktop-pet/t3-home/.aaaagent-t3-host.json')])]) {
    if (await exists(path)) fail('请先退出桌宠并显式停止工程后台，等待后台正常结束后再打开更新入口。');
  }
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,command=']);
  if (stdout.split('\n').some(line => !line.trim().startsWith(`${process.pid} `) && line.includes(resolve(root, 'code/desktop-pet')) && /(?:\/DesktopPet(?:\s|$)|\/(?:trial-backend|trial-launcher)\.js(?:\s|$))/.test(line))) fail('请先退出桌宠，再打开更新入口。');
  for (const suffix of ['', '-wal', '-shm']) {
    const path = configuration.database + suffix;
    if (!await exists(path)) continue;
    try {
      const { stdout: holders } = await execute('/usr/sbin/lsof', ['-t', '--', path]);
      if (holders.trim()) fail('桌宠数据仍在使用中，请等待应用正常退出后重试。');
    } catch (error) { if (error.code !== 1 || error.stderr?.trim()) throw error; }
  }
}

/** Exact config/files; database movement is allowed only by the explicit companion retirement plan. */
export async function inspectTrialUpdate(plan, quiescent = assertTrialQuiescent) {
  if (plan.version !== 1 || !Array.isArray(plan.files) || !plan.files.length || (plan.activateOnSuccess !== undefined && typeof plan.activateOnSuccess !== 'boolean')) fail('Invalid update plan');
  const root = await realpath(plan.projectRoot), candidate = await realpath(plan.candidateRoot);
  if (root !== plan.projectRoot || candidate !== plan.candidateRoot || root === candidate) fail('Explicit separate canonical and candidate roots required');
  const directory = resolve(root, 'artifacts/W0-I/model-evaluation/trial/user-trial');
  const configFile = resolve(directory, 'config.json'), activationFile = resolve(directory, 'activation.json');
  const configBytes = await readFile(configFile), activationBytes = await readFile(activationFile), nextBytes = await readFile(plan.nextConfigFile);
  if (digest(configBytes) !== plan.currentConfigSha256 || digest(activationBytes) !== plan.currentActivationSha256 || digest(nextBytes) !== plan.nextConfigSha256) fail('Reviewed trial state changed');
  const current = validateTrialConfiguration(JSON.parse(configBytes)), next = validateTrialConfiguration(JSON.parse(nextBytes));
  const activation = JSON.parse(activationBytes);
  if (current.projectRoot !== root || next.projectRoot !== root || activation.status !== 'active' || activation.phaseId !== current.phaseId || activation.configSha256 !== digest(configBytes)) fail('Current activation is not the reviewed active trial');
  if (plan.reviewedUnknownCosts && (JSON.stringify(next.reviewedUnknownCosts) !== JSON.stringify(plan.reviewedUnknownCosts)
    || (current.reviewedUnknownCosts && JSON.stringify(current.reviewedUnknownCosts) !== JSON.stringify(next.reviewedUnknownCosts)))) fail('Unknown-cost review is not the exact planned addition');
  const voiceUpdate = await inspectVoiceUpdate(plan, current, next);
  const textUpdate = voiceUpdate ?? await inspectTextUpdate(plan, current, next);
  if (plan.workbenchDshUpdate && (Object.keys(plan.workbenchDshUpdate).sort().join(',') !== 'after,before' ||
      plan.workbenchDshUpdate.before !== (current.workbenchDshWebLog ?? null) ||
      typeof plan.workbenchDshUpdate.after !== 'string' || plan.workbenchDshUpdate.after !== next.workbenchDshWebLog)) {
    fail('Native DSH Host location differs from exact reviewed update');
  }
  const policy = c => { const { sourceRevision, runtimeFiles, ...rest } = c;
    if (plan.workbenchDshUpdate) delete rest.workbenchDshWebLog;
    if (plan.reviewedUnknownCosts) delete rest.reviewedUnknownCosts;
    if(plan.accountingUpdate){delete rest.budgetMode;delete rest.limitMicros;delete rest.phaseLimitMicros;delete rest.maxCalls;delete rest.operationLimits;}
    if (voiceUpdate) { rest.models={...rest.models}; delete rest.models.asr; delete rest.models.perception; delete rest.phaseLimitMicros; delete rest.maxCalls; delete rest.operationLimits; }
    if (textUpdate && !voiceUpdate) { rest.models = { ...rest.models }; for (const slot of ['dialogue','summary','admission']) delete rest.models[slot]; }
    if (plan.legacyData) { const { database, product, ...unchanged } = rest; return unchanged; } return rest; };
  if (JSON.stringify(policy(current)) !== JSON.stringify(policy(next))) fail('Update must preserve phase, data, credentials and budget policy');
  if (plan.legacyData) validateCompanionTransition(current, next, plan.legacyData);
  await quiescent(current);
  if (plan.legacyData) { await verifyLegacyData(root, plan.legacyData); await assertNewCompanionDataAbsent(root); }
  const budgetBytes = await readFile(current.budgetFile), budget = JSON.parse(budgetBytes);
  if (budget.batchId !== current.budgetBatchId || budget.limitMicros !== current.limitMicros || (current.budgetMode!=='unlimited'&&budget.blocked&&!plan.accountingUpdate) || !Array.isArray(budget.entries)
    || budget.entries.some(e => !['settled', 'unknown'].includes(e.status))) fail('Original ledger has unreviewed pending charges');
  const accountingUpdate=inspectUnlimitedAccountingUpdate(plan,current,next,budgetBytes);
  if (next.purpose !== 'user-trial') await assertReviewedUnknownCosts(budget.entries, next);
  const changes = new Map();
  for (const entry of plan.files) {
    if (changes.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.after) || !(entry.before === null || /^[a-f0-9]{64}$/.test(entry.before))) fail('Invalid or duplicate update entry');
    const before = await localFile(root, entry.path, true), after = await localFile(candidate, entry.path);
    if ((before ? digest(before.bytes) : null) !== entry.before || digest(after.bytes) !== entry.after) fail('Reviewed update bytes changed');
    changes.set(entry.path, { ...entry, beforeFile: before, afterFile: after });
  }
  const retired = plan.retiredRuntimePaths ?? [];
  assertRuntimeRetirements(current.runtimeFiles, Object.keys(next.runtimeFiles), retired);
  const rendererRetirements = new Map();
  for (const [name, hash] of Object.entries(current.runtimeFiles)) {
    const file = await localFile(root, name);
    if (digest(file.bytes) !== hash || !next.runtimeFiles[name] && !retired.includes(name)) fail('Current runtime changed or was removed');
    if (retired.includes(name) && /^(?:code\/desktop-pet\/t3-native|artifacts\/runtime\/engine-pin-54\/t3-runtime)\/apps\/web\/dist\/assets\//.test(name))
      rendererRetirements.set(name, file);
  }
  for (const [name, hash] of Object.entries(next.runtimeFiles)) {
    const file = await localFile(candidate, name);
    if (digest(file.bytes) !== hash) fail('Candidate runtime changed');
    if (current.runtimeFiles[name] !== hash && changes.get(name)?.after !== hash) fail('Runtime update omitted from plan');
  }
  for (const [name, entry] of changes) if (current.runtimeFiles[name] && next.runtimeFiles[name] !== entry.after) fail('Runtime plan and config disagree');
  const t3RendererUpdate = assertT3RendererUpdate(plan, current, next);
  for (const item of t3RendererUpdate?.retired ?? []) {
    const file = await localFile(root, item.path);
    if (digest(file.bytes) !== item.before || next.runtimeFiles[item.path]) fail('Reviewed native renderer retirement changed');
    rendererRetirements.set(item.path, file);
  }
  return { root, current, next, configFile, activationFile, configBytes, activationBytes, nextBytes, budgetBytes, changes, rendererRetirements, textUpdate, accountingUpdate };
}

async function replaceFile(path, bytes, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.update`;
  try { await writeFile(temporary, bytes, { mode, flag: 'wx' }); await rename(temporary, path); }
  finally { if (await exists(temporary)) await unlink(temporary); }
}

/** Reusing the same entry only verifies and launches an already installed exact version. */
export async function inspectInstalledTrialUpdate(plan, quiescent = assertTrialQuiescent) {
  const root = await realpath(plan.projectRoot);
  if (root !== plan.projectRoot || !/^[a-f0-9]{64}$/.test(plan.nextConfigSha256)) fail('Invalid installed-version plan');
  const directory=resolve(root,'artifacts/W0-I/model-evaluation/trial/user-trial');
  const bytes=await readFile(resolve(directory,'config.json'));
  if (digest(bytes)!==plan.nextConfigSha256) return null;
  const configuration=validateTrialConfiguration(JSON.parse(bytes));
  const activation=JSON.parse(await readFile(resolve(directory,'activation.json')));
  if (configuration.projectRoot!==root || activation.version!==1 || activation.phaseId!==configuration.phaseId || activation.configSha256!==plan.nextConfigSha256 || !(activation.status==='active'||(activation.status==='prepared'&&plan.legacyData))) fail('更新尚未完成，请保留提示并联系协调任务。');
  await quiescent(configuration);
  for(const [name,hash] of Object.entries(configuration.runtimeFiles)) if(digest((await localFile(root,name)).bytes)!==hash) fail('已安装的程序文件发生变化，请保留提示并联系协调任务。');
  if (plan.t3RendererUpdate && inspectT3UpdateGraph(root, configuration.runtimeFiles).inventorySha256 !== plan.t3RendererUpdate.afterInventorySha256) fail('Installed complete engine graph changed');
  if(activation.status==='prepared') { const receipt=await readRetirementReceipt(root,plan.legacyData,plan.nextConfigSha256); return {status:'installed_prepared',retirementState:receipt.state,changedFiles:0}; }
  return {status:'already_active',changedFiles:0};
}

async function finishCompanionRetirement(plan, configuration, quiescent) {
  const root=configuration.projectRoot, directory=resolve(root,'artifacts/W0-I/model-evaluation/trial/user-trial');
  const guard=async()=>{
    await quiescent(configuration);
    await quiescent({...configuration,database:legacyTrialDatabaseFile(root)});
    const raw=await readFile(resolve(directory,'config.json')), activation=JSON.parse(await readFile(resolve(directory,'activation.json')));
    if(digest(raw)!==plan.nextConfigSha256 || activation.status!=='prepared' || activation.configSha256!==plan.nextConfigSha256 || activation.phaseId!==configuration.phaseId) fail('Prepared companion state changed');
    const budget=JSON.parse(await readFile(configuration.budgetFile));
    if(budget.batchId!==configuration.budgetBatchId||budget.limitMicros!==configuration.limitMicros||(configuration.budgetMode!=='unlimited'&&budget.blocked)||!Array.isArray(budget.entries)||budget.entries.some(e=>e.status!=='settled')) fail('Original ledger is not fully settled');
    for(const [name,hash] of Object.entries(configuration.runtimeFiles)) if(digest((await localFile(root,name)).bytes)!==hash) fail('Installed runtime changed before legacy retirement');
  };
  await retireLegacyData(root,plan.legacyData,plan.nextConfigSha256,guard);
}
async function resumeCompanionRetirement(plan, quiescent) {
  const root=await realpath(plan.projectRoot), updateRoot=resolve(root,'artifacts/W0-I/trial-feedback-01/update');
  await mkdir(updateRoot,{recursive:true});const lockPath=resolve(updateRoot,'install.lock'),lock=await open(lockPath,'wx',0o600);
  try {
    const state=await inspectInstalledTrialUpdate(plan,quiescent);
    if(state?.status==='already_active')return state;
    if(state?.status!=='installed_prepared')fail('Companion retirement cannot resume');
    const directory=resolve(root,'artifacts/W0-I/model-evaluation/trial/user-trial');
    const configuration=validateTrialConfiguration(JSON.parse(await readFile(resolve(directory,'config.json'))));
    await finishCompanionRetirement(plan,configuration,quiescent);
    if(plan.activateOnSuccess)await replaceFile(resolve(directory,'activation.json'),Buffer.from(JSON.stringify({version:1,phaseId:configuration.phaseId,status:'active',configSha256:plan.nextConfigSha256})+'\n'));
    return {status:plan.activateOnSuccess?'installed_active':'installed_prepared',changedFiles:0,legacyDataRetired:true};
  } finally {await lock.close();await unlink(lockPath);}
}

/** A reviewed plan may enable the verified version last; failures remain PREPARED for recovery. */
export async function installTrialUpdate(plan, { quiescent = assertTrialQuiescent, afterWrite = async () => {} } = {}) {
  const installed=await inspectInstalledTrialUpdate(plan,quiescent);
  if(installed?.status==='already_active') return installed;
  if(installed?.status==='installed_prepared')return resumeCompanionRetirement(plan,quiescent);
  const state = await inspectTrialUpdate(plan, quiescent);
  const updateRoot = resolve(state.root, 'artifacts/W0-I/trial-feedback-01/update');
  await mkdir(updateRoot, { recursive: true });
  const lockFile = resolve(updateRoot, 'install.lock'), lock = await open(lockFile, 'wx', 0o600);
  let backup, gated = false, retirementRequested = false, settingsTouched = false, ledgerTouched = false;
  const touched = [], retiredRenderer = [];
  try {
    // Recheck after acquiring the single installer lock; never reuse a stale process observation.
    await inspectTrialUpdate(plan, quiescent);
    backup = resolve(updateRoot, randomUUID()); await mkdir(backup);
    await writeFile(resolve(backup, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
    await writeFile(resolve(backup, 'config.json'), state.configBytes);
    await writeFile(resolve(backup, 'activation.json'), state.activationBytes);
    if(state.accountingUpdate)await writeFile(resolve(backup,'budget.json'),state.budgetBytes,{mode:0o600});
    if (state.textUpdate) await writeFile(resolve(backup, 'management-settings.json'), state.textUpdate.before, {mode:0o600});
    for (const [name, entry] of state.changes) if (entry.beforeFile) {
      const path = resolve(backup, name); await mkdir(dirname(path), {recursive:true}); await writeFile(path,entry.beforeFile.bytes,{mode:entry.beforeFile.mode});
    }
    for (const [name, file] of state.rendererRetirements) {
      const path = resolve(backup, name); await mkdir(dirname(path), {recursive:true}); await writeFile(path,file.bytes,{mode:file.mode});
    }
    if(plan.legacyData)await prepareRetirement(state.root,plan.legacyData,plan.nextConfigSha256);
    if (digest(await readFile(state.activationFile)) !== plan.currentActivationSha256) fail('Activation changed before gate');
    await replaceFile(state.activationFile, Buffer.from(JSON.stringify({version:1,phaseId:state.current.phaseId,status:'prepared',configSha256:plan.currentConfigSha256})+'\n')); gated = true;
    await quiescent(state.current);
    if (!state.configBytes.equals(await readFile(state.configFile)) || !state.budgetBytes.equals(await readFile(state.current.budgetFile))) fail('Trial state changed before install');
    for (const [name, entry] of state.changes) {
      const actual = await localFile(state.root,name,true);
      if ((actual ? digest(actual.bytes) : null) !== entry.before) fail('Runtime changed during install');
      touched.push(name); await replaceFile(resolve(state.root,name), entry.afterFile.bytes, entry.afterFile.mode); await afterWrite(name);
    }
    // The renderer inventory must contain only the new registered assets. Keep
    // reviewed old bytes in the install backup; other retired runtimes stay put.
    for (const [name, file] of state.rendererRetirements) {
      if (digest((await localFile(state.root,name)).bytes) !== digest(file.bytes)) fail('Renderer changed during retirement');
      await unlink(resolve(state.root,name)); retiredRenderer.push(name); await afterWrite(name);
    }
    if (state.textUpdate) {
      if (!state.textUpdate.before.equals(await readFile(state.textUpdate.file))) fail('User settings changed during install');
      await replaceFile(state.textUpdate.file,state.textUpdate.after); settingsTouched = true;
    }
    if(state.accountingUpdate){
      if(!state.budgetBytes.equals(await readFile(state.current.budgetFile)))fail('Ledger changed before accounting migration');
      await replaceFile(state.current.budgetFile,state.accountingUpdate.after);ledgerTouched=true;
    }
    await replaceFile(state.configFile,state.nextBytes);
    for (const [name, hash] of Object.entries(state.next.runtimeFiles)) if (digest((await localFile(state.root,name)).bytes)!==hash) fail('Installed runtime verification failed');
    if (plan.t3RendererUpdate && inspectT3UpdateGraph(state.root, state.next.runtimeFiles).inventorySha256 !== plan.t3RendererUpdate.afterInventorySha256) fail('Installed complete engine graph verification failed');
    if (!(state.accountingUpdate?.after??state.budgetBytes).equals(await readFile(state.current.budgetFile))) fail('Ledger changed during install');
    await replaceFile(state.activationFile, Buffer.from(JSON.stringify({version:1,phaseId:state.next.phaseId,status:'prepared',configSha256:plan.nextConfigSha256})+'\n'));
    await quiescent(state.next);
    if (!(state.accountingUpdate?.after??state.budgetBytes).equals(await readFile(state.current.budgetFile))) fail('Ledger changed before activation');
    if(plan.legacyData){retirementRequested=true;await finishCompanionRetirement(plan,state.next,quiescent);}
    await writeFile(resolve(backup,'result.json'),JSON.stringify({status:'installed_verified',activationRequested:plan.activateOnSuccess===true,sourceRevision:state.next.sourceRevision,changedFiles:touched.length,retiredRendererFiles:retiredRenderer.length})+'\n');
    if (plan.activateOnSuccess) await replaceFile(state.activationFile, Buffer.from(JSON.stringify({version:1,phaseId:state.next.phaseId,status:'active',configSha256:plan.nextConfigSha256})+'\n'));
    return {status:plan.activateOnSuccess?'installed_active':'installed_prepared',backup,changedFiles:touched.length,...(retiredRenderer.length?{retiredRendererFiles:retiredRenderer.length}:{})};
  } catch (error) {
    if (gated && !retirementRequested) {
      // Restore only this installer's exact reviewed bytes, never user DB/journal/keys.
      if(ledgerTouched){if(!state.accountingUpdate.after.equals(await readFile(state.current.budgetFile)))throw Error('Ledger changed after migration; preserve it for reconciliation');await replaceFile(state.current.budgetFile,state.budgetBytes);}
      for (const name of retiredRenderer.reverse()) {
        if (await exists(resolve(state.root,name))) fail('Retired renderer path changed after removal; preserve for reconciliation');
        const file=state.rendererRetirements.get(name); await replaceFile(resolve(state.root,name),file.bytes,file.mode);
      }
      for (const name of touched.reverse()) {
        const entry=state.changes.get(name);
        if (entry.beforeFile) await replaceFile(resolve(state.root,name),entry.beforeFile.bytes,entry.beforeFile.mode);
        else if (await exists(resolve(state.root,name))) await unlink(resolve(state.root,name));
      }
      if (settingsTouched && state.textUpdate && state.textUpdate.after.equals(await readFile(state.textUpdate.file)))
        await replaceFile(state.textUpdate.file,state.textUpdate.before);
      await replaceFile(state.configFile,state.configBytes);
      await replaceFile(state.activationFile,Buffer.from(JSON.stringify({version:1,phaseId:state.current.phaseId,status:'prepared',configSha256:plan.currentConfigSha256})+'\n'));
    }
    if (backup) await writeFile(resolve(backup,'result.json'),JSON.stringify({status:retirementRequested?'retirement_incomplete_prepared':gated?'rolled_back_prepared':'refused',error:'Update did not complete; activation requires review'})+'\n');
    throw error;
  } finally { await lock.close(); await unlink(lockFile); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, path] = process.argv.slice(2);
  try {
    if (!['--check','--apply','--apply-and-launch'].includes(mode) || !path) fail('Usage: install-trial-update.mjs --check|--apply|--apply-and-launch reviewed-plan.json');
    const plan = JSON.parse(await readFile(path));
    if (mode === '--apply-and-launch' && plan.activateOnSuccess !== true) fail('更新包尚未完成启用审核。');
    const result = mode !== '--check' ? await installTrialUpdate(plan) : await inspectInstalledTrialUpdate(plan) ?? await inspectTrialUpdate(plan).then(s=>({status:'ready_for_review',changedFiles:s.changes.size}));
    process.stdout.write(JSON.stringify(result)+'\n');
    if (mode === '--apply-and-launch') {
      process.stdout.write('更新已完成，正在启动桌宠。\n');
      const child=spawn(process.execPath,[resolve(plan.projectRoot,'code/desktop-pet/dist/app/trial-launcher.js')],{stdio:'inherit'});
      await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?done():reject(new Error('桌宠未正常退出；已保存的数据和更新备份仍保留。')));});
    }
  } catch (error) { process.stderr.write(error.message+'\n'); process.exitCode=1; }
}
