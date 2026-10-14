import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { fixture } from './helpers.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';

test('local HTTP authorization, host, origin and routing reject foreign access before business calls', async t => {
  const f = await fixture(t), uiRoot = join(f.c.projectRoot, 'ui'); await mkdir(uiRoot); await writeFile(join(uiRoot, 'index.html'), '<h1>controlled HTTP fixture</h1>');
  for (const name of ['appearance.mjs', 'native-workbench-view.mjs']) await writeFile(join(uiRoot, name), 'export const originalModule = true;');
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c), runtime = new ManagementRuntime(f.c.sourceRevision);
  let businessCalls = 0;
  const memory: ManagementMemoryPort = {
    characters: () => [], list(query) { businessCalls++; return { ...query, revision: 0, records: [], total: 0 }; },
    edit() { throw new Error('PRIVATE provider key or user data'); }, context() { throw new Error(); },
    prompt() { throw new Error(); }, savePrompt() { throw new Error(); },
  };
  let frameOrigin: string | undefined = 'http://127.0.0.1:59916';
  const server = await startManagementServer({ uiRoot, settings, memory, nativeFrameOrigin: () => frameOrigin, snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(),
    modules: runtime.modules(), events: [], settings: settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  t.after(() => server.close());
  const headers = { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json' };
  for (const path of ['/', '/index.html']) {
    const response = await fetch(server.origin + path); assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<meta name="aaa-management-entry" content="original-management" data-version="0.1.0">/);
    assert.equal((html.match(/name="aaa-management-entry"/g) ?? []).length, 1);
    assert(!html.includes('content="mounted-readonly"'));
    assert.match(html, /<meta name="aaa-management-frame-origin" content="http:\/\/127\.0\.0\.1:59916" data-version="0.1.0">/);
    assert.match(response.headers.get('content-security-policy')!, /frame-src 'self' http:\/\/127\.0\.0\.1:59916/);
  }
  for (const invalid of [undefined, server.origin, 'https://evil.invalid', 'http://127.0.0.1:59916/other', 'http://127.0.0.1:99999']) {
    frameOrigin = invalid; const response = await fetch(server.origin + '/');
    assert(!(await response.text()).includes('aaa-management-frame-origin'));
    assert(!response.headers.get('content-security-policy')!.includes('frame-src'));
  }
  frameOrigin = 'http://127.0.0.1:59916';
  for (const name of ['appearance.mjs', 'native-workbench-view.mjs']) {
    const imported = await fetch(server.origin + '/' + name);
    assert.equal(imported.status, 200); assert.match(imported.headers.get('content-type')!, /javascript/);
    assert.equal(await imported.text(), 'export const originalModule = true;');
  }
  assert.equal((await fetch(server.origin + '/api/snapshot')).status, 401);
  assert.equal((await fetch(server.origin + '/api/snapshot', { headers: { ...headers, Origin: 'https://foreign.invalid' } })).status, 403);
  const badHost = await new Promise<number>(resolve => { const req = request(server.origin + '/api/snapshot', { headers: { ...headers, Host: 'foreign.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); }); req.end(); });
  assert.equal(badHost, 403);
  assert.equal((await fetch(server.origin + '/api/records?characterId=companion&kind=memory', { headers })).status, 200);
  assert.equal(businessCalls, 1);
  assert.equal((await fetch(server.origin + '/api/records?characterId=other&kind=memory', { headers })).status, 400);
  assert.equal(businessCalls, 1);
  assert.equal((await fetch(server.origin + '/config.json', { headers })).status, 404);
  const snapshot = await fetch(server.origin + '/api/snapshot', { headers });
  assert.equal(snapshot.headers.get('cache-control'), 'no-store'); assert.match(snapshot.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  const state = await snapshot.json() as { modules: { id: string; status: string }[] };
  assert.equal(state.modules.find(x => x.id === 'dialogue')?.status, 'unknown');
  const missingOrigin = { Authorization: headers.Authorization, 'Content-Type': 'application/json' };
  assert.equal((await fetch(server.origin + '/api/settings', { method: 'PUT', headers: missingOrigin, body: JSON.stringify({ expectedRevision: 0, settings: settings.snapshot().saved }) })).status, 403);
  const changed = settings.snapshot().saved; changed.context.maxMemories = 5;
  const save = () => fetch(server.origin + '/api/settings', { method: 'PUT', headers, body: JSON.stringify({ expectedRevision: 0, settings: changed }) });
  assert.equal((await save()).status, 200); assert.equal((await save()).status, 409);
  const failed = await fetch(server.origin + '/api/records/edit', { method: 'POST', headers,
    body: JSON.stringify({ characterId: 'companion', id: 'a', expectedVersion: 1, operationId: 'edit1', text: 'new', reason: 'correction' }) });
  assert.equal(failed.status, 500); assert.equal((await failed.text()).includes('PRIVATE'), false);
});

test('runtime observations report actual attempts, cancellation, latency and no private error payload', async () => {
  const runtime = new ManagementRuntime('a'.repeat(40)), controller = new AbortController();
  let release!: () => void; const pending = new Promise<void>(r => { release = r; });
  const run = runtime.observeCall('tts', 'sweetheart', sent => { sent(); return pending; }, controller.signal);
  assert.equal(runtime.modules().find(m => m.id === 'tts')?.activeJobs, 1);
  release(); await run;
  assert.equal(runtime.modules().find(m => m.id === 'tts')?.activeJobs, 0);
  await assert.rejects(runtime.observeCall('tts', 'sweetheart', async sent => { sent(); throw new Error('PRIVATE key'); }, controller.signal));
  assert.equal(runtime.modules().find(m => m.id === 'tts')?.status, 'error');
  assert.equal(JSON.stringify(runtime.recentEvents()).includes('PRIVATE'), false);
});
