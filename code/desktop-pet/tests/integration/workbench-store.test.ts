import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectEntry } from '../../contracts/projects.js';
import type { WorkbenchTaskRef } from '../../contracts/workbench.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';

const at = '2026-09-27T00:00:00.000Z';
const project: ProjectEntry = { id: 'local-project', name: 'Project', abstract: '',
  detailRef: { rootPath: '/registered/project' }, version: 1, updatedAt: at };
const task: WorkbenchTaskRef & { origin: 't3' } = { id: 'task-one', projectId: project.id, origin: 't3',
  provider: 'codex', environmentId: 'environment-one', t3ProjectId: 'native-project',
  threadId: 'thread-one', providerInstanceId: 'codex' };
const shell = { id: task.threadId, projectId: task.t3ProjectId, modelSelection: { instanceId: task.providerInstanceId },
  latestTurn: null, hasPendingApprovals: false, hasPendingUserInput: false };

test('verified local/native project and task bindings survive reopen without allowing cross-project takeover', () => {
  const folder = mkdtempSync(join(tmpdir(), 'wb-store-'));
  const file = join(folder, 'workbench.sqlite');
  try {
    const first = new SqliteWorkbenchStore(file);
    assert.equal(statSync(file).mode & 0o077, 0);
    assert.throws(() => first.bindProject(project, task.environmentId,
      { id: task.t3ProjectId, workspaceRoot: '/elsewhere' }, '/registered/project'), /工作目录/);
    assert.equal(first.bindProject(project, task.environmentId,
      { id: task.t3ProjectId, workspaceRoot: '/registered/project' }, '/registered/project').projectId, project.id);
    assert.throws(() => first.bindProject({ ...project, id: 'other-local' }, task.environmentId,
      { id: task.t3ProjectId, workspaceRoot: '/registered/project' }, '/registered/project'), /已有不同/);
    assert.throws(() => first.saveVerifiedTask({ ...task, t3ProjectId: 'unbound-native' },
      { ...shell, projectId: 'unbound-native' }), /尚未核实/);
    assert.throws(() => first.saveVerifiedTask(task, { ...shell, projectId: 'wrong-native' }), /identity/);
    first.saveVerifiedTask(task, shell);
    assert.throws(() => first.saveVerifiedTask({ ...task, id: 'second-task', providerInstanceId: 'other-instance' },
      { ...shell, modelSelection: { instanceId: 'other-instance' } }), /另一项任务/);
    assert.equal(first.getTask(task.id)?.task.projectId, project.id);
    first.close();

    const reopened = new SqliteWorkbenchStore(file);
    assert.equal(reopened.getProjectBinding(project.id, task.environmentId, task.t3ProjectId)?.workspaceRoot,
      '/registered/project');
    assert.equal(reopened.listTasks(project.id).length, 1);
    const newer = reopened.recordEvent({ eventId: 'event-new', taskId: task.id, sequence: 2,
      phase: 'running', observedAt: at, nativeTurnId: 'turn-new', evidence: 'native_read' });
    const stale = reopened.recordEvent({ eventId: 'event-old', taskId: task.id, sequence: 1,
      phase: 'completed', observedAt: at, nativeTurnId: 'turn-old', evidence: 'native_read' });
    assert.deepEqual(stale, newer);
    assert.equal(reopened.getTask(task.id)?.projection?.phase, 'running');
    reopened.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('web focus belongs to a server-issued browser profile and project across SQLite reopen', () => {
  const folder = mkdtempSync(join(tmpdir(), 'wb-focus-'));
  const file = join(folder, 'workbench.sqlite');
  try {
    const first = new SqliteWorkbenchStore(file);
    first.bindProject(project, task.environmentId,
      { id: task.t3ProjectId, workspaceRoot: '/registered/project' }, '/registered/project');
    first.saveVerifiedTask(task, shell);
    const browserA = first.createWebFocusProfile(), browserB = first.createWebFocusProfile();
    assert.deepEqual(first.getWebFocus(browserA, project.id), { revision: 0, taskId: null });
    assert.deepEqual(first.putWebFocus(browserA, project.id, task.id, 0), { revision: 1, taskId: task.id });
    assert.deepEqual(first.getWebFocus(browserB, project.id), { revision: 0, taskId: null });
    assert.throws(() => first.putWebFocus(browserA, 'other-project', task.id, 0), /这个项目/);
    assert.throws(() => first.putWebFocus(browserA, project.id, null, 0), /另一页面更新/);
    first.close();
    const reopened = new SqliteWorkbenchStore(file);
    assert.equal(reopened.hasWebFocusProfile(browserA), true);
    assert.deepEqual(reopened.getWebFocus(browserA, project.id), { revision: 1, taskId: task.id });
    assert.deepEqual(reopened.putWebFocus(browserA, project.id, null, 1), { revision: 2, taskId: null });
    assert.deepEqual(reopened.getWebFocus(browserB, project.id), { revision: 0, taskId: null });
    reopened.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
