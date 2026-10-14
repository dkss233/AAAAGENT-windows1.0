import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { restrictPrivatePathSync } from '../../../core/platform-files.js';
import { readIsolatedWorkbenchEnvironment } from '../../../app/workbench-runtime.js';

test('missing attachment preserves default; a present invalid attachment never creates a replacement home', () => {
  const root = mkdtempSync(join(tmpdir(), 'aaa-isolated-owner-'));
  const directory = join(root, '.local/data'), home = join(root, 'existing-home');
  mkdirSync(directory, { recursive: true }); mkdirSync(home);
  const file = join(directory, 'workbench-isolated-environment.json'), host = join(home, '.aaaagent-t3-host.json');
  const value = { version: 1, kind: 'isolated-existing-t3', environmentId: 'controlled-original',
    nativePid: process.pid, hostPid: process.pid, browserSessionFile: join(root, 'browser.json'),
    options: { sourceDir: join(root, 'source'), runtimeSourceDir: join(root, 'runtime'), runtimePatchSha256: 'a'.repeat(64),
      nodeExecutable: process.execPath, baseDir: home, logFile: join(root, 'native.log') } };
  const save = () => { writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); restrictPrivatePathSync(file); };
  const owner = { version: 1, hostPid: process.pid, sourceDir: value.options.sourceDir, baseDir: home };
  try {
    assert.equal(readIsolatedWorkbenchEnvironment(root), undefined);
    save(); assert.throws(() => readIsolatedWorkbenchEnvironment(root), /unavailable/);
    writeFileSync(host, JSON.stringify(owner), { mode: 0o600 });
    restrictPrivatePathSync(host);
    assert.deepEqual(readIsolatedWorkbenchEnvironment(root), value);
    writeFileSync(host, JSON.stringify({ ...owner, hostPid: process.pid + 1 }));
    assert.throws(() => readIsolatedWorkbenchEnvironment(root), /unavailable/);
    writeFileSync(host, JSON.stringify(owner));
    if (process.platform === 'win32') execFileSync('icacls.exe', [file, '/grant', '*S-1-1-0:(R)'], { windowsHide: true, stdio: 'pipe' });
    else chmodSync(file, 0o644);
    assert.throws(() => readIsolatedWorkbenchEnvironment(root), /unavailable/);
    rmSync(file); symlinkSync(process.platform === 'win32' ? home : host, file, process.platform === 'win32' ? 'junction' : 'file'); assert.throws(() => readIsolatedWorkbenchEnvironment(root), /unavailable/);
    rmSync(file); assert.equal(readIsolatedWorkbenchEnvironment(root), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
