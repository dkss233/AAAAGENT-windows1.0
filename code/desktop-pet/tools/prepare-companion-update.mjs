import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTrialConfiguration } from '../dist/app/trial-config.js';
import { companionDatabaseFile, legacyTrialDatabaseFile } from '../dist/app/companion-data.js';
import { assertNewCompanionDataAbsent } from '../dist/app/companion-data-transition.js';
import { assertTrialQuiescent, inspectTrialUpdate } from './install-trial-update.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Error(message); };
const additions = ['contracts/character', 'app/companion-data', 'app/companion-data-transition', 'companion/introduction', 'memory/database-identity']
  .flatMap(path => [`code/desktop-pet/${path}.ts`, `code/desktop-pet/dist/${path}.js`]);
additions.push('code/desktop-pet/tools/prepare-companion-update.mjs');
const outputFor = candidate => resolve(candidate, 'artifacts/W0-I/companion-step1-01/update');
async function bytes(root, file, optional = false) {
  const path = resolve(root, file);
  if (!path.startsWith(root + '/')) fail('File is outside the selected project');
  for (let p = path; p !== root; p = dirname(p)) {
    try { if ((await lstat(p)).isSymbolicLink()) fail('Update preparation cannot follow symlinks'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { if (!(await lstat(path)).isFile()) fail('Update input must be a regular file'); return await readFile(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

/** Prepares only review metadata in the candidate tree. Does not open either database,
 * read keys/ledger, stop a process, change the installed app, or create an executable plan. */
export async function prepareCompanionUpdate({ projectRoot, candidateRoot, sourceRevision }) {
  const root = await realpath(projectRoot), candidate = await realpath(candidateRoot);
  if (root !== projectRoot || candidate !== candidateRoot || root === candidate || !/^[a-f0-9]{40}$/.test(sourceRevision)) fail('Separate canonical roots and reviewed source revision required');
  const directory = 'artifacts/W0-I/model-evaluation/trial/user-trial';
  const currentBytes = await bytes(root, `${directory}/config.json`), activationBytes = await bytes(root, `${directory}/activation.json`);
  const current = validateTrialConfiguration(JSON.parse(currentBytes)), activation = JSON.parse(activationBytes);
  if (current.projectRoot !== root || current.purpose !== 'user-trial' || current.product !== undefined || current.database !== legacyTrialDatabaseFile(root)
    || activation.status !== 'active' || activation.phaseId !== current.phaseId || activation.configSha256 !== hash(currentBytes)) fail('Expected active legacy trial metadata');
  const runtimeFiles = {}, files = [];
  for (const name of [...new Set([...Object.keys(current.runtimeFiles), ...additions])].sort()) {
    const before = await bytes(root, name, !current.runtimeFiles[name]), after = await bytes(candidate, name);
    if (current.runtimeFiles[name] && hash(before) !== current.runtimeFiles[name]) fail('Installed runtime differs from its recorded version');
    runtimeFiles[name] = hash(after);
    if (before === null || hash(before) !== hash(after)) files.push({path:name,before:before===null?null:hash(before),after:hash(after)});
  }
  const next = validateTrialConfiguration({...current,product:'companion-v1',database:companionDatabaseFile(root),sourceRevision,runtimeFiles});
  const nextBytes = JSON.stringify(next,null,2)+'\n', output = outputFor(candidate), nextConfigFile=resolve(output,'next-config.json');
  const review = {version:1,status:'candidate_prepared_requires_quiescent_freeze',projectRoot:root,candidateRoot:candidate,
    currentConfigSha256:hash(currentBytes),currentActivationSha256:hash(activationBytes),nextConfigFile,nextConfigSha256:hash(nextBytes),files,
    sourceRevision,runtimeFileCount:Object.keys(runtimeFiles).length,oldDatabase:current.database,newDatabase:next.database,
    unchangedPolicy:'Original model and credential references, phase, limits, ledger location and budget policy preserved; no credential or ledger read',
    pending:'After candidate review and normal app exit, freeze exact legacy database/WAL/SHM hashes. No old data backup or import.'};
  await bytes(candidate,'artifacts/W0-I/companion-step1-01/update/review.json',true);
  await mkdir(output,{recursive:true});
  await writeFile(nextConfigFile,nextBytes,{mode:0o600,flag:'wx'});
  const reviewFile=resolve(output,'review.json');await writeFile(reviewFile,JSON.stringify(review,null,2)+'\n',{mode:0o600,flag:'wx'});
  return {reviewFile,status:review.status,changedFiles:files.length,runtimeFiles:review.runtimeFileCount};
}

/** Explicit final freeze after candidate review. Quiescence precedes any legacy DB byte read.
 * Writes only a frozen candidate plan; actual installation is a separate existing entry. */
export async function freezeCompanionUpdate(reviewFile, {quiescent=assertTrialQuiescent}={}) {
  const review=JSON.parse(await readFile(reviewFile));
  const root=await realpath(review.projectRoot),candidate=await realpath(review.candidateRoot);
  if (root!==review.projectRoot||candidate!==review.candidateRoot||root===candidate||resolve(reviewFile)!==resolve(outputFor(candidate),'review.json')
    ||review.version!==1||review.status!=='candidate_prepared_requires_quiescent_freeze') fail('Explicit candidate review required');
  const current=validateTrialConfiguration(JSON.parse(await bytes(root,'artifacts/W0-I/model-evaluation/trial/user-trial/config.json')));
  await quiescent(current);
  await assertNewCompanionDataAbsent(root);
  const database=legacyTrialDatabaseFile(root);
  const data=await bytes(root,database),wal=await bytes(root,database+'-wal',true),shm=await bytes(root,database+'-shm',true);
  const plan={version:1,projectRoot:root,candidateRoot:candidate,currentConfigSha256:review.currentConfigSha256,currentActivationSha256:review.currentActivationSha256,
    nextConfigFile:review.nextConfigFile,nextConfigSha256:review.nextConfigSha256,files:review.files,activateOnSuccess:true,
    legacyData:{kind:'retire_legacy_trial_data',id:'companion-step1-'+review.sourceRevision.slice(0,12),files:{database:hash(data),wal:wal?hash(wal):null,shm:shm?hash(shm):null}}};
  await inspectTrialUpdate(plan,quiescent);
  const planFile=resolve(outputFor(candidate),'frozen-plan.json');await bytes(candidate,planFile,true);
  await writeFile(planFile,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});
  return {planFile,status:'frozen_not_installed',changedFiles:plan.files.length};
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [mode,first,second,third]=process.argv.slice(2);
    const result=mode==='--prepare'?await prepareCompanionUpdate({projectRoot:first,candidateRoot:second,sourceRevision:third}):mode==='--freeze'?await freezeCompanionUpdate(first):fail('Use --prepare project-root candidate-root source-revision or --freeze review.json');
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
