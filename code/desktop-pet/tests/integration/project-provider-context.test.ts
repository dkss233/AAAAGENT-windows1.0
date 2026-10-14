import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectMemoryItem } from '../../contracts/project-memory.js';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import type { ProjectProviderContextBinding } from '../../contracts/project-provider-context.js';
import type { WorkbenchInput, WorkbenchTaskRef } from '../../contracts/workbench.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';
import { prepareProjectProviderContext } from '../../workbench/project-provider-context.js';
import { fixture as projectFixture } from '../management/helpers.js';

const now = '2026-09-27T00:00:00Z';
const task: WorkbenchTaskRef & { origin: 't3' } = {
  id: 'task-1', projectId: 'project-1', origin: 't3', provider: 'codex',
  environmentId: 'env-1', t3ProjectId: 'native-project-1', threadId: 'thread-1',
  providerInstanceId: 'codex',
};
const input = (messageId: string): WorkbenchInput => ({ inputId: `input-${messageId}`,
  origin: { channel: 'web', channelSessionId: 'profile-1', messageId },
  rawText: '原始语音', dispatchText: '审阅后的任务正文', createdAt: now });
const memory: ProjectMemoryItem = { id: 'memory-1', projectId: task.projectId,
  kind: 'decision', status: 'accepted', version: 2, text: '仅主分支使用新方案', branchRef: 'main',
  condition: '仅主分支', sources: [{ taskId: task.id, nativeTurnId: 'turn-1', recordedAt: now }],
  createdAt: now, updatedAt: now };
const fixture = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-context-freeze-'));
  const path = join(dir, 'workbench.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
};
async function ready(draft: { id: string; commandId: string; version: number; input: WorkbenchInput },
  item = memory) {
  const binding: ProjectProviderContextBinding = { projectId: task.projectId, taskId: task.id,
    environmentId: task.environmentId, threadId: task.threadId, providerInstanceId: task.providerInstanceId,
    modelId: 'selected-model', branchRef: 'main', snapshotSequence: 7,
    commandId: draft.commandId, draftId: draft.id, draftVersion: draft.version,
    messageId: draft.input.inputId };
  const result = await prepareProjectProviderContext({ binding,
    durableMessageText: draft.input.dispatchText, memories: [item] },
  { async verify() { return 'fits'; } }); // Controlled fixture, no production capacity.
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw Error('fixture_not_ready');
  return result;
}

test('atomic consent claim freezes exact selected memory and cold reopen reads it without recall', async t => {
  const path = fixture(t);
  let store = new SqliteWorkbenchStore(path);
  const draft = store.prepareContinuation(task, input('one'));
  const frozen = await ready(draft);
  assert.equal(store.readProviderContextFreeze(draft.commandId), null);
  assert.equal(store.claimContinuation(draft.id, draft.version, 'web', 'profile-1', frozen).newClaim, true);
  assert.deepEqual(store.readProviderContextFreeze(draft.commandId), JSON.parse(JSON.stringify(frozen)));
  assert.equal(store.claimContinuation(draft.id, draft.version, 'web', 'profile-1', frozen).newClaim, false);
  store.close();
  store = new SqliteWorkbenchStore(path);
  t.after(() => store.close());
  const recovered = store.readProviderContextFreeze(draft.commandId);
  assert.equal(recovered?.records[0]?.payload.text, memory.text);
  assert.equal(recovered?.records[0]?.payload.version, memory.version);
  assert.deepEqual(recovered?.records[0]?.payload.sources, memory.sources);
  assert.equal(recovered?.providerProjectionText, frozen.providerProjectionText);
  const changed = await ready(draft, { ...memory, version: 3, text: '已改版本' });
  assert.throws(() => store.claimContinuation(draft.id, draft.version, 'web', 'profile-1', changed),
    { code: 'version_conflict' });
  assert.equal(store.readProviderContextFreeze(draft.commandId)?.fingerprint, frozen.fingerprint);
});

test('stale, cancelled or forged supplement never claims the draft or stores memory', async t => {
  const store = new SqliteWorkbenchStore(fixture(t));
  t.after(() => store.close());
  const draft = store.prepareContinuation(task, input('two'));
  const stale = await ready(draft);
  const revised = store.reviseContinuation(draft.id, 1, 'web', 'profile-1', '用户改过的完整正文');
  assert.throws(() => store.claimContinuation(draft.id, 1, 'web', 'profile-1', stale),
    { code: 'version_conflict' });
  assert.equal(store.readProviderContextFreeze(draft.commandId), null);
  const valid = await ready(revised);
  const forged = { ...valid, records: [{ ...valid.records[0]!, payload: { ...valid.records[0]!.payload,
    text: '伪造内容' } }] };
  assert.throws(() => store.claimContinuation(draft.id, 2, 'web', 'profile-1', forged),
    { code: 'version_conflict' });
  assert.equal(store.readProviderContextFreeze(draft.commandId), null);
  assert.equal(store.dismissContinuation(draft.id, 2, 'web', 'profile-1').state, 'dismissed');
  assert.throws(() => store.claimContinuation(draft.id, 3, 'web', 'profile-1',
    { ...valid, binding: { ...valid.binding, draftVersion: 3 } }), { code: 'version_conflict' });
  assert.equal(store.readProviderContextFreeze(draft.commandId), null);
});

test('crash after frozen claim remains unknown and does not resubmit or reselect memory', async t => {
  const store = new SqliteWorkbenchStore(fixture(t));
  t.after(() => store.close());
  const draft = store.prepareContinuation(task, input('three'));
  const frozen = await ready(draft);
  store.claimContinuation(draft.id, 1, 'web', 'profile-1', frozen);
  let sends = 0;
  const native: T3WorkbenchClient = { async dispatch() { sends++; return { sequence: 1 }; },
    async readReceipt() { return null; },
    async environmentDescriptor() { throw Error('not_needed'); },
    async shellSnapshot() { throw Error('not_needed'); },
    async threadSnapshot() { throw Error('not_needed'); } };
  const service = new WorkbenchService({ async get() { throw Error('not_needed'); },
    async list() { throw Error('not_needed'); }, async save() { throw Error('not_needed'); },
    async remove() { throw Error('not_needed'); }, async close() {} }, store, native, true);
  assert.equal((await service.confirmContinuation(draft.id, 1, 'web', 'profile-1')).state, 'unknown');
  assert.equal((await service.confirmContinuation(draft.id, 1, 'web', 'profile-1')).state, 'unknown');
  assert.equal(sends, 0);
  assert.equal(store.readProviderContextFreeze(draft.commandId)?.fingerprint, frozen.fingerprint);
});

test('no configured capacity leaves ordinary native continuation unchanged and no supplement snapshot', async t => {
  const store = new SqliteWorkbenchStore(fixture(t));
  t.after(() => store.close());
  const draft = store.prepareContinuation(task, input('four'));
  // Production has no capacity adapter. Its existing confirmation path claims without memory.
  assert.equal(store.claimContinuation(draft.id, 1, 'web', 'profile-1').newClaim, true);
  assert.equal(store.readProviderContextFreeze(draft.commandId), null);
  assert.equal(store.getContinuation(draft.id, 'web', 'profile-1').input.dispatchText,
    '审阅后的任务正文');
});

test('verified local selector sends one private T3 supplement while native user message stays exact', async t => {
  const f = await projectFixture(t);
  const project: ProjectEntry = { id: task.projectId, name: 'Project', abstract: '',
    detailRef: { rootPath: f.c.projectRoot }, version: 1, updatedAt: now };
  const projects: ProjectIndexPort = { async get(id) { return id === project.id ? project : null; },
    async list() { throw Error('unexpected'); }, async save() { throw Error('unexpected'); },
    async remove() { throw Error('unexpected'); }, async close() {} };
  let sends = 0, selections = 0;
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: task.environmentId }; },
    async shellSnapshot() { return { snapshotSequence: 7, updatedAt: now,
      projects: [{ id: task.t3ProjectId, workspaceRoot: f.c.projectRoot }],
      threads: [{ id: task.threadId, projectId: task.t3ProjectId,
        modelSelection: { instanceId: task.providerInstanceId, model: 'selected-model' },
        branch: 'main', runtimeMode: 'approval-required', interactionMode: 'plan',
        latestTurn: null, hasPendingApprovals: false, hasPendingUserInput: false }] }; },
    async threadSnapshot() { return { snapshotSequence: 7, thread: { id: task.threadId,
      projectId: task.t3ProjectId, modelSelection: { instanceId: task.providerInstanceId,
        model: 'selected-model' }, branch: 'main', runtimeMode: 'approval-required',
      interactionMode: 'plan' } }; },
    async dispatch(command) {
      sends++;
      assert.equal(command.message.text, '审阅后的任务正文');
      assert.equal(command.runtimeMode, 'approval-required');
      assert.equal(command.interactionMode, 'plan');
      assert.equal((command.message as { context?: unknown }).context, undefined);
      const sidecar = command.providerOnlyProjectContext as { fingerprint: string;
        proof: { projectId: string; taskId: string; environmentId: string; mac: string };
        context: { records: readonly { payload: { text: string } }[] } };
      assert.equal(sidecar.context.records[0]?.payload.text, memory.text);
      assert.equal(sidecar.fingerprint, store.readProviderContextFreeze(command.commandId)?.fingerprint);
      assert.equal(sidecar.proof.projectId, task.projectId);
      assert.equal(sidecar.proof.taskId,
        store.readProviderContextFreeze(command.commandId)?.binding.taskId);
      assert.equal(sidecar.proof.environmentId, task.environmentId);
      assert.match(sidecar.proof.mac, /^[a-f0-9]{64}$/);
      return { sequence: 8 };
    },
  };
  const store = new SqliteWorkbenchStore(join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite'));
  t.after(() => store.close());
  store.bindProject(project, task.environmentId,
    { id: task.t3ProjectId, workspaceRoot: f.c.projectRoot }, f.c.projectRoot);
  const service = new WorkbenchService(projects, store, native, true, undefined, undefined, {
    async prepare({ binding, durableMessageText }) {
      selections++;
      return prepareProjectProviderContext({ binding, durableMessageText, memories: [memory] },
        { async verify() { return 'fits'; } });
    },
  }, {
    async signProviderContextProof(payload) {
      assert.ok(store.readProviderContextFreeze(JSON.parse(payload)[4]));
      return createHmac('sha256', Buffer.alloc(32, 0xab)).update(payload).digest('hex');
    },
  });
  const bound = await service.bindTask(task.projectId, task.t3ProjectId, task.threadId, 'codex');
  const draft = await service.prepareContinuation(bound.id, input('five'));
  assert.equal((await service.confirmContinuation(draft.id, 1, 'web', 'profile-1')).state, 'accepted');
  assert.equal((await service.confirmContinuation(draft.id, 1, 'web', 'profile-1')).state, 'accepted');
  assert.equal(sends, 1);
  assert.equal(selections, 1);
  assert.equal(store.readProviderContextFreeze(draft.commandId)?.records[0]?.payload.text, memory.text);

  const unsigned = new WorkbenchService(projects, store, native, true, undefined, undefined, {
    async prepare({ binding, durableMessageText }) {
      return prepareProjectProviderContext({ binding, durableMessageText, memories: [memory] },
        { async verify() { return 'fits'; } });
    },
  });
  const noProof = await unsigned.prepareContinuation(bound.id, input('unsigned'));
  assert.equal((await unsigned.confirmContinuation(noProof.id, 1, 'web', 'profile-1')).state, 'unknown');
  assert.equal((await unsigned.confirmContinuation(noProof.id, 1, 'web', 'profile-1')).state, 'unknown');
  assert.equal(sends, 1);
  assert.equal(store.readProviderContextFreeze(noProof.commandId)?.binding.draftId, noProof.id);
});

test('native snapshot drift after durable freeze leaves command unknown without sending', async t => {
  const f = await projectFixture(t);
  const project: ProjectEntry = { id: task.projectId, name: 'Project', abstract: '',
    detailRef: { rootPath: f.c.projectRoot }, version: 1, updatedAt: now };
  const projects: ProjectIndexPort = { async get(id) { return id === project.id ? project : null; },
    async list() { throw Error('unexpected'); }, async save() { throw Error('unexpected'); },
    async remove() { throw Error('unexpected'); }, async close() {} };
  let sends = 0, drift = false, driftKind: 'sequence' | 'mode' = 'sequence';
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: task.environmentId }; },
    async shellSnapshot() { return { snapshotSequence: drift && driftKind === 'sequence' ? 8 : 7, updatedAt: now,
      projects: [{ id: task.t3ProjectId, workspaceRoot: f.c.projectRoot }],
      threads: [{ id: task.threadId, projectId: task.t3ProjectId,
        modelSelection: { instanceId: task.providerInstanceId, model: 'selected-model' },
        branch: 'main', runtimeMode: drift && driftKind === 'mode' ? 'full-access' : 'approval-required',
        interactionMode: 'plan',
        latestTurn: null, hasPendingApprovals: false, hasPendingUserInput: false }] }; },
    async threadSnapshot() { return { snapshotSequence: 7, thread: { id: task.threadId,
      projectId: task.t3ProjectId, modelSelection: { instanceId: task.providerInstanceId,
        model: 'selected-model' }, branch: 'main', runtimeMode: 'approval-required',
      interactionMode: 'plan' } }; },
    async dispatch() { sends++; return { sequence: 9 }; },
    async readReceipt() { return null; },
  };
  const store = new SqliteWorkbenchStore(join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite'));
  t.after(() => store.close());
  store.bindProject(project, task.environmentId,
    { id: task.t3ProjectId, workspaceRoot: f.c.projectRoot }, f.c.projectRoot);
  const service = new WorkbenchService(projects, store, native, true, undefined, undefined, {
    async prepare({ binding, durableMessageText }) {
      const selected = await prepareProjectProviderContext({ binding, durableMessageText,
        memories: [memory] }, { async verify() { return 'fits'; } });
      drift = true;
      return selected;
    },
  });
  const bound = await service.bindTask(task.projectId, task.t3ProjectId, task.threadId, 'codex');
  const draft = await service.prepareContinuation(bound.id, input('drift'));
  assert.equal((await service.confirmContinuation(draft.id, 1, 'web', 'profile-1')).state, 'unknown');
  assert.equal((await service.confirmContinuation(draft.id, 1, 'web', 'profile-1')).state, 'unknown');
  assert.equal(sends, 0);
  assert.equal(store.readProviderContextFreeze(draft.commandId)?.records[0]?.payload.text, memory.text);
  drift = false;
  driftKind = 'mode';
  const changedMode = await service.prepareContinuation(bound.id, input('mode-drift'));
  assert.equal((await service.confirmContinuation(changedMode.id, 1, 'web', 'profile-1')).state, 'unknown');
  assert.equal(sends, 0);
  assert.equal(store.readProviderContextFreeze(changedMode.commandId)?.binding.draftId, changedMode.id);
});
