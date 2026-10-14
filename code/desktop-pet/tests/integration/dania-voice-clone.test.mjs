import test from 'node:test'; import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'; import { resolve } from 'node:path';
import { runDania, redact } from '../../tools/dania-voice-clone.mjs'; import { pcm16Wav } from '../../dist/media/wav.js';
for (const scenario of ['success', 'create_rejected', 'synthesis_rejected', 'bad_wav']) test(`Dania fixed flow: ${scenario}`, async t => {
  const parent = resolve('../../artifacts/W0-I/dania-voice-clone-01/tmp'); await mkdir(parent, { recursive: true });
  const outputDirectory = await mkdtemp(parent + '/flow-'); t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const budgetFile = resolve(outputDirectory, 'budget.json'), history = { operationId: 'previous', model: 'prior', reservedMicros: 100, actualMicros: 70, status: 'settled' };
  await writeFile(budgetFile, JSON.stringify({ batchId: 'synthetic', currency: 'CNY', limitMicros: 20000000, blocked: false, entries: [history] }));
  let posts = 0, downloads = 0; const voiceId = 'qwen-audio-3.0-tts-plus-dania-synthetic';
  const result = await runDania({ outputDirectory, budgetFile, budgetBatchId: 'synthetic', credentialRef: 'dashscope-synthetic' }, () => 'synthetic', async (url, init) => {
    if (init?.method === 'POST') {
      posts++; const b = JSON.parse(init.body);
      if (posts === 1) { assert.equal(b.input.target_model, 'qwen-audio-3.0-tts-plus'); assert.ok(b.input.url.includes('Revision=3bfd541')); return scenario === 'create_rejected' ? Response.json({ code: 'ReferenceRejected', message: 'https://private.invalid/?secret=1' }, { status: 400 }) : Response.json({ output: { voice_id: voiceId }, usage: { count: 1 } }); }
      assert.equal(b.input.voice, voiceId); assert.deepEqual(b.input.language_hints, ['zh']);
      return scenario === 'synthesis_rejected' ? Response.json({ code: 'VoiceUnavailable' }, { status: 400 }) : Response.json({ output: { finish_reason: 'stop', audio: { url: 'https://synthetic.invalid/sample?Signature=SECRET' } }, usage: { characters: 51 } });
    }
    downloads++; assert.equal(init.headers, undefined);
    return new Response(scenario === 'bad_wav' ? 'invalid sample' : pcm16Wav(new Float32Array(8), 24000));
  });
  assert.equal(posts, scenario === 'create_rejected' ? 1 : 2); assert.equal(downloads, ['success', 'bad_wav'].includes(scenario) ? 1 : 0);
  assert.equal(result.status, scenario === 'success' ? 'created_and_sample_format_verified_not_listened' : 'failed_stopped_no_retry');
  assert.equal(result.historicalLedgerUnchanged, true); assert.equal(result.entries[0].actualMicros, 0);
  if (scenario === 'bad_wav') assert.equal(await readFile(resolve(outputDirectory, 'sample-original.bin'), 'utf8'), 'invalid sample');
  assert.doesNotMatch(JSON.stringify(result), /Signature|SECRET|private.invalid/);
  await assert.rejects(runDania({ outputDirectory, budgetFile, budgetBatchId: 'synthetic' }, () => 'unused', async () => { throw Error('Must not retry'); }), { code: 'EEXIST' });
});
test('provider failure diagnostics preserve codes while removing credentials and temporary URLs', () => {
  assert.deepEqual(redact({ code: 'AudioTooShort', message: 'fetch https://secret.invalid/?Signature=hidden with sk-secret', request_id: 'public-id' }),
    { code: 'AudioTooShort', message: 'fetch [url] with [key]', request_id: 'public-id' });
});
