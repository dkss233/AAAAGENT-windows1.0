import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { updateSpeechConfiguration } from '../../tools/local-speech-config.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const dir = await fs.mkdtemp(resolve(tmpdir(), 'aaaagent-speech-pair-'));
  t.after(async () => { assert.ok(dir.startsWith(resolve(tmpdir(), 'aaaagent-speech-pair-'))); await fs.rm(dir, { recursive: true }); });
  const file = resolve(dir, 'config.json'), activation = resolve(dir, 'activation.json');
  const raw = JSON.stringify({ phaseId: 'local-test', projectRoot: dir, preserved: 'user setting' });
  const act = JSON.stringify({ version: 1, phaseId: 'local-test', status: 'prepared', configSha256: hash(raw) });
  await fs.writeFile(file, raw); await fs.writeFile(activation, act); return { dir, file, activation, raw, act };
}
test('speech configuration keeps activation status and recoverable originals', async t => {
  const f = await fixture(t), backup = await updateSpeechConfiguration(f.file, c => ({ ...c, localSpeech: { asr: 'test' } }));
  const next = await fs.readFile(f.file, 'utf8'), act = JSON.parse(await fs.readFile(f.activation, 'utf8'));
  assert.equal(act.status, 'prepared'); assert.equal(act.configSha256, hash(next));
  assert.equal(JSON.parse(next).preserved, 'user setting'); assert.equal(await fs.readFile(backup.config, 'utf8'), f.raw);
  assert.equal(await fs.readFile(backup.activation, 'utf8'), f.act);
});
test('Windows activation rename failure restores original pair and permits retry', async t => {
  const f = await fixture(t); let renames = 0;
  const io = { ...fs, async rename(from, to) { if (++renames === 2) throw Object.assign(Error('Sharing violation'), { code: 'EPERM' }); await fs.rename(from, to); } };
  await assert.rejects(updateSpeechConfiguration(f.file, c => ({ ...c, localSpeech: { asr: 'test' } }), io), /original pair was restored/);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.raw); assert.equal(await fs.readFile(f.activation, 'utf8'), f.act);
  assert.ok((await fs.readdir(f.dir)).every(name => !name.endsWith('.next') && !name.endsWith('.lock')));
  await updateSpeechConfiguration(f.file, c => ({ ...c, retry: true }));
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).retry, true);
});
