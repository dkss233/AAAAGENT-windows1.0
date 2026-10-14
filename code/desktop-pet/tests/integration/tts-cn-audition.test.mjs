import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requests, runAudition, validateLedger, prefix } from '../../tools/tts-cn-audition.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
const history = () => ({ batchId: 'fixture', currency: 'CNY', limitMicros: 20000000, blocked: false, entries: [
  { operationId: 'old-settled', model: 'old', reservedMicros: 13000000, actualMicros: 12078869, status: 'settled' },
  { operationId: 'old-HD-unknown', model: 'old', reservedMicros: 19600, actualMicros: null, status: 'unknown' },
] });
for (const provider of ['cosy', 'hd']) for (const fail of [false, true]) test(provider + ' bounded audition and no retry; failure=' + fail, async t => {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../artifacts/W0-I/tts-cn-audition-01/tmp');
  await mkdir(parent, { recursive: true }); const dir = await mkdtemp(parent + '/case-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const budgetFile = dir + '/budget.json', original = JSON.stringify(history()); await writeFile(budgetFile, original);
  const reference = { url: 'oss://synthetic/reference.wav', sha256: 'a'.repeat(64) }, voiceId = provider === 'hd' ? 'DaniaCnHDSynthetic2026' : null;
  const plan = { provider, reference, voiceId, requests: requests(provider, reference, voiceId), ledgerSha256: sha(original),
    budgetFile, budgetBatchId: 'fixture', outputDirectory: dir + '/result' };
  let posts = 0, downloads = 0;
  const fetcher = async (url, init) => {
    if (init.method === 'POST') {
      posts++; const body = JSON.parse(init.body);
      if (fail) return Response.json({ code: 'NotActivated' }, { status: 400 });
      if (provider === 'cosy' && posts === 1) {
        assert.equal(body.input.max_prompt_audio_length, 20.93); assert.equal(body.input.target_model, 'cosyvoice-v3.5-plus');
        assert.equal(init.headers['X-DashScope-OssResourceResolve'], 'enable');
        return Response.json({ output: { voice_id: 'cosyvoice-v3.5-plus-daniacn-synthetic' }, usage: { count: 1 } });
      }
      if (provider === 'cosy') {
        assert.equal(body.input.voice, 'cosyvoice-v3.5-plus-daniacn-synthetic'); assert.equal(body.input.format, 'mp3');
        assert.equal(body.input.instruction, undefined); assert.equal(init.headers['X-DashScope-SSE'], undefined);
        return Response.json({ output: { finish_reason: 'stop', audio: { url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/sample.mp3?Signature=a%2Bb' } }, usage: { characters: 51 } });
      }
      assert.equal(body.model, 'MiniMax/speech-2.8-hd'); assert.equal(body.input.action, 'voice_clone');
      assert.equal(body.input.voice_id, voiceId);
      return Response.json({ output: { base_resp: { status_code: 0 }, input_sensitive: false, input_sensitive_type: 0, demo_audio: 'https://synthetic.invalid/sample.mp3' }, usage: { characters: 51 } });
    }
    downloads++; assert.equal(init.headers, undefined);
    if (provider === 'cosy') assert.equal(url, 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/sample.mp3?Signature=a%2Bb');
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const report = await runAudition(plan, () => 'fixture', fetcher, () => ({ format: 'mp3', durationMs: 2000 }));
  assert.equal(report.status, fail ? 'failed_stopped_no_retry' : 'sample_ready_for_user_listening');
  assert.equal(posts, fail ? 1 : provider === 'cosy' ? 2 : 1); assert.equal(downloads, fail ? 0 : 1);
  const after = JSON.parse(await readFile(budgetFile)); assert.deepEqual(after.entries.slice(0, 2), history().entries);
  assert.equal(after.entries.at(-1).actualMicros, fail ? provider === 'cosy' ? 0 : null : 51 * (provider === 'cosy' ? 150 : 350));
  assert.ok(after.entries.slice(2).every(e => e.reservedMicros < 30000));
  assert.equal(report.devices, 0); assert.equal(report.playback, false); assert.equal(report.installed, false);
  await assert.rejects(runAudition(plan, () => 'unused', fetcher), { code: 'EEXIST' });
  if (!fail) await assert.rejects(readFile(dir + '/result/audio-location.private.json'), { code: 'ENOENT' });
});
test('invalid, repeated, active or exhausted ledger cannot start another audition', () => {
  assert.equal(validateLedger(history(), 'fixture', 'cosy'), 7901531);
  for (const mutate of [s => s.entries[0].status = 'reserved', s => s.entries[1].actualMicros = 0,
    s => s.entries[1].operationId = prefix + 'hd:clone-demo', s => s.entries[0].actualMicros = 19990000, s => s.blocked = true]) {
    const state = history(); mutate(state); assert.throws(() => validateLedger(state, 'fixture', 'hd'));
  }
  assert.throws(() => requests('turbo', { url: 'unused' }, null));
});
