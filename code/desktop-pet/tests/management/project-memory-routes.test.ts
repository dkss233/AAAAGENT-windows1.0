import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fixture } from './helpers.js';
import { startManagementServer } from '../../management/server.js';
import { projectMemoryRoute } from '../../management/project-memory-routes.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import { SqliteProjectMemory } from '../../projects/project-memory-sqlite.js';
import type { ProjectMemoryChange, ProjectMemoryPort } from '../../contracts/project-memory.js';
import type { IncomingMessage } from 'node:http';

test('authenticated project memory HTTP preserves project scope, explicit-source idempotence and withdrawal', async t => {
  const f = await fixture(t);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const store = new SqliteProjectMemory(join(f.c.projectRoot, 'data/desktop-pet/project-memory.sqlite'));
  t.after(() => store.close());
  const entry = (id: string): ProjectEntry => ({ id, name: id, abstract: '', detailRef: { rootPath: '/synthetic' },
    version: 1, updatedAt: '2026-09-25T00:00:00.000Z' });
  const projects: ProjectIndexPort = {
    async get(id) { return id === 'project-a' || id === 'project-b' ? entry(id) : null; },
    async list() { throw Error('unexpected index list'); }, async save() { throw Error('unexpected index save'); },
    async remove() { throw Error('unexpected index remove'); }, async close() {},
  };
  const memory: ManagementMemoryPort = { characters: () => [], list() { throw Error('companion memory read'); },
    edit() { throw Error('companion memory edit'); }, context() { throw Error('companion context read'); },
    prompt() { throw Error('companion prompt read'); }, savePrompt() { throw Error('companion prompt write'); } };
  const server = await startManagementServer({ uiRoot: resolve(import.meta.dirname, '../../../management/ui'), settings, memory, projects, projectMemory: store,
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: [], events: [], settings: settings.snapshot(),
      adapters: [], credentials: [], characters: [] }) });
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${server.token}`, Origin: server.origin, 'Content-Type': 'application/json' };
  for (const moduleName of ['app.mjs', 'workbench-view.mjs', 'project-memory-view.mjs']) {
    const asset = await fetch(`${server.origin}/${moduleName}`);
    assert.equal(asset.status, 200, moduleName);
    assert.match(asset.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.ok((await asset.text()).length > 0);
  }
  const post = (path: string, value: unknown, otherHeaders = headers) => fetch(server.origin + path, {
    method: 'POST', headers: otherHeaders, body: JSON.stringify(value),
  });
  const base = { projectId: 'project-a', operationId: 'manual-01', recordedAt: '2026-09-25T00:00:00.000Z',
    type: 'create', kind: 'decision', text: 'Use the selected repository', status: 'accepted' };

  assert.equal((await fetch(server.origin + '/api/project-memory/items?projectId=project-a')).status, 401);
  assert.equal((await post('/api/project-memory/change', base, { ...headers, Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await post('/api/project-memory/change', { ...base, projectId: 'missing' })).status, 404);
  assert.equal((await post('/api/project-memory/change', { ...base, sources: [{ userInputId: 'forged' }] })).status, 400);
  assert.equal((await store.list({ projectId: 'project-a', limit: 10 })).length, 0);

  const createdResponse = await post('/api/project-memory/change', base);
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json() as { state: string; item: { id: string; status: string; version: number; sources: { userInputId?: string }[] } };
  assert.equal(created.state, 'applied'); assert.equal(created.item.status, 'accepted');
  assert.equal(created.item.sources[0]?.userInputId, 'management:manual-01');
  assert.deepEqual(await (await post('/api/project-memory/change', base)).json(), created);
  assert.equal((await post('/api/project-memory/change', { ...base, text: 'changed with same operation' })).status, 400);
  assert.equal((await (await fetch(server.origin + '/api/project-memory/items?projectId=project-b', { headers })).json() as { items: unknown[] }).items.length, 0);
  assert.equal((await fetch(server.origin + `/api/project-memory/item?projectId=project-b&id=${created.item.id}`, { headers })).status, 404);
  assert.deepEqual(await (await fetch(server.origin + '/api/project-memory/jobs?projectId=project-a', { headers })).json(),
    { jobs: [], processingAvailable: false });

  const staleEdit = { projectId: 'project-a', operationId: 'manual-stale', recordedAt: '2026-09-25T00:00:30.000Z',
    type: 'edit', id: created.item.id, expectedVersion: created.item.version + 1, text: 'stale edit' };
  const conflict = await (await post('/api/project-memory/change', staleEdit)).json() as { state: string };
  assert.equal(conflict.state, 'conflict');

  const scopedEdit = { projectId: 'project-a', operationId: 'manual-scope', recordedAt: '2026-09-25T00:00:45.000Z',
    type: 'edit', id: created.item.id, expectedVersion: created.item.version, text: 'scoped decision',
    kind: 'constraint', branchRef: 'branch/a', condition: 'reviewed' };
  const edited = await (await post('/api/project-memory/change', scopedEdit)).json() as {
    state: string; item: { version: number; kind: string; branchRef: string; condition: string };
  };
  assert.equal(edited.state, 'applied');
  assert.deepEqual([edited.item.kind, edited.item.branchRef, edited.item.condition], ['constraint', 'branch/a', 'reviewed']);
  assert.equal((await store.recall({ projectId: 'project-a', branchRef: 'branch/b', limit: 10 })).length, 0);
  assert.equal((await store.recall({ projectId: 'project-a', branchRef: 'branch/a', limit: 10 })).length, 1);
  assert.deepEqual(await (await post('/api/project-memory/change', scopedEdit)).json(), edited);

  const withdraw = { projectId: 'project-a', operationId: 'manual-02', recordedAt: '2026-09-25T00:01:00.000Z',
    type: 'withdraw', id: created.item.id, expectedVersion: edited.item.version };
  const withdrawn = await (await post('/api/project-memory/change', withdraw)).json() as { state: string; item: { status: string } };
  assert.equal(withdrawn.state, 'applied'); assert.equal(withdrawn.item.status, 'withdrawn');
  assert.equal((await store.recall({ projectId: 'project-a', limit: 10 })).length, 0);
  assert.equal((await (await fetch(server.origin + '/api/project-memory/items?projectId=project-a', { headers })).json() as { items: unknown[] }).items.length, 1);
  assert.equal((await post('/api/project-memory/jobs/retry', { projectId: 'project-a', jobId: 'missing' })).status, 503);
});

test('project memory edit route forwards validated scope replacements and explicit clearing', async () => {
  let forwarded: ProjectMemoryChange | undefined;
  const projects = { get: async () => ({ id: 'project-a' }) } as unknown as ProjectIndexPort;
  const memory = { change: async (input: ProjectMemoryChange) => {
    forwarded = input;
    return { operationId: input.operationId, state: 'applied' as const };
  } } as ProjectMemoryPort;
  const request = { method: 'POST' } as IncomingMessage;
  const url = new URL('http://127.0.0.1/api/project-memory/change');
  const submitted = { projectId: 'project-a', operationId: 'edit-scope-1', recordedAt: '2026-09-26T00:00:00Z',
    type: 'edit', id: 'pm_1', expectedVersion: 2, text: 'Keep the verified decision', kind: 'decision',
    branchRef: null, condition: 'Only after review' };
  let response: unknown;
  assert.equal(await projectMemoryRoute(request, url, projects, memory, false, async () => submitted, value => { response = value; }), true);
  assert.deepEqual(forwarded, { projectId: 'project-a', operationId: 'edit-scope-1', type: 'edit', id: 'pm_1',
    expectedVersion: 2, text: 'Keep the verified decision', kind: 'decision', branchRef: null,
    condition: 'Only after review', source: { userInputId: 'management:edit-scope-1', recordedAt: '2026-09-26T00:00:00Z' } });
  assert.deepEqual(response, { operationId: 'edit-scope-1', state: 'applied' });
  await assert.rejects(projectMemoryRoute(request, url, projects, memory, false,
    async () => ({ ...submitted, kind: 'invented' }), () => {}), { code: 'invalid_request' });
});
