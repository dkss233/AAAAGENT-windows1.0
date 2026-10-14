import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import type { WorkbenchDesktopState, WorkbenchTaskRef } from '../../contracts/workbench.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';
import { DesktopWorkbench } from '../../app/desktop-workbench.js';

const at = '2026-09-28T00:00:00Z';
const project: ProjectEntry = { id: 'project', name: 'Synthetic', abstract: '', version: 1,
  detailRef: { rootPath: '/synthetic' }, updatedAt: at };
const task: Extract<WorkbenchTaskRef, { origin: 't3' }> = { id: 'task', projectId: project.id,
  provider: 'codex', origin: 't3', environmentId: 'env', t3ProjectId: 'native-project',
  threadId: 'native-thread', providerInstanceId: 'codex' };
const projects: ProjectIndexPort = {
  async get(id) { return id === project.id ? project : null; },
  async list() { return { items: [project], total: 1, offset: 0, limit: 100 }; },
  async save() { throw Error('unexpected'); }, async remove() { throw Error('unexpected'); }, async close() {},
};

test('shared list and desktop refresh recover the same completed task from an empty cache with no dispatch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-state-read-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'workbench.sqlite');
  let store = new SqliteWorkbenchStore(file);
  store.bindProject(project, task.environmentId, { id: task.t3ProjectId, workspaceRoot: '/synthetic' }, '/synthetic');
  const empty = { id: task.threadId, projectId: task.t3ProjectId, modelSelection: { instanceId: 'codex' },
    latestTurn: null, hasPendingApprovals: false, hasPendingUserInput: false };
  store.saveVerifiedTask(task, empty);
  let sequence = 10, unavailable = false, wrongIdentity = false, wrongTurn = false;
  let text = 'AAA_B54_CODEX_OK', streaming = false, messageTurn = 'turn', sends = 0;
  const completed = () => ({ ...empty, latestTurn: { turnId: 'turn', state: 'completed' as const,
    completedAt: at, assistantMessageId: 'assistant' } });
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: task.environmentId }; },
    async shellSnapshot() {
      if (unavailable) throw Error('offline');
      return { snapshotSequence: sequence, updatedAt: at,
        projects: [{ id: task.t3ProjectId, workspaceRoot: '/synthetic' }], threads: [completed()] };
    },
    async threadSnapshot() { return { snapshotSequence: sequence, thread: { ...completed(),
      id: wrongIdentity ? 'another-thread' : task.threadId,
      latestTurn: { ...completed().latestTurn, turnId: wrongTurn ? 'next-turn' : 'turn' },
      messages: [{ id: 'older-assistant', role: 'assistant', turnId: 'old-turn', text: 'OLD_RESULT', streaming: false },
        { id: 'assistant', role: 'assistant', turnId: messageTurn, text, streaming }] } }; },
    async dispatch() { sends++; throw Error('read must not dispatch'); }, async readReceipt() { return null; },
  };
  let service = new WorkbenchService(projects, store, native, false);
  assert.equal(store.getTask(task.id)?.projection, null);
  let row = (await service.listTasks(project.id)).tasks[0]!;
  assert.equal(row.projection?.phase, 'completed');
  assert.deepEqual(row.resultPreview, { nativeTurnId: 'turn', messageId: 'assistant', text, truncated: false });
  const states: WorkbenchDesktopState[] = [];
  let desktop = new DesktopWorkbench(projects, service, value => states.push(value));
  await desktop.start();
  await desktop.action({ type: 'select', projectId: project.id, taskId: task.id, expectedRevision: 0 });
  await desktop.action({ type: 'refresh' });
  assert.deepEqual(states.at(-1)!.tasks[0]?.resultPreview, row.resultPreview);
  assert.equal(states.at(-1)!.command, undefined, 'a task result does not manufacture a command receipt');
  assert.equal(states.at(-1)!.dispatchEnabled, false);
  store.close(); store = new SqliteWorkbenchStore(file); t.after(() => store.close());
  service = new WorkbenchService(projects, store, native, false);
  desktop = new DesktopWorkbench(projects, service, value => states.push(value));
  await desktop.start();
  assert.equal(states.at(-1)!.tasks[0]?.projection?.phase, 'completed');
  assert.equal(states.at(-1)!.tasks[0]?.resultPreview?.text, text);
  unavailable = true;
  assert.equal((await service.listTasks(project.id)).tasks[0]?.projection, null, 'offline does not serve an old completion as fresh');
  unavailable = false; wrongIdentity = true;
  assert.equal((await service.listTasks(project.id)).tasks[0]?.projection, null);
  wrongIdentity = false; wrongTurn = true;
  assert.equal((await service.listTasks(project.id)).tasks[0]?.projection, null, 'detail advanced beyond the shell');
  wrongTurn = false; streaming = true;
  assert.equal((await service.listTasks(project.id)).tasks[0]?.resultPreview, undefined);
  streaming = false; messageTurn = 'old-turn';
  assert.equal((await service.listTasks(project.id)).tasks[0]?.resultPreview, undefined, 'same message ID with wrong turn is never a current result');
  messageTurn = 'turn'; text = '文😀'.repeat(200); sequence++;
  row = await service.refreshTask(task.id);
  assert.equal([...row.resultPreview!.text].length, 320);
  assert.equal(row.resultPreview!.truncated, true);
  assert.equal(sends, 0);
});
