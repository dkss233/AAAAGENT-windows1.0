import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { engineInstallPort } from '../../management/engine-install.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';
import { fixture } from './helpers.js';

async function scratch(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'engine-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const waitIdle = async (port: ReturnType<typeof engineInstallPort>) => {
  for (let i = 0; i < 600 && port.status().running; i++) await new Promise(resolve => setTimeout(resolve, 20));
  return port.status();
};

test('the engine port reports absence until a profile exists, and one run settles once', async t => {
  const dir = await scratch(t), script = join(dir, 'controlled-install.mjs');
  await writeFile(script, "console.log('ENGINE_PREPARED controlled fixture');\n");
  const port = engineInstallPort(dir, script);
  const idle = port.status();
  assert.deepEqual({ running: idle.running, completed: idle.completed, cancelled: idle.cancelled, installed: idle.installed },
    { running: false, completed: false, cancelled: false, installed: false });
  assert.equal(port.start().running, true);
  // Single-flight: a second press while it runs reports the running task instead of queueing another.
  assert.equal(port.start().running, true);
  const done = await waitIdle(port);
  assert.equal(done.completed, true);
  assert.equal(done.installed, false, 'the script wrote no profile, so nothing is installed yet');
  await mkdir(join(dir, 'artifacts', 'runtime'), { recursive: true });
  await writeFile(join(dir, 'artifacts', 'runtime', 'engine-profile.json'), '{}\n');
  assert.equal(port.status().installed, true);
});

test('a failing install script reports the failure detail instead of claiming success', async t => {
  const dir = await scratch(t), script = join(dir, 'failing-install.mjs');
  await writeFile(script, "console.log('ENGINE_FAILED archive digest mismatch'); process.exit(1);\n");
  const port = engineInstallPort(dir, script);
  port.start();
  const done = await waitIdle(port);
  assert.equal(done.completed, false);
  assert.match(done.detail ?? '', /引擎运行时准备未完成/);
});

test('the console can start and poll the engine install over the management API', async t => {
  const f = await fixture(t), dir = await scratch(t), script = join(dir, 'controlled-install.mjs');
  await writeFile(script, "console.log('ENGINE_PREPARED controlled fixture');\n");
  const uiRoot = join(f.c.projectRoot, 'ui'); await mkdir(uiRoot);
  await writeFile(join(uiRoot, 'index.html'), '<h1>controlled</h1>');
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const memory: ManagementMemoryPort = {
    characters: () => [], list(query) { return { ...query, revision: 0, records: [], total: 0 }; },
    edit() { throw new Error(); }, context() { throw new Error(); }, prompt() { throw new Error(); }, savePrompt() { throw new Error(); },
  };
  const port = engineInstallPort(dir, script);
  const server = await startManagementServer({ uiRoot, settings, memory, engineInstall: port, snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(),
    modules: runtime.modules(), events: [], settings: settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  t.after(() => server.close());
  const headers = { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json' };
  const post = await fetch(server.origin + '/api/engine/runtime', { method: 'POST', headers, body: '{}' });
  assert.equal(post.status, 200);
  assert.equal((await post.json() as { running: boolean }).running, true);
  await waitIdle(port);
  const status = await fetch(server.origin + '/api/engine/runtime', { headers });
  assert.equal(status.status, 200);
  const body = await status.json() as { completed: boolean; installed: boolean };
  assert.equal(body.completed, true);
  assert.equal(body.installed, false);
});
