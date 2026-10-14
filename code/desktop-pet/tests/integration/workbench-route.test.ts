import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fixture } from '../management/helpers.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';

const at = '2026-09-27T00:00:00.000Z';

test('authenticated workbench route opens only a verified exact native task and never navigates to source text', async t => {
  const f = await fixture(t);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const project: ProjectEntry = { id: 'local-a', name: 'A', abstract: '',
    detailRef: { rootPath: '/workspace/a' }, version: 1, updatedAt: at };
  const projects: ProjectIndexPort = { async get(id) { return id === project.id ? project : null; },
    async list() { throw Error('unexpected'); }, async save() { throw Error('unexpected'); },
    async remove() { throw Error('unexpected'); }, async close() {} };
  const memory: ManagementMemoryPort = { characters: () => [], list() { throw Error('unexpected'); },
    edit() { throw Error('unexpected'); }, context() { throw Error('unexpected'); },
    prompt() { throw Error('unexpected'); }, savePrompt() { throw Error('unexpected'); } };
  const store = new SqliteWorkbenchStore(join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite'));
  t.after(() => store.close());
  let environmentId = 'native-env';
  let nativeProjectId = 'native-project';
  let workspaceRoot = '/workspace/a';
  let sends = 0;
  let approvalPending = false, approvalResolved = false, approvalSends = 0;
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId }; },
    async shellSnapshot() { return { snapshotSequence: 7, updatedAt: at,
      projects: [{ id: 'native-project', workspaceRoot }],
      threads: [{ id: 'native-thread', projectId: nativeProjectId, modelSelection: { instanceId: 'codex' },
        runtimeMode: 'approval-required', interactionMode: 'default',
        latestTurn: null, hasPendingApprovals: approvalPending && !approvalResolved,
        hasPendingUserInput: false }] }; },
    async threadSnapshot() { return { thread: { id: 'native-thread', projectId: nativeProjectId,
      modelSelection: { instanceId: 'codex' }, runtimeMode: 'approval-required', interactionMode: 'default',
      messages: [{ id: 'message-one', text: 'reviewable result' }],
      session: approvalPending ? { threadId: 'native-thread', status: 'running', activeTurnId: null } : null,
      activities: approvalPending ? [{ id: 'native-approval', kind: 'approval.requested', tone: 'approval',
        summary: 'Allow a synthetic action?', turnId: null, sequence: 8, createdAt: at,
        payload: { requestId: 'native-approval-request', options: [{ decision: 'decline', label: 'Deny' }] } },
      ...(approvalResolved ? [{ id: 'native-approval-resolved', kind: 'approval.resolved', tone: 'info',
        summary: 'Resolved', turnId: null, sequence: 9, createdAt: at,
        payload: { requestId: 'native-approval-request' } }] : [])] : undefined } }; },
    async dispatch(command) {
      if ((command as { type: string }).type === 'thread.approval.respond') {
        approvalSends++; return { sequence: 9 };
      }
      sends++; throw Error('synthetic reply lost after send');
    },
    async readReceipt() { return null; },
  };
  const workbench = new WorkbenchService(projects, store, native);
  const serverOptions = { uiRoot: resolve(import.meta.dirname, '../../../management/ui'),
    settings, memory, projects, workbench,
    snapshot: () => ({ apiVersion: 1 as const, runtime: runtime.identity(), modules: [], events: [],
      settings: settings.snapshot(), adapters: [], credentials: [], characters: [] }) };
  const server = await startManagementServer(serverOptions);
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${server.token}`, Origin: server.origin, 'Content-Type': 'application/json' };
  const post = (path: string, value: unknown, override = headers) => fetch(server.origin + path,
    { method: 'POST', headers: override, body: JSON.stringify(value) });
  const get = (path: string) => fetch(server.origin + path, { headers });
  assert.equal((await fetch(server.origin + '/api/workbench/status')).status, 401);
  assert.deepEqual(await (await get('/api/workbench/status')).json(), {
    version: '0.1.1', readAvailable: true, dispatchEnabled: false,
    sourceOpening: 'verified_same_origin_task_detail', preciseTurnJump: false });
  assert.equal((await post('/api/workbench/project-bindings', { projectId: 'local-a', t3ProjectId: 'native-project',
    workspaceRoot: '/workspace/a' }, { ...headers, Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await post('/api/workbench/project-bindings', { projectId: 'local-a', t3ProjectId: 'native-project',
    workspaceRoot: '/wrong' })).status, 400);
  assert.equal((await post('/api/workbench/project-bindings', { projectId: 'local-a', t3ProjectId: 'native-project',
    workspaceRoot: '/workspace/a' })).status, 200);
  const response = await post('/api/workbench/tasks', { projectId: 'local-a', t3ProjectId: 'native-project',
    threadId: 'native-thread', provider: 'codex' });
  assert.equal(response.status, 200);
  const task = await response.json() as { id: string; projectId: string; t3ProjectId: string };
  assert.equal(task.projectId, 'local-a'); assert.equal(task.t3ProjectId, 'native-project');
  const same = await (await post('/api/workbench/tasks', { projectId: 'local-a', t3ProjectId: 'native-project',
    threadId: 'native-thread', provider: 'codex' })).json() as { id: string };
  assert.equal(same.id, task.id);
  const focusPath = '/api/workbench/focus?projectId=local-a';
  const freshFocus = await get(focusPath);
  assert.equal(freshFocus.status, 200);
  const cookieHeader = freshFocus.headers.get('set-cookie');
  assert.match(cookieHeader ?? '', /HttpOnly; SameSite=Strict; Path=\/api\/workbench;/);
  const browserCookie = cookieHeader!.split(';')[0]!;
  assert.deepEqual(await freshFocus.json(), { version: '0.1.0', projectId: 'local-a', revision: 0, task: null });
  assert.equal((await post('/api/workbench/focus', { projectId: 'local-a', taskId: task.id,
    expectedRevision: 0 })).status, 409);
  const focusHeaders = { ...headers, Cookie: browserCookie };
  const selectedFocus = await post('/api/workbench/focus', { projectId: 'local-a', taskId: task.id,
    expectedRevision: 0 }, focusHeaders);
  assert.equal(selectedFocus.status, 200);
  assert.deepEqual(await selectedFocus.json(), { version: '0.1.0', projectId: 'local-a', revision: 1,
    task: { id: task.id, projectId: 'local-a', origin: 't3', provider: 'codex', environmentId: 'native-env',
      t3ProjectId: 'native-project', threadId: 'native-thread', providerInstanceId: 'codex' } });
  assert.equal((await post('/api/workbench/focus', { projectId: 'local-a', taskId: null,
    expectedRevision: 0 }, focusHeaders)).status, 409);
  const otherBrowser = await get(focusPath);
  assert.equal((await otherBrowser.json() as { task: unknown }).task, null);
  assert.notEqual(otherBrowser.headers.get('set-cookie')?.split(';')[0], browserCookie);
  const secondPort = await startManagementServer(serverOptions);
  t.after(() => secondPort.close());
  assert.notEqual(secondPort.origin, server.origin);
  const crossPortFocus = await fetch(secondPort.origin + focusPath, { headers: {
    Authorization: `Bearer ${secondPort.token}`, Cookie: browserCookie } });
  assert.equal(crossPortFocus.status, 200);
  assert.equal((await crossPortFocus.json() as { task: { id: string } }).task.id, task.id);
  const proposed = { projectId: 'local-a', taskId: task.id, expectedFocusRevision: 1,
    messageId: 'web-message-1', rawText: 'Original web wording', dispatchText: 'Reviewed web wording' };
  assert.equal((await post('/api/workbench/continuation/prepare', proposed)).status, 409);
  assert.equal((await post('/api/workbench/continuation/prepare', { ...proposed, expectedFocusRevision: 0 },
    focusHeaders)).status, 409);
  const prepared = await (await post('/api/workbench/continuation/prepare', proposed, focusHeaders)).json() as
    { id: string; version: number; state: string; input: { rawText: string; origin: { channelSessionId: string } } };
  assert.equal(prepared.version, 1);
  assert.equal(prepared.state, 'open');
  assert.equal(prepared.input.rawText, proposed.rawText);
  assert.notEqual(prepared.input.origin.channelSessionId, 'web-one');
  assert.equal((await (await post('/api/workbench/continuation/prepare', proposed, focusHeaders)).json() as
    { id: string }).id, prepared.id);
  const listPath = '/api/workbench/continuations?projectId=local-a';
  const listed = await (await fetch(secondPort.origin + listPath, { headers: {
    Authorization: `Bearer ${secondPort.token}`, Cookie: browserCookie } })).json() as
    { version: string; projectId: string; taskId: string; focusRevision: number;
      drafts: { id: string; input: { rawText: string } }[]; truncated: boolean };
  assert.equal(listed.version, '0.1.0');
  assert.equal(listed.projectId, 'local-a');
  assert.equal(listed.taskId, task.id);
  assert.equal(listed.focusRevision, 1);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.drafts.map(row => row.id), [prepared.id]);
  assert.equal(listed.drafts[0]?.input.rawText, proposed.rawText);
  assert.equal((await post('/api/workbench/continuation/prepare', { ...proposed, rawText: 'Changed original' },
    focusHeaders)).status, 409);
  const readPath = `/api/workbench/continuation?draftId=${prepared.id}`;
  const draftPath = `/api/workbench/continuation/draft?draftId=${prepared.id}`;
  const otherCookie = otherBrowser.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await fetch(server.origin + readPath, { headers: { ...headers, Cookie: otherCookie } })).status, 404);
  assert.equal((await fetch(server.origin + draftPath, { headers: { ...headers, Cookie: otherCookie } })).status, 404);
  assert.deepEqual((await (await fetch(server.origin + listPath, { headers: { ...headers, Cookie: otherCookie } }))
    .json() as { drafts: unknown[] }).drafts, []);
  assert.equal((await fetch(server.origin + readPath, { headers: { ...headers, Cookie: browserCookie } })).status, 200);
  const coldDraft = await (await fetch(secondPort.origin + draftPath, { headers: {
    Authorization: `Bearer ${secondPort.token}`, Cookie: browserCookie } })).json() as
    { id: string; version: number; input: { rawText: string; dispatchText: string } };
  assert.equal(coldDraft.id, prepared.id);
  assert.equal(coldDraft.version, 1);
  assert.equal(coldDraft.input.rawText, proposed.rawText);
  assert.equal(coldDraft.input.dispatchText, proposed.dispatchText);
  const revised = await (await post('/api/workbench/continuation/revise', { draftId: prepared.id,
    expectedVersion: 1, dispatchText: 'Edited web wording' }, focusHeaders)).json() as
    { version: number; input: { rawText: string; dispatchText: string } };
  assert.equal(revised.version, 2);
  assert.equal(revised.input.rawText, proposed.rawText);
  assert.equal(revised.input.dispatchText, 'Edited web wording');
  assert.equal((await post('/api/workbench/continuation/confirm', { draftId: prepared.id,
    expectedVersion: 1 }, focusHeaders)).status, 409);
  assert.equal((await (await post('/api/workbench/continuation/confirm', { draftId: prepared.id,
    expectedVersion: 2 }, focusHeaders)).json() as { state: string }).state, 'unsupported');
  assert.equal(sends, 0);
  const dismissed = await (await post('/api/workbench/continuation/dismiss', { draftId: prepared.id,
    expectedVersion: 2 }, focusHeaders)).json() as { version: number; state: string };
  assert.equal(dismissed.state, 'dismissed');
  assert.equal(dismissed.version, 3);
  assert.deepEqual((await (await fetch(server.origin + listPath, { headers: focusHeaders })).json() as
    { drafts: unknown[] }).drafts, []);
  assert.equal((await (await fetch(server.origin + readPath, { headers: { ...headers, Cookie: browserCookie } }))
    .json() as { state: string }).state, 'conflict');
  assert.equal((await post('/api/workbench/continuation/confirm', { draftId: prepared.id,
    expectedVersion: 3 }, focusHeaders).then(response => response.json()) as { state: string }).state, 'conflict');
  assert.equal(sends, 0);
  const enabled = await startManagementServer({ ...serverOptions,
    workbench: new WorkbenchService(projects, store, native, true) });
  t.after(() => enabled.close());
  const enabledHeaders = { ...focusHeaders, Authorization: `Bearer ${enabled.token}`, Origin: enabled.origin };
  const enabledPost = (path: string, value: unknown) => fetch(enabled.origin + path,
    { method: 'POST', headers: enabledHeaders, body: JSON.stringify(value) });
  const nextDraft = await (await enabledPost('/api/workbench/continuation/prepare',
    { ...proposed, messageId: 'web-message-2' })).json() as { id: string; version: number };
  assert.equal(nextDraft.version, 1);
  const firstReceipt = await (await enabledPost('/api/workbench/continuation/confirm',
    { draftId: nextDraft.id, expectedVersion: 1 })).json() as { state: string; commandId: string };
  assert.equal(firstReceipt.state, 'unknown');
  assert.equal(sends, 1);
  const repeatedReceipt = await (await enabledPost('/api/workbench/continuation/confirm',
    { draftId: nextDraft.id, expectedVersion: 1 })).json() as { state: string; commandId: string };
  assert.deepEqual(repeatedReceipt, firstReceipt);
  assert.equal(sends, 1);
  assert.equal((await (await fetch(enabled.origin + `/api/workbench/continuation?draftId=${nextDraft.id}`,
    { headers: enabledHeaders })).json() as { state: string }).state, 'unknown');
  assert.equal((await enabledPost('/api/workbench/continuation/dismiss',
    { draftId: nextDraft.id, expectedVersion: 1 })).status, 409);
  const source = await (await get(`/api/workbench/source?projectId=local-a&taskId=${task.id}&nativeTurnId=turn-1&artifactRef=${encodeURIComponent('https://evil.invalid/a')}`)).json() as
    { detailApi: string; sourceIds: { artifactRef: string }; preciseTurnJump: boolean };
  assert.equal(source.detailApi, `/api/workbench/task-detail?projectId=local-a&taskId=${task.id}`);
  assert.equal(source.sourceIds.artifactRef, 'https://evil.invalid/a');
  assert.equal(source.preciseTurnJump, false);
  assert.equal((await get(`/api/workbench/source?projectId=other&taskId=${task.id}`)).status, 404);
  const detail = await (await get(source.detailApi)).json() as { native: { thread: { id: string } } };
  assert.equal(detail.native.thread.id, 'native-thread');
  assert.equal((await (await get(`/api/workbench/interactions?projectId=local-a&taskId=${task.id}`))
    .json() as { status: string }).status, 'unverified');
  assert.equal((await (await post('/api/workbench/interactions/respond', { projectId: 'local-a', taskId: task.id,
    interactionId: 'unverified-request', expectedVersion: 0,
    response: { type: 'decide_approval', choiceId: 'accept' } })).json() as
    { command: { state: string } }).command.state, 'unsupported');
  assert.equal((await get('/api/workbench/interactions/commands?commandId=missing')).status, 404);
  assert.equal((await post('/api/workbench/interactions/respond', { projectId: 'local-a', taskId: task.id,
    interactionId: 'unverified-request', expectedVersion: 0,
    response: { type: 'answer_question', answers: [{ questionId: 'one', selectedOptionIds: ['yes'],
      customText: 'forged', extra: true }] } })).status, 400);
  approvalPending = true;
  const pending = await (await fetch(enabled.origin +
    `/api/workbench/interactions?projectId=local-a&taskId=${task.id}`, { headers: enabledHeaders }))
    .json() as { interactions: { id: string; version: number }[] };
  assert.equal(pending.interactions.length, 1);
  const interactionId = pending.interactions[0]!.id;
  // The server processes this POST, but the browser loses its body and therefore never learns commandId.
  assert.equal((await enabledPost('/api/workbench/interactions/respond', {
    projectId: 'local-a', taskId: task.id, interactionId, expectedVersion: 8,
    response: { type: 'decide_approval', choiceId: 'decline' },
  })).status, 200);
  assert.equal(approvalSends, 1);
  const coldStore = new SqliteWorkbenchStore(join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite'));
  t.after(() => coldStore.close());
  const coldPort = await startManagementServer({ ...serverOptions,
    workbench: new WorkbenchService(projects, coldStore, native, true) });
  t.after(() => coldPort.close());
  const coldHeaders = { Authorization: `Bearer ${coldPort.token}` };
  const bindingPath = `/api/workbench/interactions/bindings?projectId=local-a&taskId=${task.id}`;
  const bound = await (await fetch(coldPort.origin + bindingPath, { headers: coldHeaders })).json() as
    { bindings: { interactionId: string; commandId: string; requestVersion: number }[] };
  assert.equal(bound.bindings.length, 1);
  assert.equal(bound.bindings[0]?.interactionId, interactionId);
  assert.equal(bound.bindings[0]?.requestVersion, 8);
  assert.equal(JSON.stringify(bound).includes('decline'), false);
  assert.equal((await fetch(coldPort.origin + bindingPath.replace('projectId=local-a', 'projectId=other'),
    { headers: coldHeaders })).status, 404);
  const exactPath = `/api/workbench/interactions/commands?projectId=local-a&taskId=${task.id}&interactionId=${interactionId}`;
  const recovered = await (await fetch(coldPort.origin + exactPath, { headers: coldHeaders })).json() as
    { command: { commandId: string; state: string }; resolution: string };
  assert.equal(recovered.command.commandId, bound.bindings[0]?.commandId);
  assert.equal(recovered.command.state, 'accepted');
  assert.equal(recovered.resolution, 'pending');
  assert.equal((await fetch(coldPort.origin + exactPath.replace('projectId=local-a', 'projectId=other'),
    { headers: coldHeaders })).status, 404);
  approvalResolved = true;
  assert.equal((await (await fetch(coldPort.origin + exactPath, { headers: coldHeaders })).json() as
    { resolution: string }).resolution, 'answered');
  assert.equal(approvalSends, 1);
  const refreshed = await (await post('/api/workbench/tasks/refresh', { taskId: task.id })).json() as
    { projection: { phase: string } };
  assert.equal(refreshed.projection.phase, 'accepted');
  const command = { commandId: 'would-cost', taskId: task.id, input: { inputId: 'input-one',
    origin: { channel: 'web', channelSessionId: 'web-one', messageId: 'message-one' },
    rawText: 'Original\nline', dispatchText: 'Reviewed\nline', createdAt: at } };
  assert.equal((await (await post('/api/workbench/commands/continue', command)).json() as { state: string }).state,
    'unsupported');
  assert.equal(sends, 1);
  workspaceRoot = '/relocated/workspace';
  assert.equal((await get(source.detailApi)).status, 409);
  workspaceRoot = '/workspace/a';
  nativeProjectId = 'different-project';
  assert.equal((await get(source.detailApi)).status, 409);
  environmentId = 'different-environment';
  assert.equal((await post('/api/workbench/tasks/refresh', { taskId: task.id })).status, 409);
  const invalidFocus = await fetch(server.origin + focusPath, { headers: focusHeaders });
  assert.deepEqual(await invalidFocus.json(), { version: '0.1.0', projectId: 'local-a', revision: 2, task: null });
});
