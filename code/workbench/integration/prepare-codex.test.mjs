import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCodex, prepareCodex } from './prepare-codex.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');

test('prepared Codex refuses changed, added, linked or non-executable runtime files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'aaa-codex-pin-')); t.after(() => rmSync(dir, { recursive: true }));
  const lock = { version: '0.156.0', target: 'aarch64-apple-darwin', entrypoint: 'bin/codex' };
  const metadata = JSON.stringify(lock);
  mkdirSync(join(dir, 'bin')); writeFileSync(join(dir, 'bin/codex'), 'controlled binary', { mode: 0o700 });
  writeFileSync(join(dir, 'codex-package.json'), metadata);
  const marker = { source: lock, files: { 'bin/codex': hash('controlled binary'), 'codex-package.json': hash(metadata) } };
  writeFileSync(join(dir, '.aaaagent-codex.json'), JSON.stringify(marker));
  assert.deepEqual(verifyCodex(dir, lock), marker);
  assert.throws(() => verifyCodex(dir, { ...lock, version: 'other' }), /source lock/);
  writeFileSync(join(dir, 'bin/codex'), 'changed'); assert.throws(() => verifyCodex(dir, lock), /changed/);
  writeFileSync(join(dir, 'bin/codex'), 'controlled binary');
  writeFileSync(join(dir, 'unexpected'), 'extra'); assert.throws(() => verifyCodex(dir, lock), /changed/); rmSync(join(dir, 'unexpected'));
  symlinkSync('/tmp', join(dir, 'escape')); assert.throws(() => verifyCodex(dir, lock), /symbolic link/); rmSync(join(dir, 'escape'));
  chmodSync(join(dir, 'bin/codex'), 0o600); assert.throws(() => verifyCodex(dir, lock), /layout/);
});

test('unverified archive is rejected before extraction or execution', t => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return t.skip('Pinned platform only');
  const root = mkdtempSync(join(tmpdir(), 'aaa-codex-archive-')); t.after(() => rmSync(root, { recursive: true }));
  const archive = join(root, 'input'); writeFileSync(archive, 'not the official archive');
  assert.throws(() => prepareCodex(root, archive), /digest mismatch/);
});
