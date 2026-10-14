import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { restrictPrivatePathSync } from '../../core/platform-files.js';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './helpers.js';
import { deepseekFlashModel } from '../../providers/text-protocol.js';
import { credentialRegistry } from '../../management/credentials.js';
import { defaultProjectTerminalConfiguration, loadProjectTerminalRuntimeRegistration,
  projectTerminalConfigurationFile, projectTerminalRuntimeRegistration,
  validateProjectTerminalConfiguration } from '../../management/project-terminal-configuration.js';

test('dedicated configuration defaults off and preserves full catalog metadata with a separate 1024 cap', () => {
  const config = defaultProjectTerminalConfiguration('deepseek-123456789abc');
  assert.equal(config.enabled, false);
  assert.equal(config.maxOutputTokens, 1024);
  assert.equal(config.selection.outputTokenLimit, 393216);
  assert.equal(config.selection.inputTokenLimit, 32768);
  assert.equal(config.selection.reservationMicros, 3211264);
  assert.deepEqual(validateProjectTerminalConfiguration(config), config);
  for (const field of ['outputTokenLimit', 'inputMicrosPerToken', 'reservationMicros', 'timeoutMs', 'endpoint', 'adapterId']) {
    assert.throws(() => validateProjectTerminalConfiguration({ ...config,
      selection: { ...config.selection, [field]: 'changed' } }));
  }
  for (const change of [{ enabled: 'true' }, { maxOutputTokens: 393216 }, { credentialFile: '/private/key' },
    { selection: { ...config.selection, thinking: 'high' } }]) {
    assert.throws(() => validateProjectTerminalConfiguration({ ...config, ...change }));
  }
});

test('missing or disabled settings never create a file, reserve money, or access the model transport', async t => {
  const f = await fixture(t), originalLedger = await readFile(f.c.budgetFile);
  const file = projectTerminalConfigurationFile(f.c.projectRoot);
  const transport = { async complete(): Promise<never> { throw Error('transport must remain unused'); } };
  assert.equal(await loadProjectTerminalRuntimeRegistration(f.c, transport), undefined);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const disabled = defaultProjectTerminalConfiguration('deepseek-123456789abc');
  assert.equal(projectTerminalRuntimeRegistration(f.c, disabled, transport), undefined);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(disabled), { mode: 0o600 });
  restrictPrivatePathSync(file);
  assert.equal(await loadProjectTerminalRuntimeRegistration(f.c, transport), undefined);
  assert.deepEqual(await readFile(f.c.budgetFile), originalLedger);
});

test('enabled configuration validates existing credential metadata and construction still makes no request', async t => {
  const f = await fixture(t), external = await mkdtemp(join(tmpdir(), 'terminal-config-key-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const file = join(external, 'synthetic.key'); await writeFile(file, 'fake-only', { mode: 0o600 });
  restrictPrivatePathSync(file);
  const base = { ...f.c, models: { ...f.c.models, summary: deepseekFlashModel(file) } };
  const ref = credentialRegistry(base).ref(file, 'deepseek');
  const enabled = { ...defaultProjectTerminalConfiguration(ref), enabled: true };
  const ledger = await readFile(base.budgetFile); let calls = 0;
  const transport = { async complete(): Promise<never> { calls++; throw Error('not invoked during configuration'); } };
  const path = projectTerminalConfigurationFile(base.projectRoot); await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(enabled), { mode: 0o600 });
  restrictPrivatePathSync(path);
  assert.ok(await loadProjectTerminalRuntimeRegistration(base, transport));
  assert.equal(calls, 0); assert.deepEqual(await readFile(base.budgetFile), ledger);
  if (process.platform === 'win32') execFileSync('icacls.exe', [path, '/grant', '*S-1-1-0:R'], { windowsHide: true, stdio: 'pipe' });
  else await chmod(path, 0o644);
  assert.equal(await loadProjectTerminalRuntimeRegistration(base, transport), undefined);
  restrictPrivatePathSync(path); await writeFile(path, '{bad json');
  assert.equal(await loadProjectTerminalRuntimeRegistration(base, transport), undefined);
  await unlink(path); await symlink(process.platform === 'win32' ? dirname(file) : file, path, process.platform === 'win32' ? 'junction' : 'file');
  assert.equal(await loadProjectTerminalRuntimeRegistration(base, transport), undefined);
  assert.equal(calls, 0);
});
