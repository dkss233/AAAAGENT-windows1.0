import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oldEntry, boundedEntry, sha, correctedLedger, applyCorrection } from '../../tools/correct-minimax-reservation.mjs';
const fixture = () => Buffer.from(JSON.stringify({ batchId: 'D09-S1-20260906-01', currency: 'CNY', limitMicros: 20_000_000, blocked: false,
  entries: [{ operationId: 'synthetic-settled', model: 'fixture', reservedMicros: 100, actualMicros: 60, status: 'settled' }, oldEntry] }));
test('only unknown reservation changes; original input, known charges and uncertainty stay intact', () => {
  const before = fixture(), next = correctedLedger(before, sha(before));
  assert.deepEqual(next.entries[1], boundedEntry); assert.deepEqual(next.entries[0], JSON.parse(before).entries[0]);
  assert.deepEqual(JSON.parse(before).entries[1], oldEntry);
  assert.throws(() => correctedLedger(Buffer.from(JSON.stringify(next)), sha(JSON.stringify(next))), /exact original/);
  assert.throws(() => correctedLedger(before, 'stale'), /changed/);
});
test('ledger lock rejects another writer, changed input and existing temporary without overwriting them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minimax-bound-')); const file = join(dir, 'budget.json'), before = fixture();
  try {
    await writeFile(file, before); await writeFile(file + '.lock', 'other-writer');
    await assert.rejects(applyCorrection(file, join(dir, 'locked'), sha(before)), /EEXIST/);
    assert.equal(await readFile(file + '.lock', 'utf8'), 'other-writer'); await rm(file + '.lock');
    await assert.rejects(applyCorrection(file, join(dir, 'changed'), 'stale'), /changed/);
    await assert.rejects(access(file + '.lock'));
    await writeFile(file + '.next', 'other-temporary');
    await assert.rejects(applyCorrection(file, join(dir, 'temp'), sha(before)), /EEXIST/);
    assert.equal(await readFile(file + '.next', 'utf8'), 'other-temporary'); assert.deepEqual(await readFile(file), before);
    await rm(file + '.next');
    const receipt = await applyCorrection(file, join(dir, 'applied'), sha(before));
    assert.equal(receipt.status, 'applied'); assert.equal(receipt.actualChargeStillUnknown, true);
    assert.deepEqual(await readFile(join(dir, 'applied/ledger-before.json')), before);
    assert.deepEqual(JSON.parse(await readFile(file)).entries[1], boundedEntry);
    assert.equal(sha(await readFile(file)), receipt.afterSha256); await assert.rejects(access(file + '.lock'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
