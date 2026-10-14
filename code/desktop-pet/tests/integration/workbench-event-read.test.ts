import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture } from '../management/helpers.js';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import type { WorkbenchTaskRef } from '../../contracts/workbench.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';

const at = '2026-09-27T00:00:00.000Z';

test('task event read validates exact native identity across both reads and strips bodies', async t => {
  const f = await fixture(t);
  const project: ProjectEntry = { id: 'logical-project', name: 'Project', abstract: '',
    detailRef: { rootPath: f.c.projectRoot }, version: 1, updatedAt: at };
  const projects: ProjectIndexPort = { async get(id) { return id === project.id ? project : null; },
    async list() { throw Error('unexpected'); }, async save() { throw Error('unexpected'); },
    async remove() { throw Error('unexpected'); }, async close() {} };
  const store = new SqliteWorkbenchStore(join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite'));
  t.after(() => store.close());
  let environment = 'native-environment', nativeProject = 'native-project', reads = 0, dispatches = 0;
  let response: unknown = { threadId: 'native-thread', afterSequence: 5, headSequence: 9,
    nextSequence: 9, hasMore: false, resetRequired: false, events: [{ eventId: 'e-7', sequence: 7,
      occurredAt: at, type: 'thread.activity-appended', turnId: 'turn-1', payload: { secret: 'private' } }] };
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: environment }; },
    async shellSnapshot() { return { snapshotSequence: 9, updatedAt: at,
      projects: [{ id: 'native-project', workspaceRoot: f.c.projectRoot }],
      threads: [{ id: 'native-thread', projectId: nativeProject, modelSelection: { instanceId: 'codex' },
        latestTurn: null, hasPendingApprovals: false, hasPendingUserInput: false }] }; },
    async threadSnapshot() { throw Error('not part of event read'); },
    async threadEventPage() { reads++; return response; },
    async dispatch() { dispatches++; throw Error('must not dispatch'); },
  };
  store.bindProject(project, environment, { id: 'native-project', workspaceRoot: f.c.projectRoot }, f.c.projectRoot);
  const service = new WorkbenchService(projects, store, native);
  const task = await service.bindTask(project.id, 'native-project', 'native-thread', 'codex');
  const page = await service.readTaskEventPage(task.id, 5);
  assert.equal(page.status, 'supported');
  assert.equal(page.nextSequence, 9);
  assert.deepEqual(page.events, [{ eventId: 'e-7', sequence: 7,
    occurredAt: at, type: 'thread.activity-appended', turnId: 'turn-1' }]);
  assert.equal(reads, 1);
  assert.equal(dispatches, 0);
  response = { threadId: 'native-thread', afterSequence: 9, headSequence: 12,
    nextSequence: 12, hasMore: false, resetRequired: true, resetReason: 'gap_too_large', events: [] };
  const reset = await service.readTaskEventPage(task.id, 9);
  assert.equal(reset.resetRequired, true);
  assert.equal(reset.events.length, 0);
  response = { ...response as object, resetRequired: false };
  await assert.rejects(service.readTaskEventPage(task.id, 9), { code: 'unavailable' });
  response = { threadId: 'native-thread', afterSequence: 9, headSequence: 12,
    nextSequence: 12, hasMore: false, resetRequired: false, events: [] };
  nativeProject = 'different-project';
  await assert.rejects(service.readTaskEventPage(task.id, 9), { code: 'version_conflict' });
  nativeProject = 'native-project';
  const originalRead = native.threadEventPage!;
  native.threadEventPage = async (...args) => { const result = await originalRead(...args); environment = 'changed'; return result; };
  await assert.rejects(service.readTaskEventPage(task.id, 9), { code: 'version_conflict' });
  assert.equal(dispatches, 0);
});

test('restart scan pages only nonterminal task references and never performs native calls', async t => {
  const f = await fixture(t);
  const file = join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite');
  const project: ProjectEntry = { id: 'logical-project', name: 'Project', abstract: '',
    detailRef: { rootPath: f.c.projectRoot }, version: 1, updatedAt: at };
  let store = new SqliteWorkbenchStore(file);
  t.after(() => store.close());
  store.bindProject(project, 'env', { id: 'native-project', workspaceRoot: f.c.projectRoot }, f.c.projectRoot);
  const tasks: Extract<WorkbenchTaskRef, { origin: 't3' }>[] = Array.from({ length: 4 }, (_, index) => ({
    id: `task-${index}`, projectId: project.id, origin: 't3', provider: 'codex', environmentId: 'env',
    t3ProjectId: 'native-project', threadId: `thread-${index}`, providerInstanceId: 'codex',
  }));
  for (const task of tasks) store.saveVerifiedTask(task, { id: task.threadId, projectId: 'native-project',
    modelSelection: { instanceId: 'codex' }, latestTurn: null,
    hasPendingApprovals: false, hasPendingUserInput: false });
  store.recordEvent({ eventId: 'done', taskId: tasks[1]!.id, sequence: 1,
    phase: 'completed', observedAt: at, nativeTurnId: 'finished-turn', evidence: 'native_read' });
  store.recordEvent({ eventId: 'running', taskId: tasks[2]!.id, sequence: 1,
    phase: 'running', observedAt: at, evidence: 'native_read' });
  store.close();
  store = new SqliteWorkbenchStore(file);
  const first = store.scanRecoverableTasks(undefined, 2);
  assert.deepEqual(first.tasks.map(task => task.id), ['task-0', 'task-2']);
  assert.ok(first.nextCursor);
  const second = store.scanRecoverableTasks(first.nextCursor!, 2);
  assert.deepEqual(second.tasks.map(task => task.id), ['task-3']);
  assert.equal(second.nextCursor, null);
  assert.throws(() => store.scanRecoverableTasks('r:0'), { code: 'invalid_request' });
  assert.throws(() => store.scanRecoverableTasks(undefined, 101), { code: 'invalid_request' });
});
