import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { fixture } from '../management/helpers.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';

test('explicit Codex low and medium reach original metadata and remain part of once-only creation identity', async t => {
  const f = await fixture(t);
  const at = new Date().toISOString();
  const project: ProjectEntry = { id: 'explicit-effort-project', name: 'Effort test', abstract: '',
    detailRef: { rootPath: f.c.projectRoot }, version: 1, updatedAt: at };
  const projects: ProjectIndexPort = { async get(id) { return id === project.id ? project : null; },
    async list() { throw Error('unexpected'); }, async save() { throw Error('unexpected'); }, async remove() { throw Error('unexpected'); }, async close() {} };
  const nativeProjects: { id: string; workspaceRoot: string }[] = [];
  const threads: Record<string, unknown>[] = [];
  const receipts = new Map<string, { status: 'accepted'; aggregateKind: 'project' | 'thread'; aggregateId: string; resultSequence: number }>();
  const commands: Record<string, unknown>[] = [];
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: 'effort-env' }; },
    async shellSnapshot() { return { snapshotSequence: commands.length, updatedAt: at, projects: nativeProjects, threads }; },
    async threadSnapshot() { throw Error('no model or detail request'); }, async dispatch() { throw Error('no turn allowed'); },
    async providerModels() { return { providers: [{ instanceId: 'codex', driver: 'codex', enabled: true, installed: true,
      status: 'ready', authStatus: 'authenticated', checkedAt: at, models: [{ id: 'chosen-model', name: 'Chosen',
        reasoningEfforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }], defaultReasoningEffort: 'low' }] }] }; },
    async createCommand(command) {
      commands.push(command);
      if (command.type === 'project.create') nativeProjects.push({ id: command.projectId, workspaceRoot: f.c.projectRoot });
      else threads.push({ id: command.threadId, projectId: command.projectId, modelSelection: command.modelSelection,
        runtimeMode: command.runtimeMode, interactionMode: command.interactionMode, latestTurn: null,
        hasPendingApprovals: false, hasPendingUserInput: false });
      receipts.set(command.commandId, { status: 'accepted', aggregateKind: command.type === 'project.create' ? 'project' : 'thread',
        aggregateId: String(command.threadId ?? command.projectId), resultSequence: commands.length });
      return { sequence: commands.length };
    }, async readReceipt(id) { return receipts.get(id) ?? null; },
  };
  const store = new SqliteWorkbenchStore(join(f.c.projectRoot, 'effort.sqlite')); t.after(() => store.close());
  const service = new WorkbenchService(projects, store, native, false);
  for (const effort of ['low', 'medium']) {
    const request = { operationId: randomUUID(), projectId: project.id, title: effort, provider: 'codex' as const,
      modelSelection: { instanceId: 'codex', model: 'chosen-model', reasoningEffort: effort } };
    const result = await service.createNativeTask(request); assert.equal(result.state, 'accepted');
    const command = commands.at(-1)!;
    assert.deepEqual(command.modelSelection, { instanceId: 'codex', model: 'chosen-model', options: [{ id: 'reasoningEffort', value: effort }] });
    const sent = commands.length; await service.createNativeTask(request); assert.equal(commands.length, sent);
    await assert.rejects(service.createNativeTask({ ...request, modelSelection: { ...request.modelSelection,
      reasoningEffort: effort === 'low' ? 'medium' : 'low' } }), /另一项目或配置/);
  }
  const sent = commands.length;
  await assert.rejects(service.createNativeTask({ operationId: randomUUID(), projectId: project.id, title: 'invalid', provider: 'codex',
    modelSelection: { instanceId: 'codex', model: 'chosen-model', reasoningEffort: 'unlisted' } }), /模型不在当前账号目录/);
  assert.equal(commands.length, sent);
});

test('native task creation claims each command once and cold local readback never repeats a lost send', async t => {
  const f = await fixture(t);
  const at = '2026-09-27T00:00:00.000Z';
  let project: ProjectEntry = { id: 'local-create', name: 'Registered project', abstract: '',
    detailRef: { rootPath: f.c.projectRoot }, version: 1, updatedAt: at };
  const projects: ProjectIndexPort = { async get(id) { return id === project.id ? project : null; },
    async list() { throw Error('unexpected'); }, async save() { throw Error('unexpected'); },
    async remove() { throw Error('unexpected'); }, async close() {} };
  const memory: ManagementMemoryPort = { characters: () => [], list() { throw Error('unexpected'); },
    edit() { throw Error('unexpected'); }, context() { throw Error('unexpected'); },
    prompt() { throw Error('unexpected'); }, savePrompt() { throw Error('unexpected'); } };
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const nativeProjects: { id: string; workspaceRoot: string }[] = [];
  const nativeThreads: { id: string; projectId: string; modelSelection: { instanceId: string }; latestTurn: null;
    hasPendingApprovals: boolean; hasPendingUserInput: boolean }[] = [];
  const receipts = new Map<string, { status: 'accepted'; aggregateKind: 'project' | 'thread'; aggregateId: string;
    resultSequence: number }>();
  const sends: string[] = [];
  let turnSends = 0;
  let modelsAvailable = true;
  let projectReceiptDelayed = true;
  const modelCheckedAt = new Date().toISOString();
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: 'native-environment' }; },
    async shellSnapshot() { return { snapshotSequence: sends.length, updatedAt: at,
      projects: nativeProjects, threads: nativeThreads }; },
    async threadSnapshot() { throw Error('unexpected detail'); },
    async providerModels() { if (!modelsAvailable) throw Error('catalog read lost'); return { providers: [{
      instanceId: 'codex', driver: 'codex', enabled: true, installed: true, status: 'ready',
      authStatus: 'authenticated', checkedAt: modelCheckedAt,
      models: [{ id: 'explicit-model', name: 'Verified model' }],
    }] }; },
    async dispatch() { turnSends++; throw Error('no provider turn allowed'); },
    async createCommand(command) {
      sends.push(command.type);
      if (command.type === 'project.create') {
        assert.equal(command.workspaceRoot, project.detailRef.rootPath);
        nativeProjects.push({ id: command.projectId, workspaceRoot: project.detailRef.rootPath });
        if (!projectReceiptDelayed) receipts.set(command.commandId,
          { status: 'accepted', aggregateKind: 'project', aggregateId: command.projectId,
            resultSequence: sends.length });
      } else {
        assert.equal(command.runtimeMode, 'approval-required');
        assert.deepEqual(command.modelSelection, { instanceId: 'codex', model: 'explicit-model' });
        nativeThreads.push({ id: command.threadId as string, projectId: command.projectId,
          modelSelection: { instanceId: 'codex' }, latestTurn: null,
          hasPendingApprovals: false, hasPendingUserInput: false });
        // Simulate a lost native acknowledgement: the thread exists, but receipt readback is late.
      }
      return { sequence: sends.length };
    },
    async readReceipt(commandId) { return receipts.get(commandId) ?? null; },
  };
  const file = join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite');
  let store = new SqliteWorkbenchStore(file);
  let workbench = new WorkbenchService(projects, store, native);
  let server = await startManagementServer({ uiRoot: resolve(import.meta.dirname, '../../../management/ui'),
    settings, memory, projects, workbench,
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: [], events: [],
      settings: settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  let serverActive = true;
  let storeActive = true;
  t.after(async () => { if (serverActive) await server.close(); if (storeActive) store.close(); });
  const operationId = randomUUID();
  const request = { operationId, projectId: project.id, title: 'No-turn task', provider: 'codex' as const,
    modelSelection: { instanceId: 'codex', model: 'explicit-model' } };
  const headers = { Authorization: `Bearer ${server.token}`, Origin: server.origin,
    'Content-Type': 'application/json' };
  const post = (body: unknown, customHeaders = headers) => fetch(server.origin + '/api/workbench/tasks/create',
    { method: 'POST', headers: customHeaders, body: JSON.stringify(body) });
  assert.deepEqual(await (await fetch(server.origin + '/api/workbench/provider-models', { headers })).json(),
    { version: '0.1.0', available: true, provider: 'codex', instanceId: 'codex',
      checkedAt: modelCheckedAt,
      models: [{ id: 'explicit-model', name: 'Verified model' }] });
  assert.equal((await post(request, { ...headers, Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await post({ ...request, workspaceRoot: '/spoofed' })).status, 400);
  assert.equal((await post({ ...request, projectId: 'other-project' })).status, 404);
  assert.equal((await post({ ...request, modelSelection: { instanceId: 'codex', model: 'unlisted' } })).status, 400);
  assert.deepEqual(sends, []);
  const first = await post(request);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { operationId, state: 'unknown', stage: 'project' });
  assert.deepEqual(sends, ['project.create']);
  assert.equal(turnSends, 0);
  const intent = store.getNativeCreate(operationId)!;
  assert.equal(intent.projectPhase, 'unknown');
  assert.equal(intent.threadPhase, 'new');
  const pending = await fetch(server.origin + '/api/workbench/tasks/creations?projectId=' + project.id, { headers });
  assert.equal(pending.status, 200);
  assert.deepEqual(await pending.json(), { version: '0.1.0', projectId: project.id,
    creations: [{ operationId, createdAt: intent.createdAt, state: 'unknown', stage: 'project',
      request }] });
  assert.equal((await fetch(server.origin + '/api/workbench/tasks/creations?projectId=other-project',
    { headers })).status, 404);
  assert.deepEqual(sends, ['project.create']);
  modelsAvailable = false;
  assert.equal((await (await post(request)).json() as { state: string }).state, 'unknown');
  assert.equal((await (await fetch(server.origin + '/api/workbench/provider-models', { headers })).json() as { available: boolean }).available, false);
  assert.deepEqual(sends, ['project.create']);
  project = { ...project, name: 'Renamed project', version: 2 };
  projectReceiptDelayed = false;
  receipts.set(intent.projectCommandId, { status: 'accepted', aggregateKind: 'project',
    aggregateId: intent.t3ProjectId, resultSequence: 1 });
  assert.deepEqual(await workbench.createNativeTask(request), { operationId, state: 'unknown', stage: 'thread' });
  assert.equal(store.getNativeCreate(operationId)?.projectPhase, 'accepted');
  assert.equal(store.getNativeCreate(operationId)?.threadPhase, 'unknown');
  assert.deepEqual(sends, ['project.create', 'thread.create']);
  assert.deepEqual((await workbench.unfinishedNativeCreations(project.id)).creations.map(item => item.stage), ['thread']);
  await server.close();
  serverActive = false;
  store.close();
  storeActive = false;
  store = new SqliteWorkbenchStore(file);
  storeActive = true;
  workbench = new WorkbenchService(projects, store, native);
  assert.deepEqual((await workbench.unfinishedNativeCreations(project.id)).creations.map(item => item.request), [request]);
  receipts.set(intent.threadCommandId, { status: 'accepted', aggregateKind: 'thread',
    aggregateId: intent.threadId, resultSequence: 2 });
  const recovered = await workbench.createNativeTask(request);
  assert.equal(recovered.state, 'accepted');
  assert.equal(recovered.task?.origin, 't3');
  if (recovered.task?.origin !== 't3') throw Error('native task missing');
  assert.equal(recovered.task.projectId, project.id);
  assert.equal(recovered.task.t3ProjectId, intent.t3ProjectId);
  assert.deepEqual(sends, ['project.create', 'thread.create']);
  assert.equal((await workbench.createNativeTask(request)).task?.id, recovered.task?.id);
  assert.deepEqual((await workbench.unfinishedNativeCreations(project.id)).creations, []);
  await assert.rejects(workbench.createNativeTask({ ...request, title: 'Changed target' }), /另一项目或配置/);
  const next = { ...request, operationId: randomUUID(), title: 'Second task' };
  modelsAvailable = true;
  const [parallelA, parallelB] = await Promise.all([
    workbench.createNativeTask(next), workbench.createNativeTask(next),
  ]);
  assert.equal(parallelA.state, 'unknown');
  assert.equal(parallelB.state, 'unknown');
  assert.deepEqual(sends, ['project.create', 'thread.create', 'thread.create']);
  assert.equal(store.listProjectBindings(project.id).length, 1);
  assert.equal(turnSends, 0);
  store.close();
  storeActive = false;
  const oldSchema = new Database(file);
  oldSchema.exec('DROP TABLE native_create_inputs');
  oldSchema.close();
  store = new SqliteWorkbenchStore(file);
  storeActive = true;
  workbench = new WorkbenchService(projects, store, native);
  const legacy = (await workbench.unfinishedNativeCreations(project.id)).creations
    .find(row => row.operationId === next.operationId);
  assert.equal(legacy?.request, null);
  assert.equal((await workbench.createNativeTask(next)).state, 'unknown');
  assert.deepEqual(sends, ['project.create', 'thread.create', 'thread.create']);
  const restored = (await workbench.unfinishedNativeCreations(project.id)).creations
    .find(row => row.operationId === next.operationId);
  assert.deepEqual(restored?.request, next);
});
