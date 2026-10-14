import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeSyncAssemblyBaseline } from './native-sync-runtime.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

test('complete approved assembly graph survives a source-lock upgrade and rejects changed or escaping inputs', t => {
  const original = resolve(process.env.NATIVE_SYNC_BASELINE ?? join(workspace, 'artifacts/W0-I/native-input-repair-57/artifacts/runtime/approved-assembly-baseline'));
  assert.ok(existsSync(original), 'The fixed original complete graph is required for this integration test');
  const evidence = join(workspace, 'artifacts/W0-I/native-input-repair-57/artifacts/runtime');
  mkdirSync(evidence, { recursive: true });
  const temporary = mkdtempSync(join(evidence, 'baseline-guard-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const copy = join(temporary, 'runtime');
  execFileSync('/bin/cp', ['-cR', original, copy]);
  const expected = verifyNativeSyncAssemblyBaseline(original);
  assert.deepEqual(verifyNativeSyncAssemblyBaseline(copy), expected);

  const bundle = join(copy, 'apps/server/dist/bin.mjs'), bundleBytes = readFileSync(bundle);
  writeFileSync(bundle, Buffer.concat([bundleBytes, Buffer.from('\n// unexpected assembly input\n')]));
  assert.throws(() => verifyNativeSyncAssemblyBaseline(copy), /baseline changed/);
  writeFileSync(bundle, bundleBytes);

  const extra = join(copy, 'unreviewed-input');
  writeFileSync(extra, 'unreviewed');
  assert.throws(() => verifyNativeSyncAssemblyBaseline(copy), /baseline changed/);
  rmSync(extra);

  const receipt = join(copy, '.aaaagent-native-sync-build.json'), receiptBytes = readFileSync(receipt);
  const forged = JSON.parse(receiptBytes); forged.sourceLockSha256 = '0'.repeat(64);
  writeFileSync(receipt, JSON.stringify(forged));
  assert.throws(() => verifyNativeSyncAssemblyBaseline(copy), /baseline changed/);
  writeFileSync(receipt, receiptBytes);

  const escape = join(copy, 'external-dependency');
  symlinkSync(original, escape);
  assert.throws(() => verifyNativeSyncAssemblyBaseline(copy), /escapes install/);
  rmSync(escape);
  assert.deepEqual(verifyNativeSyncAssemblyBaseline(copy), expected);
});
