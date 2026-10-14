import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { fixture } from '../management/helpers.js';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';
import { SqliteInteractionLedger } from '../../workbench/sqlite-ledger.js';
import { WorkbenchInteractionGateway } from '../../workbench/commands.js';

const at = '2026-09-27T00:00:00.000Z';
const approval = { id: 'approval-event', kind: 'approval.requested', tone: 'approval',
  summary: 'Run a command?', turnId: 'turn-1', sequence: 8, createdAt: at,
  payload: { requestId: 'approval-request', options: [
    { decision: 'accept', label: 'Allow once', warning: 'Runs a local command' },
    { decision: 'decline', label: 'Deny' },
  ] } };
const question = { id: 'question-event', kind: 'user-input.requested', tone: 'approval',
  summary: 'Choose', turnId: null, sequence: 9, createdAt: at,
  payload: { requestId: 'question-request', responseMode: 'message', questions: [
    { id: 'q-one', header: 'Choice', question: 'Which option?', multiSelect: false,
      allowCustomAnswer: false, options: [{ label: 'Visible label', value: 'native-value' }] },
    { id: 'q-two', header: 'Detail', question: 'Explain', multiSelect: false,
      allowCustomAnswer: true, options: [] },
  ] } };

test('native approval and question responses bind one exact request and cold-read resolution', async t => {
  const f = await fixture(t);
  const project: ProjectEntry = { id: 'local-project', name: 'Project', abstract: '',
    detailRef: { rootPath: f.c.projectRoot }, version: 1, updatedAt: at };
  const projects: ProjectIndexPort = { async get(value) { return value === project.id ? project : null; },
    async list() { throw Error('unexpected'); }, async save() { throw Error('unexpected'); },
    async remove() { throw Error('unexpected'); }, async close() {} };
  const activities: unknown[] = [approval, question];
  let environmentId = 'native-env', root = f.c.projectRoot, threadProject = 'native-project';
  let session: unknown = { threadId: 'native-thread', status: 'running', activeTurnId: 'turn-1' };
  const sends: unknown[] = [];
  const receipts = new Map<string, { status: 'accepted'; aggregateKind: 'thread'; aggregateId: string; resultSequence: number }>();
  let lostReply = false;
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId }; },
    async shellSnapshot() { return { snapshotSequence: 10, updatedAt: at,
      projects: [{ id: 'native-project', workspaceRoot: root }],
      threads: [{ id: 'native-thread', projectId: threadProject, modelSelection: { instanceId: 'codex' },
        latestTurn: { turnId: 'turn-1', state: 'running' }, hasPendingApprovals: true, hasPendingUserInput: true }] }; },
    async threadSnapshot() { return { thread: { id: 'native-thread', projectId: threadProject,
      modelSelection: { instanceId: 'codex' }, session, activities } }; },
    async dispatch(command) {
      sends.push(command);
      receipts.set(command.commandId, { status: 'accepted', aggregateKind: 'thread',
        aggregateId: 'native-thread', resultSequence: 11 + sends.length });
      if (lostReply) throw Error('synthetic reply lost after native acceptance');
      return { sequence: 11 + sends.length };
    },
    async readReceipt(commandId) { return receipts.get(commandId) ?? null; },
  };
  const filename = join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite');
  let store = new SqliteWorkbenchStore(filename);
  t.after(() => store.close());
  store.bindProject(project, environmentId, { id: threadProject, workspaceRoot: root }, root);
  let service = new WorkbenchService(projects, store, native, true);
  const task = await service.bindTask(project.id, threadProject, 'native-thread', 'codex');
  const listed = await service.listNativeInteractions(project.id, task.id);
  assert.equal(listed.status, 'supported');
  assert.equal(listed.interactions.length, 2);
  const pendingApproval = listed.interactions.find(value => value.kind === 'approval')!;
  const pendingQuestion = listed.interactions.find(value => value.kind === 'question')!;
  assert.equal(pendingApproval.state, 'pending');
  assert.equal(pendingApproval.version, 8);
  assert.equal(pendingApproval.kind === 'approval' && pendingApproval.choiceSource, 'provider');
  assert.equal(pendingApproval.kind === 'approval' && pendingApproval.choices[0]?.warning, 'Runs a local command');
  assert.equal(pendingQuestion.answerLifetime, 'durable');
  assert.equal(pendingQuestion.kind === 'question' && pendingQuestion.questions[0]?.options?.[0]?.id, 'native-value');

  const disabled = new WorkbenchService(projects, store, native);
  assert.equal((await disabled.respondNativeInteraction(project.id, task.id, pendingApproval.id, 8,
    { type: 'decide_approval', choiceId: 'accept' })).command.state, 'unsupported');
  assert.equal(sends.length, 0);
  await assert.rejects(service.respondNativeInteraction(project.id, task.id, pendingApproval.id, 7,
    { type: 'decide_approval', choiceId: 'accept' }), { code: 'version_conflict' });
  await assert.rejects(service.respondNativeInteraction(project.id, task.id, pendingApproval.id, 8,
    { type: 'decide_approval', choiceId: 'acceptAlways' }), { code: 'invalid_request' });
  assert.equal(sends.length, 0);
  session = { threadId: 'native-thread', status: 'running', activeTurnId: 'other-turn' };
  await assert.rejects(service.respondNativeInteraction(project.id, task.id, pendingApproval.id, 8,
    { type: 'decide_approval', choiceId: 'accept' }), { code: 'version_conflict' });
  assert.equal(sends.length, 0);
  session = { threadId: 'native-thread', status: 'running', activeTurnId: 'turn-1' };
  lostReply = true;
  const first = await service.respondNativeInteraction(project.id, task.id, pendingApproval.id, 8,
    { type: 'decide_approval', choiceId: 'accept' });
  assert.equal(first.command.state, 'accepted');
  assert.equal(first.resolution, 'pending');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], { type: 'thread.approval.respond', commandId: first.command.commandId,
    threadId: 'native-thread', requestId: 'approval-request', decision: 'accept',
    createdAt: (sends[0] as { createdAt: string }).createdAt });
  const same = await service.respondNativeInteraction(project.id, task.id, pendingApproval.id, 8,
    { type: 'decide_approval', choiceId: 'accept' });
  assert.equal(same.command.commandId, first.command.commandId);
  assert.equal(sends.length, 1);
  await assert.rejects(service.respondNativeInteraction(project.id, task.id, pendingApproval.id, 8,
    { type: 'decide_approval', choiceId: 'decline' }), { code: 'version_conflict' });
  store.close();
  store = new SqliteWorkbenchStore(filename);
  service = new WorkbenchService(projects, store, native, true);
  const bound = await service.listNativeInteractionBindings(project.id, task.id);
  assert.equal(bound.status, 'supported');
  assert.deepEqual(bound.bindings.find(value => value.interactionId === pendingApproval.id), {
    interactionId: pendingApproval.id, commandId: first.command.commandId,
    kind: 'approval', requestVersion: 8,
  });
  assert.equal((await service.readNativeInteractionCommandForTask(project.id, task.id,
    pendingApproval.id)).command.commandId, first.command.commandId);
  await assert.rejects(service.readNativeInteractionCommandForTask('other-project', task.id,
    pendingApproval.id), { code: 'not_found' });
  await assert.rejects(service.readNativeInteractionCommandForTask(project.id, 'other-task',
    pendingApproval.id), { code: 'not_found' });
  assert.equal((await service.readNativeInteractionCommand(first.command.commandId)).resolution, 'pending');
  assert.equal(sends.length, 1);
  activities.push({ id: 'approval-resolved', kind: 'approval.resolved', tone: 'info', summary: 'resolved',
    turnId: 'turn-1', sequence: 12, createdAt: at, payload: { requestId: 'approval-request' } });
  assert.equal((await service.readNativeInteractionCommand(first.command.commandId)).resolution, 'answered');
  assert.equal((await service.listNativeInteractions(project.id, task.id)).interactions.length, 1);
  assert.equal((await service.readNativeInteractionCommandForTask(project.id, task.id,
    pendingApproval.id)).resolution, 'answered');
  assert.equal((await service.listNativeInteractionBindings(project.id, task.id)).bindings.length, 1);

  lostReply = false;
  session = null;
  const answer = { type: 'answer_question' as const, answers: [
    { questionId: 'q-one', selectedOptionIds: ['native-value'] },
    { questionId: 'q-two', selectedOptionIds: [], customText: 'User explanation' },
  ] };
  await assert.rejects(service.respondNativeInteraction(project.id, task.id, pendingQuestion.id, 9,
    { type: 'answer_question', answers: [{ questionId: 'q-one', selectedOptionIds: ['Visible label'] },
      answer.answers[1]!] }), { code: 'invalid_request' });
  const answered = await service.respondNativeInteraction(project.id, task.id, pendingQuestion.id, 9, answer);
  assert.equal(answered.command.state, 'accepted');
  assert.deepEqual((sends[1] as { answers: unknown }).answers,
    { 'q-one': 'native-value', 'q-two': 'User explanation' });
  assert.equal(sends.length, 2);
  activities.push({ id: 'question-resolved', kind: 'user-input.resolved', tone: 'info', summary: 'resolved',
    turnId: null, sequence: 13, createdAt: at, payload: { requestId: 'question-request' } });
  assert.equal((await service.readNativeInteractionCommand(answered.command.commandId)).resolution, 'answered');
  assert.equal((await service.respondNativeInteraction(project.id, task.id, pendingQuestion.id, 9, answer)).resolution, 'answered');
  assert.equal(sends.length, 2);
  activities.push({ ...approval, id: 'approval-event-null-turn', turnId: null, sequence: 14,
    payload: { requestId: 'approval-request-null-turn' } });
  session = { threadId: 'native-thread', status: 'running', activeTurnId: null };
  const callbackWithoutTurn = (await service.listNativeInteractions(project.id, task.id)).interactions.find(value =>
    value.nativeRequestId === 'approval-request-null-turn')!;
  assert.equal(callbackWithoutTurn.kind === 'approval' && callbackWithoutTurn.choiceSource, 't3_default');
  assert.equal((await service.respondNativeInteraction(project.id, task.id, callbackWithoutTurn.id, 14,
    { type: 'decide_approval', choiceId: 'decline' })).command.state, 'accepted');
  assert.equal(sends.length, 3);
  environmentId = 'changed-env';
  assert.equal((await service.readNativeInteractionCommand(answered.command.commandId)).resolution, 'unknown');
  assert.equal(sends.length, 3);
  environmentId = 'native-env'; root = '/moved'; threadProject = 'elsewhere';
  assert.equal((await service.readNativeInteractionCommand(answered.command.commandId)).resolution, 'unknown');
});

test('malformed native request remains unverified and cannot be answered', async t => {
  const f = await fixture(t);
  const project: ProjectEntry = { id: 'p', name: 'P', abstract: '', detailRef: { rootPath: f.c.projectRoot },
    version: 1, updatedAt: at };
  const projects: ProjectIndexPort = { async get() { return project; }, async list() { throw Error('unexpected'); },
    async save() { throw Error('unexpected'); }, async remove() { throw Error('unexpected'); }, async close() {} };
  let sends = 0;
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: 'env' }; },
    async shellSnapshot() { return { snapshotSequence: 2, updatedAt: at,
      projects: [{ id: 'np', workspaceRoot: f.c.projectRoot }],
      threads: [{ id: 'nt', projectId: 'np', modelSelection: { instanceId: 'codex' },
        latestTurn: null, hasPendingApprovals: true, hasPendingUserInput: false }] }; },
    async threadSnapshot() { return { thread: { id: 'nt', projectId: 'np', modelSelection: { instanceId: 'codex' },
      activities: [{ ...approval, sequence: undefined }], session: null } }; },
    async dispatch() { sends++; return { sequence: 3 }; },
  };
  const store = new SqliteWorkbenchStore(join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite'));
  t.after(() => store.close());
  store.bindProject(project, 'env', { id: 'np', workspaceRoot: f.c.projectRoot }, f.c.projectRoot);
  const service = new WorkbenchService(projects, store, native, true);
  const task = await service.bindTask('p', 'np', 'nt', 'codex');
  assert.equal((await service.listNativeInteractions('p', task.id)).status, 'unverified');
  await assert.rejects(service.respondNativeInteraction('p', task.id, 'missing', 0,
    { type: 'decide_approval', choiceId: 'accept' }), { code: 'unavailable' });
  assert.equal(sends, 0);
});

test('crash after response claim cold-reads the original ID without dispatching', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const ledger = new SqliteInteractionLedger(db);
  const task = { id: 'local-task', projectId: 'local-project', provider: 'codex' as const, origin: 't3' as const,
    environmentId: 'env', t3ProjectId: 'native-project', threadId: 'native-thread', providerInstanceId: 'codex' };
  const command = { type: 'thread.approval.respond' as const, commandId: 'original-command',
    threadId: task.threadId, requestId: 'native-request', decision: 'accept' as const, createdAt: at };
  const response = { type: 'decide_approval', choiceId: 'accept' };
  const binding = { interactionId: 'interaction-one', commandId: command.commandId, task,
    kind: 'approval' as const, nativeRequestId: command.requestId, requestVersion: 8,
    answerDigest: createHash('sha256').update(JSON.stringify([response.type, response])).digest('hex'),
    state: 'claimed' as const };
  assert.equal(ledger.claim(binding), 'new');
  let sends = 0;
  const gateway = new WorkbenchInteractionGateway(ledger, { async dispatch() { sends++; throw Error('must not send'); },
    async readReceipt() { return null; } });
  assert.equal((await gateway.submit(binding, command)).state, 'unknown');
  assert.equal(sends, 0);
  assert.equal(ledger.byCommand(command.commandId)?.state, 'claimed');
  assert.equal(ledger.claim({ ...binding, answerDigest: 'changed' }), 'conflict');
});
