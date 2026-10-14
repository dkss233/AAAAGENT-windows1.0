import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvaluationBudget } from '../dist/core/evaluation-budget.js';
import { QwenAudioTtsProvider, QWEN_AUDIO_TTS_ENDPOINT } from '../dist/providers/qwen-audio-tts.js';
import { ProviderTransport } from '../dist/providers/transport.js';
import { MemoryMediaStore } from '../dist/media/store.js';
import { inspectPcmWav } from '../dist/media/wav.js';
import { readActiveTrialConfiguration } from '../dist/app/trial-config.js';
import { estimateTrialMicros } from '../dist/app/trial-authorizer.js';

const sha = b => createHash('sha256').update(b).digest('hex');
const publicText = '今天的事先放一放。喝点水，早点休息，明天再慢慢来，好吗？';
const expression = { emotion: 'calm', intensity: .4, delivery: '自然温和，像日常聊天一样说话。', gesture: null };
const prefix = 'W0-I:B-SPEECH-CONTROL-02:tts-comparison:';
const selection = { model: 'qwen-audio-3.0-tts-plus', voice: 'longanlingxin', endpoint: QWEN_AUDIO_TTS_ENDPOINT, characterMicros: 140, reservationMicros: 400000 };
export function safeFailure(error) {
  const local = ['Expected WAV audio', 'Truncated WAV', 'Only PCM WAV is supported', 'Invalid PCM WAV', 'Unexpected QwenAudio WAV format', 'QwenAudio synthesis did not complete', 'TTS segments have inconsistent formats'];
  const code = error?.cause?.code ?? error?.code;
  return { name: /^[A-Za-z]+$/.test(error?.name) ? error.name : 'Error',
    code: typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : null,
    localMessage: local.includes(error?.message) || /^(Provider HTTP \d+|Audio download HTTP \d+)$/.test(error?.message) ? error.message : null };
}
export function capturedFetch(directory, trace, fetcher = fetch) {
  return async (url, init) => {
    const post = init?.method === 'POST'; trace.stage = post ? 'synthesis_fetch' : 'audio_download_fetch';
    if (post) { trace.posts = (trace.posts ?? 0) + 1; if (trace.posts > 1) throw new Error('Diagnostic request limit'); }
    else { trace.downloads = (trace.downloads ?? 0) + 1; if (trace.downloads > 1) throw new Error('Diagnostic download limit'); }
    const response = await fetcher(url, init);
    if (post) { trace.synthesisHttpStatus = response.status; trace.stage = 'provider_response_parse'; return response; }
    trace.downloadHttpStatus = response.status; trace.stage = 'audio_download_body';
    const bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, 'provider-original.bin'); await writeFile(path, bytes, { flag: 'wx' });
    trace.download = { path, bytes: bytes.length, sha256: sha(bytes), first64Hex: bytes.subarray(0, 64).toString('hex') };
    try { const wav = inspectPcmWav(bytes); trace.download.wav = { sampleRate: wav.sampleRate, channels: wav.channels, bits: wav.bits, durationMs: wav.durationMs }; }
    catch (error) { trace.download.wavError = safeFailure(error); }
    trace.stage = 'provider_audio_validation';
    // Preserve original bytes on disk before the provider can zero temporary clips.
    return new Response(bytes, { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream' } });
  };
}

async function main() {
  const [mode, root, expectedHash] = process.argv.slice(2);
  if (!['--check', '--execute'].includes(mode) || !root || await realpath(root) !== root) throw new Error('Explicit diagnostic mode/root required');
  const candidate = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const output = resolve(candidate, 'artifacts/W0-I/speech-control-02/tts-diagnostic');
  const configFile = resolve(root, 'artifacts/W0-I/model-evaluation/trial/user-trial/config.json');
  const activationFile = resolve(dirname(configFile), 'activation.json');
  const config = await readActiveTrialConfiguration(configFile, activationFile);
  const ledgerBytes = await readFile(config.budgetFile), ledger = JSON.parse(ledgerBytes);
  const prior = ledger.entries.filter(e => e.operationId.startsWith(prefix));
  if (ledger.batchId !== config.budgetBatchId || ledger.limitMicros !== 20000000 || ledger.blocked || ledger.entries.some(e => e.status !== 'settled')
    || prior.length !== 1 || prior[0].operationId !== prefix + 'plus' || prior[0].actualMicros !== 7140) throw new Error('Expected exactly one settled original comparison');
  const remaining = ledger.limitMicros - ledger.entries.reduce((s, e) => s + e.actualMicros, 0);
  if (remaining < 400000 || prior[0].actualMicros + 400000 > 500000) throw new Error('Original scope budget insufficient');
  const plan = { root, candidate, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).trim(),
    selection, text: publicText, expression, newPosts: 1, newDownloads: 1, totalPackagePosts: 2, packageCeilingMicros: 500000,
    priorSpentMicros: 7140, remainingMicros: remaining, ledgerSha256: sha(ledgerBytes),
    configSha256: sha(await readFile(configFile)), activationSha256: sha(await readFile(activationFile)), databaseSha256: sha(await readFile(config.database)),
    capture: 'Public sample response bytes and safe failure stage/PCM header; never signed URL/key', playback: false, devices: 0, retries: 0, timeoutMs: 45000 };
  await mkdir(output, { recursive: true }); const planFile = resolve(output, 'plan.json');
  if (mode === '--check') {
    const bytes = JSON.stringify(plan, null, 2) + '\n'; await writeFile(planFile, bytes, { flag: 'wx' });
    console.log(JSON.stringify({ planFile, sha256: sha(bytes), calls: 0 })); return;
  }
  const reviewed = await readFile(planFile);
  if (sha(reviewed) !== expectedHash || JSON.stringify(JSON.parse(reviewed)) !== JSON.stringify(plan)) throw new Error('Diagnostic plan changed');
  const keyFile = await realpath(config.models.tts.credentialFile), info = await stat(keyFile);
  if (keyFile.startsWith(root + '/') || !info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid()) throw new Error('Restricted existing key required');
  const record = { sourceRevision: plan.sourceRevision, planSha256: expectedHash, status: 'running', startedAt: new Date().toISOString(), posts: 0, downloads: 0 };
  const evidenceFile = resolve(output, 'execution.json'); await writeFile(evidenceFile, JSON.stringify(record), { flag: 'wx' });
  const budget = new EvaluationBudget(config.budgetFile, config.budgetBatchId, config.limitMicros), id = prefix + 'diagnostic';
  const authorizer = { async authorize(request, signal) {
    signal.throwIfAborted();
    if (request.operation !== 'tts' || request.model !== selection.model || request.endpoint !== selection.endpoint || request.textCharacters !== 51) throw new Error('Diagnostic request changed');
    const fresh = JSON.parse(await readFile(config.budgetFile));
    if (sha(JSON.stringify(fresh)) !== sha(JSON.stringify(ledger))) throw new Error('Ledger changed before diagnostic');
    await budget.reserve(id, selection.model, 400000, { operationIdPrefix: prefix, limitMicros: 500000, maxCalls: 2 });
    return { async settle(outcome) { const actualMicros = estimateTrialMicros(selection, 'tts', outcome); record.outcome = { ...outcome, actualMicros };
      await budget.settle(id, actualMicros); if (actualMicros === null || actualMicros > 400000 || outcome.status !== 'success') throw new Error('Diagnostic settlement failed'); } };
  } };
  const store = new MemoryMediaStore(), scope = { characterId: 'companion', sessionId: 'public-tts-diagnostic', turnId: id, generation: 1 };
  try {
    const apiKey = () => { const key = readFileSync(keyFile, 'utf8').trim(); if (!/^sk-[A-Za-z0-9_-]+$/.test(key)) throw new Error('Invalid existing key'); return key; };
    const provider = new QwenAudioTtsProvider({ ...selection, apiKey, authorizer }, store, new ProviderTransport(capturedFetch(output, record)));
    const started = performance.now(), result = await provider.synthesize({ scope, text: publicText, expression }, AbortSignal.timeout(45000));
    const bytes = await store.read(scope, result.audio); await writeFile(resolve(output, 'plus-lingxin.wav'), bytes, { flag: 'wx' });
    record.completePlayableMs = Math.round(performance.now() - started); record.status = 'success'; record.stage = 'complete';
  } catch (error) { record.status = 'failed_stopped'; record.failure = safeFailure(error); process.exitCode = 1; }
  finally {
    await store.releaseScope(scope); record.finishedAt = new Date().toISOString();
    record.databaseUnchanged = sha(await readFile(config.database)) === plan.databaseSha256;
    record.configUnchanged = sha(await readFile(configFile)) === plan.configSha256;
    const after = JSON.parse(await readFile(config.budgetFile)); record.entries = after.entries.filter(e => e.operationId.startsWith(prefix));
    record.historicalLedgerUnchanged = JSON.stringify(after.entries.slice(0, ledger.entries.length)) === JSON.stringify(ledger.entries);
    await writeFile(evidenceFile, JSON.stringify(record, null, 2) + '\n'); console.log(JSON.stringify({ evidenceFile, status: record.status, posts: record.posts, failure: record.failure }));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
