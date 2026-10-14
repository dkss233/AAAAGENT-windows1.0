import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, stat, realpath, unlink, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvaluationBudget } from '../dist/core/evaluation-budget.js';
import { readActiveTrialConfiguration } from '../dist/app/trial-config.js';
import { assertReviewedUnknownCosts } from '../dist/app/trial-authorizer.js';
import { audioDownloadUrl } from '../dist/providers/qwen-tts.js';
import { inspectSource, sentence } from './dania-tts-compare.mjs';
import { uploadReference, inspectAudio, redact } from './minimax-voice-audition.mjs';

export const prefix = 'W0-I:B-TTS-CN-AUDITION-01:';
const models = { cosy: 'cosyvoice-v3.5-plus', hd: 'MiniMax/speech-2.8-hd' };
const endpoints = { create: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization',
  tts: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
  hd: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' };
const sha = b => createHash('sha256').update(b).digest('hex');
const json = v => JSON.stringify(v, null, 2) + '\n';
const ownFile = fileURLToPath(import.meta.url), candidate = resolve(dirname(ownFile), '../../..');
const oldReference = 'artifacts/worktrees/W0-I-dania-tts-compare-01/artifacts/W0-I/dania-tts-compare-01/qwen/upload/reference.json';
export function requests(provider, reference, voiceId) {
  if (provider === 'cosy') return {
    create: { model: 'voice-enrollment', input: { action: 'create_voice', target_model: models.cosy, prefix: 'daniacn',
      url: reference.url, language_hints: ['zh'], max_prompt_audio_length: 20.93, enable_preprocess: false, enable_volume_normalization: 'false' } },
    tts: { model: models.cosy, input: { text: sentence, voice: '$CREATED_VOICE', format: 'mp3', sample_rate: 24000, language_hints: ['zh'] } },
  };
  if (provider === 'hd' && /^DaniaCnHD[A-Za-z0-9]+$/.test(voiceId)) return {
    clone: { model: models.hd, input: { action: 'voice_clone', voice_id: voiceId, audio_url: reference.url, text: sentence,
      language_boost: 'Chinese', need_noise_reduction: false, need_volume_normalization: false } },
  };
  throw Error('Unregistered audition provider');
}
export function validateLedger(state, batch, provider) {
  if (!models[provider] || state.batchId !== batch || state.currency !== 'CNY' || state.limitMicros !== 20_000_000 || state.blocked
    || !Array.isArray(state.entries) || state.entries.some(e => !['settled', 'unknown'].includes(e.status)
      || !Number.isSafeInteger(e.reservedMicros) || e.reservedMicros <= 0 || e.operationId.startsWith(prefix + provider + ':')
      || (e.status === 'unknown' ? e.actualMicros !== null : !Number.isSafeInteger(e.actualMicros) || e.actualMicros < 0))) throw Error('Budget unavailable, active or audition already attempted');
  const available = state.limitMicros - state.entries.reduce((sum, e) => sum + (e.actualMicros ?? e.reservedMicros), 0);
  if (available < 50_000) throw Error('Insufficient conservative audition balance');
  return available;
}
export async function runAudition(plan, key, fetcher = fetch, probe = inspectAudio) {
  await mkdir(plan.outputDirectory, { recursive: true });
  const reportFile = resolve(plan.outputDirectory, 'execution.json');
  const report = { package: 'B-TTS-CN-AUDITION-01', provider: plan.provider, startedAt: new Date().toISOString(),
    status: 'running', calls: [], downloads: 0, modelQueries: 0, devices: 0, playback: false, installed: false };
  await writeFile(reportFile, json(report), { flag: 'wx', mode: 0o600 });
  const record = () => writeFile(reportFile, json(report));
  const beforeBytes = await readFile(plan.budgetFile), before = JSON.parse(beforeBytes);
  const budget = new EvaluationBudget(plan.budgetFile, plan.budgetBatchId, 20_000_000);
  const post = async (kind, endpoint, body, unit, resolveSource = false) => {
    const id = prefix + plan.provider + ':' + kind;
    const reservation = unit ? Buffer.byteLength(sentence, 'utf8') * unit : 1;
    const credential = key(); await budget.reserve(id, body.model, reservation, { operationIdPrefix: prefix, limitMicros: 500_000, maxCalls: 4 });
    const call = { operationId: id, kind, model: body.model, reservedMicros: reservation, status: 'started' };
    report.calls.push(call); await record(); let actual = unit ? null : 0;
    try {
      const response = await fetcher(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + credential,
        'Content-Type': 'application/json; charset=utf-8', ...(resolveSource ? { 'X-DashScope-OssResourceResolve': 'enable' } : {}) },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(120_000) });
      call.httpStatus = response.status; const raw = await response.text(); let result;
      try { result = JSON.parse(raw); } catch { call.responseText = redact(raw); throw Error('Non-JSON response'); }
      call.response = redact(result); call.requestId = result.request_id ?? null;
      if (unit && Number.isSafeInteger(result.usage?.characters) && result.usage.characters >= 0) actual = result.usage.characters * unit;
      if (!response.ok || result.code || result.error || (plan.provider === 'hd' && result.output?.base_resp?.status_code !== 0))
        throw Error(`Provider ${response.status}: ${result.code ?? result.error?.code ?? result.output?.base_resp?.status_code ?? 'error'}`);
      if (unit && (actual === null || actual > reservation)) throw Error('Missing or excessive usage');
      call.status = 'success'; return result;
    } catch (error) { call.status = 'failed'; call.failure = redact({ name: error.name, message: error.message }); throw error; }
    finally { call.actualMicros = actual; await budget.settle(id, actual); await record(); }
  };
  try {
    if (sha(beforeBytes) !== plan.ledgerSha256 || JSON.stringify(plan.requests) !== JSON.stringify(requests(plan.provider, plan.reference, plan.voiceId))) throw Error('Frozen inputs changed');
    validateLedger(before, plan.budgetBatchId, plan.provider);
    let response, url;
    if (plan.provider === 'cosy') {
      const created = await post('create', endpoints.create, plan.requests.create, 0, true);
      const voice = created.output?.voice_id;
      if (created.usage?.count !== 1 || typeof voice !== 'string' || !/^cosyvoice-v3\.5-plus-daniacn-[A-Za-z0-9_-]+$/.test(voice)) throw Error('Unexpected CosyVoice enrollment result');
      report.voice = { voiceId: voice, model: models.cosy, referenceSha256: plan.reference.sha256 }; await record();
      response = await post('tts', endpoints.tts, { ...plan.requests.tts, input: { ...plan.requests.tts.input, voice } }, 150);
      if (response.output?.finish_reason !== 'stop') throw Error('Incomplete CosyVoice synthesis');
      url = audioDownloadUrl(response.output?.audio?.url);
    } else {
      response = await post('clone-demo', endpoints.hd, plan.requests.clone, 350, true);
      if (response.output?.input_sensitive !== false || response.output?.input_sensitive_type !== 0) throw Error('HD input rejected');
      url = response.output.demo_audio;
      report.voice = { voiceId: plan.voiceId, model: models.hd, referenceSha256: plan.reference.sha256, firstFormalUnlockTriggered: false };
    }
    const privateFile = resolve(plan.outputDirectory, 'audio-location.private.json');
    await writeFile(privateFile, json({ url }), { flag: 'wx', mode: 0o600 });
    const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw Error('Invalid sample location');
    report.downloads++; const downloaded = await fetcher(parsed.href, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const bytes = new Uint8Array(await downloaded.arrayBuffer()), rawFile = resolve(plan.outputDirectory, 'sample-original.bin');
    await writeFile(rawFile, bytes, { flag: 'wx', mode: 0o600 });
    report.rawAudio = { bytes: bytes.length, sha256: sha(bytes), httpStatus: downloaded.status };
    if (!downloaded.ok || bytes.length > 20 * 1024 * 1024) throw Error('Audio download failed');
    const shape = await probe(rawFile); if (shape.format !== 'mp3' || shape.durationMs <= 0 || shape.durationMs > 60_000) throw Error('Unexpected audition audio');
    const path = resolve(plan.outputDirectory, plan.provider + '-same-reference-demo.mp3'); await rename(rawFile, path);
    report.sample = { path, ...shape, text: sentence, bytes: bytes.length, sha256: sha(bytes) };
    report.status = 'sample_ready_for_user_listening'; await unlink(privateFile);
  } catch (error) { report.status = 'failed_stopped_no_retry'; report.failure = redact({ name: error.name, message: error.message }); }
  finally {
    const after = JSON.parse(await readFile(plan.budgetFile));
    report.historicalLedgerUnchanged = JSON.stringify(after.entries.slice(0, before.entries.length)) === JSON.stringify(before.entries);
    report.entries = after.entries.filter(e => e.operationId.startsWith(prefix + plan.provider + ':'));
    report.finishedAt = new Date().toISOString(); await record();
  }
  return report;
}
async function main() {
  const [mode, provider, root, fingerprint] = process.argv.slice(2);
  if (!['--upload-hd', '--check', '--execute'].includes(mode) || !models[provider] || await realpath(root) !== root) throw Error('Explicit mode/provider/root required');
  const out = resolve(candidate, 'artifacts/W0-I/tts-cn-audition-01', provider);
  const directory = resolve(root, 'artifacts/W0-I/model-evaluation/trial/user-trial');
  const configuration = await readActiveTrialConfiguration(directory + '/config.json', directory + '/activation.json');
  const ledgerBytes = await readFile(configuration.budgetFile), ledger = JSON.parse(ledgerBytes);
  const available = validateLedger(ledger, configuration.budgetBatchId, provider); await assertReviewedUnknownCosts(ledger.entries, configuration);
  const keyFile = await realpath(configuration.models.tts.credentialFile), info = await stat(keyFile);
  if (keyFile.startsWith(root + '/') || !info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('Existing restricted key required');
  const key = () => { const value = readFileSync(keyFile, 'utf8').trim(); if (!/^sk-[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid key'); return value; };
  const refFile = mode === '--upload-hd' || provider === 'cosy' ? resolve(root, oldReference) : resolve(out, 'upload/reference.json');
  const refBytes = await readFile(refFile), reference = JSON.parse(refBytes), inspection = await inspectSource(reference);
  if (reference.sha256 !== '85ad404ca567836aa2ab4e38a30ad7d15b5b1e2bd8ac25bbffee168631ba5e08' || inspection.durationMs !== 20930) throw Error('Only original20.93s reference permitted');
  if (mode === '--upload-hd') {
    if (provider !== 'hd') throw Error('Only new HD-bound upload permitted');
    const result = await uploadReference(reference, key, resolve(out, 'upload'), fetch, models.hd, inspectSource);
    console.log(json({ status: result.status, uploads: result.uploads, output: result.referenceMetadataFile })); return;
  }
  if (!reference.url?.startsWith('oss://') || reference.uploadModel !== (provider === 'cosy' ? 'voice-enrollment' : models.hd)
    || !Number.isFinite(Date.parse(reference.uploadedAt)) || Date.now() - Date.parse(reference.uploadedAt) > 46 * 3600_000 || Date.parse(reference.uploadedAt) > Date.now()) throw Error('Fresh provider-bound upload required');
  const file = resolve(out, 'plan.json'), previous = mode === '--execute' ? await readFile(file) : null;
  const voiceId = previous ? JSON.parse(previous).voiceId : provider === 'hd' ? 'DaniaCnHD' + randomUUID().replaceAll('-', '') : null;
  const support = ['tools/dania-tts-compare.mjs', 'tools/minimax-voice-audition.mjs', 'dist/core/evaluation-budget.js', 'dist/app/trial-authorizer.js',
    'dist/app/trial-config.js', 'dist/providers/qwen-tts.js', 'dist/media/wav.js'];
  const plan = { package: 'B-TTS-CN-AUDITION-01', provider, root, candidate, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim(),
    toolSha256: sha(await readFile(ownFile)), supportHashes: Object.fromEntries(await Promise.all(support.map(async p => [p, sha(await readFile(resolve(candidate, 'code/desktop-pet', p)))]))),
    reference, referenceMetadataSha256: sha(refBytes), referenceInspection: inspection, voiceId, requests: requests(provider, reference, voiceId),
    availableMicros: available, phaseLimitMicros: 500_000, maxModelCalls: 4, thisModelCalls: provider === 'cosy' ? 2 : 1,
    budgetFile: configuration.budgetFile, budgetBatchId: configuration.budgetBatchId, ledgerSha256: sha(ledgerBytes),
    configSha256: sha(await readFile(directory + '/config.json')), settingsSha256: sha(await readFile(directory + '/management-settings.json')),
    outputDirectory: out, retries: 0, devices: 0, install: false, noFormalHDUnlock: true };
  await mkdir(out, { recursive: true });
  if (mode === '--check') { const bytes = json(plan); await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); console.log(json({ path: file, sha256: sha(bytes), modelCalls: 0 })); return; }
  if (sha(previous) !== fingerprint || JSON.stringify(JSON.parse(previous)) !== JSON.stringify(plan)) throw Error('Exact audition plan changed');
  const result = await runAudition(plan, key); console.log(json({ status: result.status, sample: result.sample, calls: result.calls.length }));
  if (result.status === 'failed_stopped_no_retry') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === ownFile) await main();
