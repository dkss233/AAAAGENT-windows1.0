import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { fixture } from '../management/helpers.js';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import type { WorkbenchInput } from '../../contracts/workbench.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';

const at = '2026-09-27T00:00:00.000Z';

test('channel continuation freezes reviewed input and native target; lost replies only read back one command', async t => {
  const f = await fixture(t);
  const project: ProjectEntry = { id: 'logical-project', name: 'Project', abstract: '',
    detailRef: { rootPath: f.c.projectRoot }, version: 1, updatedAt: at };
  const projects: ProjectIndexPort = { async get(id) { return id === project.id ? project : null; },
    async list() { throw Error('unexpected'); }, async save() { throw Error('unexpected'); },
    async remove() { throw Error('unexpected'); }, async close() {} };
  const receipts = new Map<string, { status: 'accepted'; aggregateKind: 'thread'; aggregateId: string; resultSequence: number }>();
  let sends = 0, nativeProject = 'native-project', environment = 'native-environment', receiptVisible = true;
  let runtimeMode: string | undefined = 'approval-required';
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: environment }; },
    async shellSnapshot() { return { snapshotSequence: 8, updatedAt: at,
      projects: [{ id: nativeProject, workspaceRoot: f.c.projectRoot }],
      threads: [{ id: 'native-thread', projectId: nativeProject, modelSelection: { instanceId: 'codex' },
        runtimeMode, interactionMode: 'plan',
        latestTurn: null, hasPendingApprovals: false, hasPendingUserInput: false }] }; },
    async threadSnapshot() { return { thread: { id: 'native-thread', projectId: nativeProject,
      modelSelection: { instanceId: 'codex' }, runtimeMode, interactionMode: 'plan' } }; },
    async dispatch(command) {
      sends++;
      assert.equal(command.type, 'thread.turn.start');
      assert.equal(command.threadId, 'native-thread');
      assert.equal(command.message.text, 'Reviewed two');
      assert.equal(command.runtimeMode, 'approval-required');
      assert.equal(command.interactionMode, 'plan');
      if (receiptVisible) receipts.set(command.commandId, { status: 'accepted', aggregateKind: 'thread',
        aggregateId: 'native-thread', resultSequence: 9 });
      throw Error('reply lost after native acceptance');
    },
    async readReceipt(commandId) { return receipts.get(commandId) ?? null; },
  };
  const filename = join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite');
  let store = new SqliteWorkbenchStore(filename);
  t.after(() => store.close());
  const service = new WorkbenchService(projects, store, native, true);
  store.bindProject(project, environment, { id: nativeProject, workspaceRoot: f.c.projectRoot }, f.c.projectRoot);
  const task = await service.bindTask(project.id, nativeProject, 'native-thread', 'codex');
  const input: WorkbenchInput = { inputId: 'input-1', origin: { channel: 'wechat', channelSessionId: 'bound-1',
    messageId: 'wechat-message-1' }, rawText: 'Original voice transcript', dispatchText: 'Reviewed one', createdAt: at };
  const draft = await service.prepareContinuation(task.id, input);
  const disabled = new WorkbenchService(projects, store, native);
  assert.equal((await disabled.confirmContinuation(draft.id, 1, 'wechat', 'bound-1')).state, 'unsupported');
  assert.equal((await disabled.readContinuation(draft.id, 'wechat', 'bound-1')).state, 'recorded');
  assert.equal(sends, 0);
  assert.equal(draft.task.id, task.id);
  assert.deepEqual(service.readContinuationDraft(draft.id, 'wechat', 'bound-1'), draft);
  assert.throws(() => service.readContinuationDraft(draft.id, 'wechat', 'other-channel-session'),
    { code: 'not_found' });
  assert.equal((await service.prepareContinuation(task.id, input)).id, draft.id);
  await assert.rejects(service.prepareContinuation(task.id, { ...input, rawText: 'Changed original' }),
    { code: 'version_conflict' });
  await assert.rejects(service.readContinuation(draft.id, 'wechat', 'other-channel-session'), { code: 'not_found' });
  const reviewed = service.reviseContinuation(draft.id, 1, 'wechat', 'bound-1', 'Reviewed two');
  assert.equal(reviewed.version, 2);
  assert.equal(reviewed.input.rawText, input.rawText);
  assert.throws(() => service.reviseContinuation(draft.id, 1, 'wechat', 'bound-1', 'stale'),
    { code: 'version_conflict' });
  await assert.rejects(service.confirmContinuation(draft.id, 1, 'wechat', 'bound-1'),
    { code: 'version_conflict' });
  assert.equal(sends, 0);
  assert.equal((await service.confirmContinuation(draft.id, 2, 'wechat', 'bound-1')).state, 'accepted');
  assert.equal(sends, 1);
  assert.equal((await service.confirmContinuation(draft.id, 2, 'wechat', 'bound-1')).state, 'accepted');
  assert.equal(sends, 1);
  store.close();
  store = new SqliteWorkbenchStore(filename);
  const reopened = new WorkbenchService(projects, store, native, true);
  assert.equal((await reopened.readContinuation(draft.id, 'wechat', 'bound-1')).state, 'accepted');
  assert.equal(sends, 1);

  const uncertain = await reopened.prepareContinuation(task.id, { ...input, inputId: 'input-unknown',
    dispatchText: 'Reviewed two', origin: { ...input.origin, messageId: 'wechat-message-unknown' } });
  receiptVisible = false;
  assert.equal((await reopened.confirmContinuation(uncertain.id, 1, 'wechat', 'bound-1')).state, 'unknown');
  assert.equal((await reopened.confirmContinuation(uncertain.id, 1, 'wechat', 'bound-1')).state, 'unknown');
  assert.equal(sends, 2);
  receipts.set(uncertain.commandId, { status: 'accepted', aggregateKind: 'thread',
    aggregateId: 'native-thread', resultSequence: 10 });
  assert.equal((await reopened.readContinuation(uncertain.id, 'wechat', 'bound-1')).state, 'accepted');
  assert.equal(sends, 2);

  const second = await reopened.prepareContinuation(task.id, { ...input, inputId: 'input-2',
    origin: { ...input.origin, messageId: 'wechat-message-2' } });
  nativeProject = 'drifted-project';
  await assert.rejects(reopened.confirmContinuation(second.id, 1, 'wechat', 'bound-1'),
    { code: 'version_conflict' });
  assert.equal((await reopened.readContinuation(second.id, 'wechat', 'bound-1')).state, 'recorded');
  assert.equal(sends, 2);
  nativeProject = 'native-project';
  environment = 'native-environment';
  const crash = store.claimContinuation(second.id, 1, 'wechat', 'bound-1');
  assert.equal(crash.newClaim, true);
  assert.equal((await reopened.confirmContinuation(second.id, 1, 'wechat', 'bound-1')).state, 'unknown');
  assert.equal(sends, 2);
  assert.throws(() => reopened.dismissContinuation(second.id, 1, 'wechat', 'bound-1'),
    { code: 'version_conflict' });

  const cancelInput: WorkbenchInput = { ...input, inputId: 'input-cancel',
    dispatchText: 'Reviewed two', origin: { ...input.origin, messageId: 'wechat-message-cancel' } };
  const cancelled = await reopened.prepareContinuation(task.id, cancelInput);
  assert.throws(() => reopened.dismissContinuation(cancelled.id, 1, 'wechat', 'other-channel-session'),
    { code: 'not_found' });
  assert.equal(reopened.dismissContinuation(cancelled.id, 1, 'wechat', 'bound-1').state, 'dismissed');
  assert.throws(() => reopened.dismissContinuation(cancelled.id, 1, 'wechat', 'bound-1'),
    { code: 'version_conflict' });
  assert.equal((await reopened.prepareContinuation(task.id, cancelInput)).state, 'dismissed');
  assert.equal((await reopened.confirmContinuation(cancelled.id, 2, 'wechat', 'bound-1')).state, 'conflict');
  assert.equal((await reopened.readContinuation(cancelled.id, 'wechat', 'bound-1')).state, 'conflict');
  assert.equal(sends, 2);

  const noMode = await reopened.prepareContinuation(task.id, { ...input, inputId: 'input-no-mode',
    origin: { ...input.origin, messageId: 'wechat-message-no-mode' } });
  runtimeMode = undefined;
  await assert.rejects(reopened.confirmContinuation(noMode.id, 1, 'wechat', 'bound-1'),
    { code: 'unavailable' });
  assert.equal((await reopened.readContinuation(noMode.id, 'wechat', 'bound-1')).state, 'recorded');
  assert.equal(sends, 2);
});

test('existing 0.1.4 continuation rows gain dismissal without rebuilding the task database', async t => {
  const f = await fixture(t);
  const filename = join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite');
  const first = new SqliteWorkbenchStore(filename);
  const task = { id: 'old-task', projectId: 'old-project', origin: 't3' as const,
    provider: 'codex' as const, environmentId: 'old-env', t3ProjectId: 'old-native-project',
    threadId: 'old-thread', providerInstanceId: 'codex' };
  const input: WorkbenchInput = { inputId: 'old-input', origin: { channel: 'wechat',
    channelSessionId: 'old-session', messageId: 'old-message' },
    rawText: 'Original request', dispatchText: 'Reviewed request', createdAt: at };
  const draft = first.prepareContinuation(task, input);
  first.close();
  const oldSchema = new Database(filename);
  oldSchema.exec('DROP TABLE workbench_continuation_dismissals');
  oldSchema.close();
  const reopened = new SqliteWorkbenchStore(filename);
  t.after(() => reopened.close());
  assert.equal(reopened.getContinuation(draft.id, 'wechat', 'old-session').input.rawText, 'Original request');
  assert.equal(reopened.dismissContinuation(draft.id, 1, 'wechat', 'old-session').state, 'dismissed');
  assert.equal(reopened.getContinuation(draft.id, 'wechat', 'old-session').commandId, draft.commandId);
});
