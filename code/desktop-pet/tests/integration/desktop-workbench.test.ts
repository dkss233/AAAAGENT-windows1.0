import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import type { WorkbenchDesktopState, WorkbenchTaskRef } from '../../contracts/workbench.js';
import { ManagementError } from '../../contracts/management.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';
import { DesktopWorkbench, parseWorkbenchDesktopAction } from '../../app/desktop-workbench.js';

const at = '2026-09-27T00:00:00Z';
const project: ProjectEntry = { id: 'local-project', name: 'Local project', abstract: '',
  detailRef: { rootPath: '/registered/project' }, version: 1, updatedAt: at };
const task: Extract<WorkbenchTaskRef, { origin: 't3' }> = { id: 'task-1', projectId: project.id,
  provider: 'codex', origin: 't3', environmentId: 'environment-1', t3ProjectId: 'native-project',
  threadId: 'native-thread', providerInstanceId: 'codex' };
const shell = { id: task.threadId, projectId: task.t3ProjectId,
  modelSelection: { instanceId: task.providerInstanceId }, latestTurn: null,
  hasPendingApprovals: false, hasPendingUserInput: false };
const projects: ProjectIndexPort = {
  async get(id) { return id === project.id ? project : null; },
  async list() { return { items: [project], total: 1, offset: 0, limit: 100 }; },
  async save() { throw Error('unexpected'); }, async remove() { throw Error('unexpected'); }, async close() {},
};
const error = (code: string) => (value: unknown) => value instanceof ManagementError && value.code === code;

test('native desktop action parser does not accept caller-selected channel, command or stale version', () => {
  assert.throws(() => parseWorkbenchDesktopAction({ type: 'prepare', projectId: project.id,
    taskId: task.id, expectedFocusRevision: 1, messageId: 'm', rawText: 'request',
    dispatchText: 'request', channel: 'wechat' }), error('invalid_request'));
  assert.throws(() => parseWorkbenchDesktopAction({ type: 'confirm', draftId: 'draft',
    expectedVersion: 0, commandId: 'forged' }), error('invalid_request'));
});

test('desktop focus and exact reviewed draft survive a cold reopen without dispatch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-workbench-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'workbench.sqlite');
  let store = new SqliteWorkbenchStore(file);
  store.bindProject(project, task.environmentId,
    { id: task.t3ProjectId, workspaceRoot: '/registered/project' }, '/registered/project');
  store.saveVerifiedTask(task, shell);
  const browser = store.createWebFocusProfile();
  store.putWebFocus(browser, project.id, task.id, 0);
  let environmentId = task.environmentId;
  let dispatches = 0;
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId }; },
    async shellSnapshot() { return { snapshotSequence: 1, updatedAt: at,
      projects: [{ id: task.t3ProjectId, workspaceRoot: '/registered/project' }], threads: [shell] }; },
    async threadSnapshot() { return { snapshotSequence: 1, thread: { ...shell, messages: [] } }; },
    async dispatch() { dispatches++; throw Error('production dispatch must stay off'); },
    async readReceipt() { return null; },
  };
  let service = new WorkbenchService(projects, store, native, false);
  const states: WorkbenchDesktopState[] = [];
  let desktop = new DesktopWorkbench(projects, service, state => states.push(state));
  await desktop.start();
  assert.equal(states.at(-1)?.focus.projectId, null);
  await desktop.action({ type: 'select', projectId: project.id, taskId: task.id, expectedRevision: 0 });
  assert.equal(states.at(-1)?.focus.task?.id, task.id);
  assert.equal(states.at(-1)?.focus.revision, 1);
  assert.equal(store.getWebFocus(browser, project.id).taskId, task.id);
  await desktop.action({ type: 'prepare', projectId: project.id, taskId: task.id,
    expectedFocusRevision: 1, messageId: 'desktop-message-1', rawText: '请继续 A', dispatchText: '请继续 A' });
  const draft = states.at(-1)?.drafts[0];
  assert.ok(draft);
  assert.equal(draft.input.origin.channel, 'desktop');
  assert.equal(draft.input.rawText, '请继续 A');
  await desktop.action({ type: 'revise', draftId: draft.id, expectedVersion: 1,
    dispatchText: '只完成 A 的测试' });
  assert.equal(states.at(-1)?.drafts[0]?.input.rawText, '请继续 A');
  assert.equal(states.at(-1)?.drafts[0]?.input.dispatchText, '只完成 A 的测试');
  assert.equal(states.at(-1)?.drafts[0]?.version, 2);
  await desktop.action({ type: 'confirm', draftId: draft.id, expectedVersion: 2 });
  assert.equal(states.at(-1)?.command?.state, 'unsupported');
  assert.equal(states.at(-1)?.drafts[0]?.state, 'open');
  assert.equal(dispatches, 0);
  store.close();
  store = new SqliteWorkbenchStore(file);
  t.after(() => store.close());
  service = new WorkbenchService(projects, store, native, false);
  desktop = new DesktopWorkbench(projects, service, state => states.push(state));
  await desktop.start();
  assert.equal(states.at(-1)?.focus.task?.id, task.id);
  assert.equal(states.at(-1)?.drafts[0]?.id, draft.id);
  assert.equal(states.at(-1)?.drafts[0]?.input.dispatchText, '只完成 A 的测试');
  assert.equal(states.at(-1)?.command?.state, 'recorded');
  assert.equal(store.getWebFocus(browser, project.id).taskId, task.id);
  await desktop.action({ type: 'prepare', projectId: project.id, taskId: task.id,
    expectedFocusRevision: 1, messageId: 'desktop-message-1', rawText: '请继续 A', dispatchText: '另一个正文' });
  assert.equal(states.at(-1)?.drafts.length, 1);
  assert.equal(states.at(-1)?.drafts[0]?.input.dispatchText, '只完成 A 的测试');
  await desktop.action({ type: 'dismiss', draftId: draft.id, expectedVersion: 2 });
  assert.equal(states.at(-1)?.drafts.length, 0);
  assert.equal(dispatches, 0);
  const scope = { characterId: 'companion' as const, sessionId: 'live-session',
    turnId: 'asr-turn-1', generation: 1 };
  assert.equal(await desktop.routeInput(scope, '语音补充这项任务', new AbortController().signal,
    () => {}, desktop.focusSnapshot()), true);
  assert.equal(states.at(-1)?.drafts[0]?.input.rawText, '语音补充这项任务');
  assert.deepEqual(states.at(-1)?.drafts[0]?.input.origin.turnScope, scope);
  assert.equal(await desktop.routeInput({ ...scope, turnId: 'stale-turn' }, '旧输入',
    new AbortController().signal, () => { throw Error('stale'); }, desktop.focusSnapshot()), true);
  assert.equal(states.at(-1)?.drafts.length, 1);
  assert.equal(dispatches, 0);
  const voiceDraft = states.at(-1)!.drafts[0]!;
  const selectedBeforeChange = desktop.focusSnapshot();
  await desktop.action({ type: 'select', projectId: project.id, taskId: null, expectedRevision: 1 });
  await assert.rejects(service.confirmDesktopContinuation(voiceDraft.id, voiceDraft.version),
    error('version_conflict'));
  assert.equal(await desktop.routeInput({ ...scope, turnId: 'racing-turn' }, '旧焦点输入',
    new AbortController().signal, () => {}, selectedBeforeChange), true);
  assert.equal(store.listContinuations('desktop', 'desktop-primary', project.id, task.id).drafts.length, 1);
  await desktop.action({ type: 'select', projectId: project.id, taskId: task.id, expectedRevision: 2 });
  environmentId = 'different-environment';
  await assert.rejects(service.prepareDesktopContinuation(project.id, task.id, 3,
    { inputId: 'message-2', origin: { channel: 'desktop', channelSessionId: 'desktop-primary',
      messageId: 'message-2' }, rawText: '继续', dispatchText: '继续', createdAt: at }), error('version_conflict'));
});

test('desktop native interaction uses exact focus and cold-reads one claimed command after reopen', async t => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-native-interaction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const localProject: ProjectEntry = { ...project, detailRef: { rootPath: root } };
  const localProjects: ProjectIndexPort = { ...projects,
    async get(id) { return id === localProject.id ? localProject : null; },
    async list() { return { items: [localProject], total: 1, offset: 0, limit: 100 }; },
  };
  const activity = { id: 'approval-event', kind: 'approval.requested', tone: 'approval',
    summary: 'Run local command?', turnId: 'turn-1', sequence: 8, createdAt: at,
    payload: { requestId: 'native-approval', options: [
      { decision: 'accept', label: 'Allow once', warning: 'Runs command' },
      { decision: 'decline', label: 'Deny' },
    ] } };
  const activities: unknown[] = [activity];
  let sends = 0, malformed = false;
  const receipts = new Map<string, { status: 'accepted'; aggregateKind: 'thread'; aggregateId: string; resultSequence: number }>();
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: task.environmentId }; },
    async shellSnapshot() { return { snapshotSequence: 10, updatedAt: at,
      projects: [{ id: task.t3ProjectId, workspaceRoot: root }],
      threads: [{ ...shell, runtimeMode: 'approval-required', interactionMode: 'default',
        latestTurn: { turnId: 'turn-1', state: 'running' }, hasPendingApprovals: true }] }; },
    async threadSnapshot() { return { thread: { ...shell, runtimeMode: 'approval-required',
      interactionMode: 'default', activities: malformed ? [{ ...activity, sequence: undefined }] : activities,
      session: { threadId: task.threadId, status: 'running', activeTurnId: 'turn-1' }, messages: [] } }; },
    async dispatch(command) {
      sends++;
      assert.equal(command.type, 'thread.approval.respond');
      assert.equal(command.requestId, 'native-approval');
      assert.equal(command.decision, 'decline');
      receipts.set(command.commandId, { status: 'accepted', aggregateKind: 'thread',
        aggregateId: task.threadId, resultSequence: 11 });
      throw Error('synthetic reply lost after native acceptance');
    },
    async readReceipt(commandId) { return receipts.get(commandId) ?? null; },
  };
  const file = join(root, 'workbench.sqlite');
  let store = new SqliteWorkbenchStore(file);
  t.after(() => store.close());
  store.bindProject(localProject, task.environmentId,
    { id: task.t3ProjectId, workspaceRoot: root }, root);
  const service = new WorkbenchService(localProjects, store, native, true);
  const bound = await service.bindTask(localProject.id, task.t3ProjectId, task.threadId, 'codex');
  const states: WorkbenchDesktopState[] = [];
  let desktop = new DesktopWorkbench(localProjects, service, state => states.push(state));
  await desktop.start();
  await desktop.action({ type: 'select', projectId: localProject.id, taskId: bound.id,
    expectedRevision: 0 });
  const pending = states.at(-1)?.native;
  assert.equal(pending?.status, 'supported');
  assert.equal(pending?.bindingsStatus, 'supported');
  assert.equal(pending?.interactions.length, 1);
  assert.equal(pending?.bindings.length, 0);
  assert.equal(pending?.selectedInteractionId, null);
  const interaction = pending!.interactions[0]!;
  assert.equal(interaction.kind, 'approval');
  assert.deepEqual(interaction.kind === 'approval' && interaction.choices.map(row => row.id),
    ['accept', 'decline']);
  const answer = { type: 'respond_interaction', projectId: localProject.id, taskId: bound.id,
    expectedFocusRevision: 1, interactionId: interaction.id, expectedVersion: interaction.version,
    response: { type: 'decide_approval', choiceId: 'decline' } };
  assert.throws(() => parseWorkbenchDesktopAction({ ...answer, commandId: 'forged' }),
    error('invalid_request'));
  assert.throws(() => parseWorkbenchDesktopAction({ ...answer,
    response: { type: 'decide_approval', choiceId: 'decline', answers: [] } }), error('invalid_request'));
  await desktop.action({ ...answer, expectedFocusRevision: 0 });
  assert.equal(sends, 0);
  assert.match(states.at(-1)?.native?.error ?? '', /焦点已变化/);
  await desktop.action({ ...answer, expectedVersion: interaction.version + 1 });
  assert.equal(sends, 0);
  await desktop.action(answer);
  assert.equal(sends, 1);
  const after = states.at(-1)?.native;
  assert.equal(after?.selectedInteractionId, interaction.id);
  assert.equal(after?.bindings.length, 1);
  assert.equal(after?.command?.command.state, 'accepted');
  assert.equal(after?.command?.resolution, 'pending');
  const originalCommandId = after!.bindings[0]!.commandId;
  assert.equal(after?.command?.command.commandId, originalCommandId);
  assert.doesNotMatch(JSON.stringify(after), /selectedOptionIds|customText/);
  await desktop.action(answer);
  assert.equal(sends, 1);
  assert.match(states.at(-1)?.native?.error ?? '', /不能再次提交/);
  store.close(); store = new SqliteWorkbenchStore(file);
  const reopened = new WorkbenchService(localProjects, store, native, true);
  desktop = new DesktopWorkbench(localProjects, reopened, state => states.push(state));
  await desktop.start();
  assert.equal(states.at(-1)?.native?.bindings[0]?.commandId, originalCommandId);
  assert.equal(states.at(-1)?.native?.selectedInteractionId, null);
  await desktop.action({ type: 'read_interaction', projectId: localProject.id, taskId: bound.id,
    expectedFocusRevision: 1, interactionId: interaction.id });
  assert.equal(states.at(-1)?.native?.command?.command.commandId, originalCommandId);
  assert.equal(sends, 1);
  activities.push({ id: 'resolved', kind: 'approval.resolved', tone: 'info', summary: 'resolved',
    turnId: 'turn-1', sequence: 12, createdAt: at, payload: { requestId: 'native-approval' } });
  await desktop.action({ type: 'refresh' });
  assert.equal(states.at(-1)?.native?.command?.resolution, 'answered');
  assert.equal(states.at(-1)?.native?.bindings.length, 1);
  malformed = true;
  await desktop.action({ type: 'refresh' });
  assert.equal(states.at(-1)?.native?.status, 'unverified');
  assert.equal(states.at(-1)?.native?.bindings.length, 1);
  assert.equal(states.at(-1)?.native?.command?.resolution, 'unknown');
  assert.equal(sends, 1);
  await desktop.action({ type: 'select', projectId: localProject.id, taskId: null,
    expectedRevision: 1 });
  assert.equal(states.at(-1)?.native?.status, 'no_target');
  assert.equal(states.at(-1)?.native?.selectedInteractionId, null);
  await desktop.action(answer);
  assert.equal(sends, 1);
});
