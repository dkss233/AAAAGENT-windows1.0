import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareTrialUpdate } from './prepare-trial-update.mjs';
import { assertTrialQuiescent, installTrialUpdate } from './install-trial-update.mjs';
import { RegisteredVoiceStore } from '../dist/providers/registered-voices.js';
import { ManagementSettingsStore } from '../dist/management/settings-store.js';
import { availableAdapters } from '../dist/management/settings.js';
import { minimaxReleaseProfile, firstUseCost } from './minimax-first-synthesis.mjs';
import { inspectPcmWav } from '../dist/media/wav.js';

const sha = b => createHash('sha256').update(b).digest('hex');
const json = v => JSON.stringify(v, null, 2) + '\n';
const ownFile = fileURLToPath(import.meta.url), candidate = resolve(dirname(ownFile), '../../..');
const release = minimaxReleaseProfile(process.argv.includes('--hd'));
const directory = resolve(candidate, `artifacts/W0-I/${release.directory}/default-install`);
const trialDirectory = 'artifacts/W0-I/model-evaluation/trial/user-trial';
const newAssetDirectory = 'data/desktop-pet/voice-assets/' + release.assetDirectory;
const registryPath = 'data/desktop-pet/registered-voices.json';
const settingsPath = trialDirectory + '/management-settings.json';
async function absent(path) { try { await access(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; } throw Error('Expected new destination absent'); }
async function preserve(name, bytes) { await writeFile(resolve(directory, name), bytes, { flag: 'wx', mode: 0o600 }); }

export function selectedSettings(previous, selection) {
  const next = structuredClone(previous); next.providers.tts = { ...selection };
  return next;
}
async function prepare(root) {
  const firstDirectory = resolve(candidate, `artifacts/W0-I/${release.directory}/first-synthesis`);
  const receiptBytes = await readFile(resolve(firstDirectory, 'execution.json')), receipt = JSON.parse(receiptBytes);
  const response = JSON.parse(await readFile(resolve(firstDirectory, 'response.json')));
  if (receipt.status !== 'formal_synthesis_verified_not_installed' || receipt.posts !== 1 || receipt.firstUseUnlockMicros !== 9900000
    || receipt.entry.status !== 'settled' || receipt.actualMicros !== firstUseCost(response, release.characterMicros)
    || receipt.registration?.targetModel !== release.model || receipt.registration?.voiceId !== release.voiceId || response.usage?.count !== 1
    || response.output?.base_resp?.status_code !== 0 || response.output?.data?.status !== 2) throw Error('Successful first-use receipt required');
  const sample = await readFile(resolve(firstDirectory, 'sample.wav')), original = await readFile(resolve(firstDirectory, 'raw-audio.wav'));
  const reference = await readFile(resolve(root, 'artifacts/R1/dania-reference-20s-01/reference-ordered-trimmed-20.93s.wav'));
  const audition = await readFile(resolve(root, release.auditionFile));
  if (sha(sample) !== receipt.sample.sha256 || sha(original) !== receipt.rawAudio.sha256
    || sha(reference) !== receipt.registration.referenceSha256 || sha(inspectPcmWav(original).data) !== receipt.sample.pcmSha256
    || sha(inspectPcmWav(sample).data) !== receipt.sample.pcmSha256
    || sha(audition) !== release.auditionSha) throw Error('Reference, chosen audition or formal PCM changed');
  const firstPlan = JSON.parse(await readFile(resolve(firstDirectory, 'plan.json')));
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim();
  if (execFileSync('git', ['diff', 'HEAD', '--', 'code/desktop-pet'], { cwd: candidate, encoding: 'utf8' }).trim()) throw Error('Commit installation source first');
  await absent(resolve(root, newAssetDirectory)); await mkdir(directory, { recursive: true });
  const registryBefore = await readFile(resolve(root, registryPath)), settingsBefore = await readFile(resolve(root, settingsPath));
  await preserve('registry-before.json', registryBefore); await preserve('settings-before.json', settingsBefore);
  await preserve('candidate-registry.json', registryBefore); await preserve('candidate-settings.json', settingsBefore);
  const voices = await RegisteredVoiceStore.open(resolve(directory, 'candidate-registry.json'));
  await voices.register(voices.snapshot().revision, receipt.registration);
  const prepared = await prepareTrialUpdate({ projectRoot: root, candidateRoot: candidate, sourceRevision: revision,
    newRuntimePaths: release.model.endsWith('-hd') ? (process.env.PET_ADDITIONAL_RUNTIME_PATHS ? JSON.parse(await readFile(process.env.PET_ADDITIONAL_RUNTIME_PATHS, 'utf8')) : []) : ['code/desktop-pet/providers/minimax-tts.ts', 'code/desktop-pet/dist/providers/minimax-tts.js'],
    reviewedUnknownCosts: firstPlan.reviewedUnknownCosts, outputDirectory: `artifacts/W0-I/${release.directory}/update` });
  const base = JSON.parse(await readFile(prepared.plan.nextConfigFile));
  const settings = await ManagementSettingsStore.open(resolve(directory, 'candidate-settings.json'), base, voices);
  const selection = { ...availableAdapters(base, voices).find(a => a.id === 'minimax-tts').choices.find(v => v.configuration.model === release.model).configuration,
    credentialRef: receipt.registration.credentialRef, voice: receipt.registration.voiceId };
  const previous = settings.snapshot(); await settings.save(previous.revision, selectedSettings(previous.saved, selection));
  const files = { 'reference.wav': reference, 'sample.wav': sample, 'selected-audition.mp3': audition,
    'source.json': Buffer.from(json({ source: 'ModelScope/villia/dania-original', referenceSha256: sha(reference), originalReferenceSeconds: 20.93,
      sourceManifest: 'artifacts/R1/dania-reference-20s-01/reference-manifest.json', selectedAuditionSha256: sha(audition),
      registration: receipt.registration, firstFormalSynthesis: { evidenceFile: resolve(firstDirectory, 'execution.json'), sha256: sha(receiptBytes),
        requestId: receipt.requestId, firstUseUnlockMicros: receipt.firstUseUnlockMicros, actualMicros: receipt.actualMicros },
      retention: 'Persistent user voice data; retain across restart/update and development artifact cleanup.' })) };
  await mkdir(resolve(directory, 'assets'));
  for (const [name, bytes] of Object.entries(files)) await writeFile(resolve(directory, 'assets', name), bytes, { flag: 'wx', mode: 0o600 });
  const plan = { package: release.package, root, candidate, sourceRevision: revision, toolSha256: sha(await readFile(ownFile)),
    updatePlanFile: resolve(candidate, `artifacts/W0-I/${release.directory}/update/plan.json`), updatePlanSha256: sha(json(prepared.plan)),
    firstReceiptSha256: sha(receiptBytes), registryBeforeSha256: sha(registryBefore), settingsBeforeSha256: sha(settingsBefore),
    registryRevision: JSON.parse(registryBefore).revision, settingsRevision: previous.revision, registration: receipt.registration, selection,
    assetFiles: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)])),
    nextRegistrySha256: sha(await readFile(resolve(directory, 'candidate-registry.json'))),
    nextSettings: JSON.parse(await readFile(resolve(directory, 'candidate-settings.json'))).current.settings,
    pendingMemoryLimit: 'memory_turn Pro fixed reservation remains 11 CNY; actual available balance must be reported after the authorized first synthesis.' };
  await preserve('plan.json', json(plan));
  return { planFile: resolve(directory, 'plan.json'), sha256: sha(json(plan)), runtimeFiles: prepared.runtimeFiles, changedFiles: prepared.changedFiles, selection };
}
async function execute(root, fingerprint) {
  const bytes = await readFile(resolve(directory, 'plan.json')); if (sha(bytes) !== fingerprint) throw Error('Reviewed install plan changed');
  const plan = JSON.parse(bytes);
  if (plan.root !== root || plan.candidate !== candidate || plan.toolSha256 !== sha(await readFile(ownFile))) throw Error('Installation source changed');
  const updateBytes = await readFile(plan.updatePlanFile); if (sha(updateBytes) !== plan.updatePlanSha256) throw Error('Runtime update plan changed');
  const update = JSON.parse(updateBytes), base = JSON.parse(await readFile(update.nextConfigFile));
  await assertTrialQuiescent(base);
  if (sha(await readFile(resolve(root, registryPath))) !== plan.registryBeforeSha256 || sha(await readFile(resolve(root, settingsPath))) !== plan.settingsBeforeSha256) throw Error('User voice or settings changed');
  await absent(resolve(root, newAssetDirectory));
  for (const [name, fingerprint] of Object.entries(plan.assetFiles)) if (sha(await readFile(resolve(directory, 'assets', name))) !== fingerprint) throw Error('Prepared voice asset changed');
  const before = {};
  for (const suffix of ['', '-wal', '-shm']) {
    try { before[suffix] = sha(await readFile(base.database + suffix)); } catch (e) { if (e.code !== 'ENOENT') throw e; before[suffix] = null; }
  }
  const ledgerBefore = await readFile(base.budgetFile);
  await preserve('quiescent-before.json', json({ database: before, ledgerSha256: sha(ledgerBefore), at: new Date().toISOString() }));
  const result = await installTrialUpdate(update);
  // Only after the ordinary runtime update succeeds, append the already verified voice and one settings revision.
  await mkdir(resolve(root, newAssetDirectory));
  for (const name of Object.keys(plan.assetFiles)) await writeFile(resolve(root, newAssetDirectory, name), await readFile(resolve(directory, 'assets', name)), { flag: 'wx', mode: 0o600 });
  const voices = await RegisteredVoiceStore.open(resolve(root, registryPath)); await voices.register(plan.registryRevision, plan.registration);
  const settings = await ManagementSettingsStore.open(resolve(root, settingsPath), base, voices);
  await settings.save(plan.settingsRevision, selectedSettings(settings.snapshot().saved, plan.selection));
  await settings.drain();
  const reopened = await ManagementSettingsStore.open(resolve(root, settingsPath), base, voices);
  if (JSON.stringify(reopened.effective) !== JSON.stringify(plan.nextSettings)) throw Error('Installed effective settings differ');
  if (sha(await readFile(resolve(root, registryPath))) !== plan.nextRegistrySha256) throw Error('Registered voice file differs');
  for (const [suffix, fingerprint] of Object.entries(before)) {
    if (fingerprint === null) await absent(base.database + suffix);
    else if (sha(await readFile(base.database + suffix)) !== fingerprint) throw Error('Business database changed during installation');
  }
  if (sha(await readFile(base.budgetFile)) !== sha(ledgerBefore)) throw Error('Ledger changed during installation');
  const receipt = { ...result, package: plan.package, at: new Date().toISOString(), sourceRevision: plan.sourceRevision,
    settingsRevision: reopened.snapshot().revision, effectiveTts: reopened.effective.providers.tts,
    registeredVoicesRevision: voices.snapshot().revision, preservedQuiescentDatabase: before,
    ledgerSha256: sha(ledgerBefore), settingsHistoryRevisions: reopened.snapshot().history.map(x => x.revision),
    modelCalls: 0, devices: 0, playback: false, started: false };
  await preserve('installation.json', json(receipt)); return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === ownFile) {
  const [mode, root, fingerprint] = process.argv.slice(2);
  if (!root || root !== resolve(root)) throw Error('Explicit project root required');
  process.stdout.write(json(mode === '--check' ? await prepare(root) : mode === '--install' ? await execute(root, fingerprint) : (() => { throw Error('Use --check or --install; add --hd for selected HD'); })()));
}
