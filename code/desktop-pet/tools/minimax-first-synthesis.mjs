import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, realpath, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActiveTrialConfiguration } from '../dist/app/trial-config.js';
import { assertReviewedUnknownCosts } from '../dist/app/trial-authorizer.js';
import { TrialTransport, createTrialTtsProvider } from '../dist/app/trial-backend.js';
import { EvaluationBudget } from '../dist/core/evaluation-budget.js';
import { RegisteredVoiceStore } from '../dist/providers/registered-voices.js';
import { MINIMAX_TTS_MODEL, MINIMAX_TTS_ENDPOINT } from '../dist/providers/minimax-tts.js';
import { credentialRegistry } from '../dist/management/credentials.js';
import { defaultManagedSettings, availableAdapters, effectiveTrialConfiguration, validateManagedSettings } from '../dist/management/settings.js';
import { MemoryMediaStore } from '../dist/media/store.js';
import { inspectPcmWav } from '../dist/media/wav.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
export function minimaxReleaseProfile(hd = false) {
  return Object.freeze(hd ? {
    package: 'B-MINIMAX-HD-DEFAULT-01', directory: 'minimax-hd-default-01', model: 'MiniMax/speech-2.8-hd', characterMicros: 350,
    label: '达妮娅（MiniMax HD）', voiceId: 'DaniaCnHDa40702e4644a4edc934cf8782b583e1b',
    cloneFile: 'artifacts/worktrees/W0-I-tts-cn-audition-01/artifacts/W0-I/tts-cn-audition-01/hd/execution.json',
    cloneSha: 'd1c2ffd11153d1215c5a2eb13e15def2b091c1db142f12362f5d6f1c80ef4199',
    auditionFile: 'artifacts/worktrees/W0-I-tts-cn-audition-01/artifacts/W0-I/tts-cn-audition-01/hd/hd-same-reference-demo.mp3',
    auditionSha: '1be6fab64885b9b8138e4ba8d58edce78186f440bbdc746a3eacb964a4e816af', assetDirectory: 'dania-minimax-hd',
  } : {
    package: 'B-MINIMAX-DEFAULT-01', directory: 'minimax-default-01', model: MINIMAX_TTS_MODEL, characterMicros: 200,
    label: '达妮娅（MiniMax）', voiceId: 'DaniaCompare0925a9fc82d94a2691d83b7267db2e5a',
    cloneFile: 'artifacts/worktrees/W0-I-dania-tts-compare-01/artifacts/W0-I/dania-tts-compare-01/minimax/execution.json',
    cloneSha: 'c9c58992d6dd0640d892d4823c9d7c5f25208f02b7d4ded38b0f0d3f70748e21',
    auditionFile: 'artifacts/worktrees/W0-I-dania-tts-compare-01/artifacts/W0-I/dania-tts-compare-01/minimax/minimax-same-reference-demo.mp3',
    auditionSha: 'f8f85be862c91c202194907d18eb8590f53c7fd936bb5fc10674d0f99e652d12', assetDirectory: 'dania-minimax',
  });
}
export function firstUseBudget(state, characterMicros) {
  if (![200, 350].includes(characterMicros) || ![20_000_000, 60_000_000].includes(state.limitMicros) || !Array.isArray(state.entries)) throw Error('Original reviewed budget required');
  const reserved = 9_900_000 + Buffer.byteLength(text, 'utf8') * characterMicros;
  const committed = state.entries.reduce((sum, e) => sum + (e.actualMicros ?? e.reservedMicros), 0);
  return { reservationMicros: reserved, availableMicros: state.limitMicros - committed, requiredTotalMicros: committed + reserved,
    shortfallMicros: Math.max(0, committed + reserved - state.limitMicros), withinCurrentBudget: committed + reserved <= state.limitMicros };
}
const release = minimaxReleaseProfile(process.argv.includes('--hd'));
const prefix = `W0-I:${release.package}:`;
const operationId = prefix + 'first-formal-synthesis';
const { cloneFile, cloneSha } = release;
const text = '今天的事先放一放。喝点水，早点休息，明天再慢慢来，好吗？';
const scope = { characterId: 'companion', sessionId: 'integration-minimax-first', turnId: 'fixed-one-call', generation: 1 };
const expression = { emotion: 'neutral', intensity: .4, delivery: '', gesture: null };
const ownFile = fileURLToPath(import.meta.url), candidate = resolve(dirname(ownFile), '../../..');
const output = resolve(candidate, `artifacts/W0-I/${release.directory}/first-synthesis`);
async function save(name, value) { await writeFile(resolve(output, name), typeof value === 'string' || value instanceof Uint8Array ? value : json(value), { flag: 'wx', mode: 0o600 }); }
async function fingerprints(directory, result = {}) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'tests') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await fingerprints(path, result);
    else if (entry.name.endsWith('.js')) result[relative(candidate, path)] = sha(await readFile(path));
  }
  return result;
}
async function context(root) {
  const configFile = resolve(root, 'artifacts/W0-I/model-evaluation/trial/user-trial/config.json');
  const activationFile = resolve(dirname(configFile), 'activation.json');
  const base = await readActiveTrialConfiguration(configFile, activationFile);
  const cloneBytes = await readFile(resolve(root, cloneFile)); if (sha(cloneBytes) !== cloneSha) throw Error('Selected clone evidence changed');
  const clone = JSON.parse(cloneBytes);
  if (clone.status !== 'sample_ready_for_user_listening' || clone.voice.model !== release.model || clone.voice.voiceId !== release.voiceId
    || (release.model === MINIMAX_TTS_MODEL ? clone.voice.unlockFeeCharged : clone.voice.firstFormalUnlockTriggered) !== false
    || clone.calls.length !== 1 || clone.calls[0].response.output.base_resp.status_code !== 0) throw Error('Selected clone has no exact successful receipt');
  const reviewedUnknownCosts = base.reviewedUnknownCosts;
  const ledger = await readFile(base.budgetFile), state = JSON.parse(ledger);
  await assertReviewedUnknownCosts(state.entries, { ...base, reviewedUnknownCosts });
  if (state.batchId !== 'D09-S1-20260906-01' || ![20_000_000, 60_000_000].includes(state.limitMicros) || state.blocked
    || state.entries.some(e => e.status === 'reserved' || e.operationId === operationId)) throw Error('Original budget is not ready or call was already attempted');
  const savedSettings = JSON.parse(await readFile(resolve(dirname(configFile), 'management-settings.json')));
  const credentialRef = clone.voice.credentialRef ?? savedSettings.current.settings.providers.tts.credentialRef;
  credentialRegistry(base).file(credentialRef, 'dashscope');
  const registration = { voiceId: clone.voice.voiceId, label: release.label, provider: 'dashscope', endpoint: MINIMAX_TTS_ENDPOINT,
    targetModel: release.model, credentialRef, referenceSha256: clone.voice.referenceSha256, createdAt: clone.finishedAt };
  return { base, configFile, activationFile, registration, reviewedUnknownCosts, ledger };
}
export function firstUseCost(raw, characterMicros = 200) {
  const n = raw?.usage?.characters;
  return raw?.output?.base_resp?.status_code === 0 && raw?.output?.data?.status === 2 && Number.isSafeInteger(n) && n >= 0
    && [200, 350].includes(characterMicros) && Number.isSafeInteger(9_900_000 + n * characterMicros) ? 9_900_000 + n * characterMicros : null;
}
async function prepare(root, draft = false) {
  const c = await context(root), sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim();
  if (execFileSync('git', ['diff', 'HEAD', '--', 'code/desktop-pet'], { cwd: candidate, encoding: 'utf8' }).trim()) throw Error('Commit candidate source before freezing');
  const state = JSON.parse(c.ledger), budget = firstUseBudget(state, release.characterMicros), { reservationMicros } = budget;
  if (!draft && !budget.withinCurrentBudget) throw Error('Original budget cannot cover first use');
  await mkdir(output, { recursive: true });
  const plan = { package: release.package, root, candidate, sourceRevision, toolSha256: sha(await readFile(ownFile)),
    runtimeFiles: draft ? {} : await fingerprints(resolve(candidate, 'code/desktop-pet/dist')),
    configSha256: sha(await readFile(c.configFile)), activationSha256: sha(await readFile(c.activationFile)),
    ledgerSha256: sha(c.ledger), cloneFile, cloneSha256: cloneSha, registration: c.registration, reviewedUnknownCosts: c.reviewedUnknownCosts,
    operationId, model: release.model, endpoint: MINIMAX_TTS_ENDPOINT, text, expression,
    audio: { sampleRate: 24000, format: 'wav', channels: 1, output: 'hex' }, maxCalls: 1, retries: 0,
    firstUseUnlockMicros: 9_900_000, characterMicros: release.characterMicros, characterUpperBound: Buffer.byteLength(text, 'utf8'), reservationMicros,
    devices: 0, playback: false, cloneCalls: 0, uploads: 0, permanentRegistration: false, install: false };
  if (draft) {
    const registryFile = resolve(output, 'draft-candidate-voices.json');
    const registryBefore = await readFile(resolve(root, 'data/desktop-pet/registered-voices.json'));
    const settingsBefore = await readFile(resolve(dirname(c.configFile), 'management-settings.json'));
    await save('draft-candidate-voices.json', registryBefore);
    const registry = await RegisteredVoiceStore.open(registryFile); await registry.register(registry.snapshot().revision, c.registration);
    const saved = JSON.parse(settingsBefore).current.settings;
    const choice = availableAdapters(c.base, registry).find(a => a.id === 'minimax-tts').choices.find(v => v.configuration.model === release.model);
    const settings = structuredClone(saved); settings.providers.tts = { ...choice.configuration, voice: c.registration.voiceId, credentialRef: c.registration.credentialRef };
    validateManagedSettings(settings, c.base, registry); effectiveTrialConfiguration(c.base, settings);
    await save('draft-candidate-settings.json', settings);
    const review = { ...plan, status: 'candidate_only_budget_approval_required', executable: false, budget,
      candidateSettings: settings.providers.tts, originalRegistrySha256: sha(registryBefore), originalSettingsSha256: sha(settingsBefore), actualDefaultChanged: false, modelCalls: 0,
      pending: 'Exact budget authorization and ceiling migration, one successful formal synthesis, then normal preserving installation. Draft is never an executable paid plan.' };
    await save('candidate-plan.json', review);
    return { path: resolve(output, 'candidate-plan.json'), sha256: sha(json(review)), budget, modelCalls: 0, actualDefaultChanged: false };
  }
  await save('plan.json', plan); return { planFile: resolve(output, 'plan.json'), sha256: sha(json(plan)), reservationMicros };
}
async function execute(root, expectedHash) {
  const bytes = await readFile(resolve(output, 'plan.json')); if (sha(bytes) !== expectedHash) throw Error('Frozen first-use plan changed');
  const plan = JSON.parse(bytes), c = await context(root);
  if (plan.root !== root || plan.candidate !== candidate || plan.toolSha256 !== sha(await readFile(ownFile))
    || plan.ledgerSha256 !== sha(c.ledger) || plan.configSha256 !== sha(await readFile(c.configFile))
    || plan.activationSha256 !== sha(await readFile(c.activationFile)) || JSON.stringify(plan.registration) !== JSON.stringify(c.registration)
    || JSON.stringify(plan.reviewedUnknownCosts) !== JSON.stringify(c.reviewedUnknownCosts)) throw Error('Frozen first-use inputs changed');
  for (const [path, fingerprint] of Object.entries(plan.runtimeFiles)) if (sha(await readFile(resolve(candidate, path))) !== fingerprint) throw Error('Candidate runtime changed');
  await save('ledger-before.json', c.ledger);
  const registry = await RegisteredVoiceStore.open(resolve(output, 'candidate-voices.json')); await registry.register(0, c.registration);
  const settings = defaultManagedSettings(c.base);
  settings.providers.tts = { ...availableAdapters(c.base, registry).find(a => a.id === 'minimax-tts').choices.find(v => v.configuration.model === release.model).configuration, credentialRef: c.registration.credentialRef };
  const effective = effectiveTrialConfiguration({ ...c.base, reviewedUnknownCosts: c.reviewedUnknownCosts }, settings);
  const keyFile = credentialRegistry(c.base).file(c.registration.credentialRef, 'dashscope');
  const keyPath = await realpath(keyFile), info = await stat(keyPath);
  if (keyPath.startsWith(root + '/') || !info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw Error('Restricted external key required');
  const budget = new EvaluationBudget(c.base.budgetFile, c.base.budgetBatchId, c.base.limitMicros);
  let authorized = false, reserved = false, posts = 0, responseRaw, outcome, settled = false;
  const evidence = { package: plan.package, sourceRevision: plan.sourceRevision, planSha256: expectedHash,
    startedAt: new Date().toISOString(), status: 'started', model: plan.model, voiceId: c.registration.voiceId,
    devices: 0, playback: false, uploads: 0, cloneCalls: 0, installed: false };
  await save('started.json', evidence);
  const authorizer = { async authorize(request, signal) {
    signal.throwIfAborted();
    if (authorized || request.operation !== 'tts' || request.model !== plan.model || request.endpoint !== plan.endpoint
      || request.textCharacters !== plan.characterUpperBound || JSON.stringify(request.scope) !== JSON.stringify(scope)) throw Error('Only the frozen first synthesis is allowed');
    authorized = true; await budget.reserve(operationId, plan.model, plan.reservationMicros, { operationIdPrefix: prefix, limitMicros: plan.reservationMicros, maxCalls: 1 }); reserved = true;
    return { async settle(value) { outcome = value; await budget.settle(operationId, firstUseCost(responseRaw, plan.characterMicros)); settled = true; } };
  } };
  const transport = new TrialTransport(effective, async (url, init) => {
    if (++posts !== 1 || url !== plan.endpoint || init?.method !== 'POST') throw Error('No retry, download or unrelated endpoint');
    const body = JSON.parse(String(init.body));
    if (body.input.text !== plan.text || body.input.voice_setting.voice_id !== c.registration.voiceId) throw Error('Fixed text and selected voice required');
    const response = await fetch(url, init); evidence.httpStatus = response.status;
    const rawText = await response.clone().text(); evidence.responseSha256 = sha(rawText);
    try { responseRaw = JSON.parse(rawText); } catch { responseRaw = null; }
    const hex = responseRaw?.output?.data?.audio;
    if (typeof hex === 'string' && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)) {
      const audio = Buffer.from(hex, 'hex'); await save('raw-audio.wav', audio);
      evidence.rawAudio = { bytes: audio.length, sha256: sha(audio) };
    }
    const sanitized = structuredClone(responseRaw);
    if (sanitized?.output?.data?.audio !== undefined) sanitized.output.data.audio = '[audio retained separately]';
    await save('response.json', sanitized); return response;
  });
  const store = new MemoryMediaStore();
  try {
    const endpoint = { ...effective.models.tts, authorizer, apiKey: () => {
      const key = readFileSync(keyPath, 'utf8').trim(); if (!/^sk-[A-Za-z0-9_-]+$/.test(key)) throw Error('Invalid restricted key'); return key;
    } };
    const provider = createTrialTtsProvider(settings.providers.tts, endpoint, store, transport, registry);
    const result = await provider.synthesize({ scope, text: plan.text, expression: plan.expression }, AbortSignal.timeout(180_000));
    const audio = await store.read(scope, result.audio), wav = inspectPcmWav(audio);
    await save('sample.wav', audio);
    evidence.status = 'formal_synthesis_verified_not_installed'; evidence.registration = c.registration;
    evidence.sample = { bytes: audio.length, sha256: sha(audio), pcmSha256: sha(wav.data), durationMs: wav.durationMs, sampleRate: wav.sampleRate, channels: wav.channels };
    evidence.firstUseUnlockMicros = 9_900_000;
  } catch (error) { evidence.status = 'failed_stopped_no_retry'; evidence.failure = { name: error.name, message: error.message }; }
  finally {
    await store.releaseScope(scope);
    if (reserved && !settled) await budget.settle(operationId, null);
    const after = await readFile(c.base.budgetFile), state = JSON.parse(after);
    await save('ledger-after.json', after);
    Object.assign(evidence, { finishedAt: new Date().toISOString(), posts, actualMicros: state.entries.find(e => e.operationId === operationId)?.actualMicros ?? null,
      requestId: responseRaw?.request_id ?? outcome?.requestId ?? null, ledgerSha256: sha(after),
      previousEntriesPreserved: JSON.stringify(state.entries.filter(e => e.operationId !== operationId)) === JSON.stringify(JSON.parse(c.ledger).entries),
      entry: state.entries.find(e => e.operationId === operationId), mediaReleased: store.count === 0 });
    await save('execution.json', evidence);
  }
  return { status: evidence.status, posts, actualMicros: evidence.actualMicros, sample: evidence.sample, requestId: evidence.requestId };
}
if (process.argv[1] && resolve(process.argv[1]) === ownFile) {
  const [mode, root, hash] = process.argv.slice(2);
  if (!root || root !== resolve(root)) throw Error('Explicit project root required');
  const result = mode === '--draft' ? await prepare(root, true) : mode === '--check' ? await prepare(root) : mode === '--execute' ? await execute(root, hash) : (() => { throw Error('Use --draft, --check or --execute; add --hd for selected HD'); })();
  process.stdout.write(json(result));
}
