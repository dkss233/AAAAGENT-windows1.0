import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvaluationBudget } from '../dist/core/evaluation-budget.js';
import { readActiveTrialConfiguration } from '../dist/app/trial-config.js';
import { credentialRegistry } from '../dist/management/credentials.js';
import { normalizeQwenAudioWav } from '../dist/providers/qwen-audio-tts.js';
import { audioDownloadUrl, billedCharacters } from '../dist/providers/qwen-tts.js';
import { inspectPcmWav } from '../dist/media/wav.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const prefix = 'W0-I:B-DANIA-VOICE-CLONE-01:';
const model = 'qwen-audio-3.0-tts-plus';
const createEndpoint = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization';
const ttsEndpoint = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const referenceUrl = 'https://www.modelscope.cn/api/v1/models/villia/dania/repo?Revision=3bfd54139e141702c1b4a4a744188d234df6620d&FilePath=output.wav_0009342720_0009558400.wav';
const referenceSha256 = '98cde6a626505e531d0297b5e9ad99f0aec274077ef6bc9540c83dad89c945c8';
const sampleText = '今天的事先放一放。喝点水，早点休息，明天再慢慢来，好吗？';
export function redact(value, key = '') {
  if (/authorization|token|api.?key|url/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"']+/g, '[url]').replace(/sk-[A-Za-z0-9_-]+/g, '[key]').slice(0, 4000);
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}
/** Fixed one-create/one-sample flow. Injectable transport is used only by local tests. */
export async function runDania(plan, apiKey, fetcher = fetch) {
  const output = plan.outputDirectory; await mkdir(output, { recursive: true });
  const file = resolve(output, 'execution.json');
  const report = { package: 'B-DANIA-VOICE-CLONE-01', startedAt: new Date().toISOString(), status: 'running', posts: 0, downloads: 0, calls: [] };
  await writeFile(file, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
  const budget = new EvaluationBudget(plan.budgetFile, plan.budgetBatchId, 20000000), before = JSON.parse(await readFile(plan.budgetFile));
  const record = () => writeFile(file, JSON.stringify(report, null, 2) + '\n');
  const post = async (kind, endpoint, body, reservation) => {
    if (report.posts >= 2) throw new Error('Dania POST cap reached');
    const id = prefix + kind; report.stage = kind;
    // Never let a missing original ledger turn into a new empty account.
    const ledger = JSON.parse(await readFile(plan.budgetFile));
    if (ledger.batchId !== plan.budgetBatchId || ledger.blocked || ledger.entries.some(e => e.status !== 'settled')) throw new Error('Original ledger unavailable or unsettled');
    await budget.reserve(id, body.model, reservation, { operationIdPrefix: prefix, limitMicros: 400000, maxCalls: 2 });
    let actual = kind === 'create' ? 0 : null;
    const call = { kind, operationId: id, status: 'started', httpStatus: null }; report.calls.push(call);
    try {
      const key = apiKey(); report.posts++;
      const response = await fetcher(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000), redirect: 'error' });
      call.httpStatus = response.status;
      const raw = await response.text(); let json;
      try { json = JSON.parse(raw); } catch { call.responseText = redact(raw); throw new Error('Provider returned non-JSON'); }
      call.response = redact(json);
      if (kind === 'synthesize' && Number.isSafeInteger(json.usage?.characters) && json.usage.characters >= 0) actual = json.usage.characters * 140;
      if (!response.ok || json.code || json.error) throw new Error(`Provider ${response.status} ${String(json.code ?? json.error?.code ?? 'error')}`);
      if (kind === 'synthesize' && (actual === null || actual > reservation)) throw new Error('Missing or excessive synthesis usage');
      call.status = 'success'; return json;
    } catch (error) { call.status = 'failed'; call.error = redact({ name: error.name, code: error.cause?.code ?? error.code, message: error.message }); throw error; }
    finally { call.actualMicros = actual; await budget.settle(id, actual); await record(); }
  };
  try {
    const created = await post('create', createEndpoint, { model: 'voice-enrollment', input: { action: 'create_voice', target_model: model,
      prefix: 'dania', url: referenceUrl, language_hints: ['zh'], enable_volume_normalization: 'false' } }, 1);
    const voiceId = created.output?.voice_id;
    if (typeof voiceId !== 'string' || !/^qwen-audio-3\.0-tts-plus-dania-[A-Za-z0-9_-]{1,100}$/.test(voiceId)
      || created.usage?.count !== 1) throw new Error('Unexpected clone registration response');
    report.registration = { voiceId, label: '达妮娅（复刻）', provider: 'dashscope', endpoint: ttsEndpoint, targetModel: model,
      credentialRef: plan.credentialRef, referenceSha256, createdAt: new Date().toISOString() };
    await record();
    const start = performance.now();
    const speech = await post('synthesize', ttsEndpoint, { model, input: { text: sampleText, voice: voiceId,
      format: 'wav', sample_rate: 24000, instruction: '自然温和，像日常聊天一样说话。', language_hints: ['zh'] } }, 400000);
    if (speech.output?.finish_reason !== 'stop' || typeof speech.output?.audio?.url !== 'string') throw new Error('Incomplete synthesis response');
    report.stage = 'download'; report.downloads++;
    const response = await fetcher(audioDownloadUrl(speech.output.audio.url), { signal: AbortSignal.timeout(30000), redirect: 'error' });
    report.downloadHttpStatus = response.status;
    const raw = new Uint8Array(await response.arrayBuffer()); await writeFile(resolve(output, 'sample-original.bin'), raw, { flag: 'wx' });
    report.rawAudio = { bytes: raw.length, sha256: sha(raw), first64Hex: Buffer.from(raw.subarray(0, 64)).toString('hex') };
    if (!response.ok) throw new Error(`Audio download HTTP ${response.status}`);
    report.stage = 'wav_validation';
    const audio = normalizeQwenAudioWav(raw), wav = inspectPcmWav(audio);
    if (wav.sampleRate !== 24000 || wav.channels !== 1 || wav.bits !== 16) throw new Error('Unexpected clone WAV format');
    const sampleFile = resolve(output, 'dania-sample.wav'); await writeFile(sampleFile, audio, { flag: 'wx' });
    report.sample = { path: sampleFile, sha256: sha(audio), bytes: audio.length, sampleRate: wav.sampleRate, channels: wav.channels,
      durationMs: wav.durationMs, completePlayableMs: Math.round(performance.now() - start), pcmSha256: sha(wav.data), text: sampleText, billedCharacters: billedCharacters(sampleText) };
    report.stage = 'complete'; report.status = 'created_and_sample_format_verified_not_listened';
  } catch (error) { report.status = 'failed_stopped_no_retry'; report.failure = redact({ name: error.name, code: error.cause?.code ?? error.code, message: error.message }); }
  finally {
    report.finishedAt = new Date().toISOString(); report.devices = 0; report.playback = false;
    const after = JSON.parse(await readFile(plan.budgetFile)); report.entries = after.entries.filter(e => e.operationId.startsWith(prefix));
    report.historicalLedgerUnchanged = JSON.stringify(after.entries.slice(0, before.entries.length)) === JSON.stringify(before.entries);
    await record();
  }
  return report;
}

async function main() {
  const [mode, root, expectedHash] = process.argv.slice(2); if (!['--check', '--execute'].includes(mode) || await realpath(root) !== root) throw new Error('Explicit mode and canonical root required');
  const candidate = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), outputDirectory = resolve(candidate, 'artifacts/W0-I/dania-voice-clone-01/execution');
  const configFile = resolve(root, 'artifacts/W0-I/model-evaluation/trial/user-trial/config.json'), activationFile = resolve(dirname(configFile), 'activation.json');
  const config = await readActiveTrialConfiguration(configFile, activationFile), ledgerBytes = await readFile(config.budgetFile), ledger = JSON.parse(ledgerBytes);
  if (ledger.batchId !== config.budgetBatchId || ledger.blocked || ledger.limitMicros !== 20000000 || ledger.entries.some(e => e.status !== 'settled' || e.operationId.startsWith(prefix))) throw new Error('Original ledger not ready or package already used');
  const remaining = ledger.limitMicros - ledger.entries.reduce((s, e) => s + e.actualMicros, 0); if (remaining < 400000) throw new Error('Shared budget insufficient');
  const referenceFile = resolve(root, 'data/desktop-pet/voice-assets/dania/reference.wav'); if (sha(await readFile(referenceFile)) !== referenceSha256) throw new Error('Reference changed');
  const credentialRef = credentialRegistry(config).ref(config.models.tts.credentialFile, 'dashscope');
  const support = ['dist/core/evaluation-budget.js', 'dist/providers/qwen-audio-tts.js', 'dist/providers/qwen-tts.js', 'dist/media/wav.js'];
  const plan = { package: 'B-DANIA-VOICE-CLONE-01', root, candidate, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim(),
    toolSha256: sha(await readFile(fileURLToPath(import.meta.url))), supportHashes: Object.fromEntries(await Promise.all(support.map(async p => [p, sha(await readFile(resolve(candidate, 'code/desktop-pet', p)))]))),
    outputDirectory, budgetFile: config.budgetFile, budgetBatchId: config.budgetBatchId, credentialRef, model, createEndpoint, ttsEndpoint,
    referenceFile, referenceUrl, referenceSha256, sampleText, billedCharacters: billedCharacters(sampleText), phaseLimitMicros: 400000,
    clonePriceMicros: 0, ttsCharacterMicros: 140, maxCreates: 1, maxSyntheses: 1, maxDownloads: 1, retries: 0, devices: 0,
    ledgerSha256: sha(ledgerBytes), remainingMicros: remaining, configSha256: sha(await readFile(configFile)), activationSha256: sha(await readFile(activationFile)),
    managedSettingsSha256: sha(await readFile(resolve(dirname(configFile), 'management-settings.json'))), apiPricingSource: 'https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide' };
  await mkdir(outputDirectory, { recursive: true }); const path = resolve(outputDirectory, 'plan.json');
  if (mode === '--check') { const bytes = JSON.stringify(plan, null, 2) + '\n'; await writeFile(path, bytes, { flag: 'wx' }); console.log(JSON.stringify({ path, sha256: sha(bytes), calls: 0 })); return; }
  const previous = await readFile(path); if (sha(previous) !== expectedHash || JSON.stringify(JSON.parse(previous)) !== JSON.stringify(plan)) throw new Error('Exact reviewed plan changed');
  const keyFile = await realpath(config.models.tts.credentialFile), info = await stat(keyFile);
  if (keyFile.startsWith(root + '/') || !info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Restricted existing credential required');
  const key = () => { const value = readFileSync(keyFile, 'utf8').trim(); if (!/^sk-[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid credential file'); return value; };
  const result = await runDania(plan, key); console.log(JSON.stringify({ status: result.status, posts: result.posts, evidence: resolve(outputDirectory, 'execution.json') }));
  if (result.status === 'failed_stopped_no_retry') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
