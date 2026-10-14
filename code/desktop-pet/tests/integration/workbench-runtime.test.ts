import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../management/helpers.js';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import type { SingleCodexContinuationAuthorization, WorkbenchTurnAuthorization } from '../../contracts/workbench-runtime.js';
import { readWorkbenchTurnAuthorization, workbenchInputDigest } from '../../app/workbench-runtime.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';

async function scenario(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t), at = new Date().toISOString();
  const project: ProjectEntry = { id: randomUUID(), name: 'Synthetic', abstract: '',
    detailRef: { rootPath: f.c.projectRoot }, version: 1, updatedAt: at };
  const environmentId = randomUUID(), nativeProject = randomUUID(), threadId = randomUUID();
  const thread = { id: threadId, projectId: nativeProject, modelSelection: { instanceId: 'codex', model: 'gpt-6-astra' },
    runtimeMode: 'approval-required', interactionMode: 'default', latestTurn: null,
    hasPendingApprovals: false, hasPendingUserInput: false };
  const projects: ProjectIndexPort = { async get(id) { return id === project.id ? project : null; },
    async list() { throw Error('unexpected'); }, async save() { throw Error('unexpected'); },
    async remove() { throw Error('unexpected'); }, async close() {} };
  const file = join(f.c.projectRoot, 'data/desktop-pet/workbench-execution.json');
  let sends = 0;
  const receipt = { status: 'accepted' as const, aggregateKind: 'thread' as const, aggregateId: threadId, resultSequence: 2 };
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId }; },
    async shellSnapshot() {
      return { snapshotSequence: 1, updatedAt: at,
        projects: [{ id: nativeProject, workspaceRoot: f.c.projectRoot }], threads: [thread] };
    },
    async threadSnapshot() { return { snapshotSequence: 1, thread: { ...thread, messages: [] } }; },
    async dispatch() { sends++; throw Error('reply lost after acceptance'); },
    async readReceipt() { return sends ? receipt : null; },
  };
  let store = new SqliteWorkbenchStore(join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite'));
  t.after(async () => { store.close(); });
  store.bindProject(project, environmentId, { id: nativeProject, workspaceRoot: f.c.projectRoot }, f.c.projectRoot);
  const service = (policy = readWorkbenchTurnAuthorization(f.c.projectRoot)) => new WorkbenchService(projects, store, native, true, undefined, undefined,
    undefined, undefined, undefined, policy);
  const task = await service().bindTask(project.id, nativeProject, threadId, 'codex');
  const draft = await service().prepareContinuation(task.id, { inputId: randomUUID(), rawText: 'Synthetic marker',
    dispatchText: 'Synthetic marker', createdAt: at, origin: { channel: 'web', channelSessionId: 'synthetic', messageId: randomUUID() } });
  const authorization: SingleCodexContinuationAuthorization = { version: 1, kind: 'single-codex-continuation',
    draftId: draft.id, draftVersion: draft.version, commandId: draft.commandId, task: draft.task,
    inputSha256: workbenchInputDigest(draft.input), modelId: 'gpt-6-astra', expiresAt: new Date(Date.now() + 60000).toISOString(),
    authType: 'chatgpt', maxTurns: 1, automaticRetries: 0 };
  const save = (value = authorization) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); save();
  return { root: f.c.projectRoot, file, draft, thread, authorization, save, service, sends: () => sends,
    reopen: () => { store.close(); store = new SqliteWorkbenchStore(join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite')); },
    confirm: (s = service()) => s.confirmContinuation(draft.id, draft.version, 'web', 'synthetic') };
}

test('one exact continuation; target/model/input drift refuses before claim, reply loss and restart never resend', async t => {
  const s = await scenario(t);
  const policy = readWorkbenchTurnAuthorization(s.root)!;
  assert.equal(policy.allows(s.draft, s.thread), true);
  assert.equal(policy.allows({ ...s.draft, input: { ...s.draft.input, rawText: 'other' } }, s.thread), false);
  assert.equal(policy.allows({ ...s.draft, commandId: randomUUID() }, s.thread), false);
  s.thread.modelSelection.model = 'other'; await assert.rejects(s.confirm(), /当前授权/);
  assert.equal(s.service().readContinuationDraft(s.draft.id, 'web', 'synthetic').state, 'open');
  s.thread.modelSelection.model = 'gpt-6-astra';
  s.save({ ...s.authorization, inputSha256: 'a'.repeat(64) }); await assert.rejects(s.confirm(), /当前授权/); s.save();
  const results = await Promise.all([s.confirm(), s.confirm()]);
  assert.ok(results.some(r => r.state === 'accepted')); assert.equal(s.sends(), 1);
  unlinkSync(s.file); s.reopen();
  assert.equal((await s.confirm()).state, 'accepted'); assert.equal(s.sends(), 1);
});

test('authorization revocation and expiry close dispatch; missing or unsafe files cannot enable it', async t => {
  const s = await scenario(t), policy = readWorkbenchTurnAuthorization(s.root)!;
  const service = s.service(); unlinkSync(s.file);
  assert.equal(policy.available(), false); assert.equal((await service.status()).dispatchEnabled, false);
  await assert.rejects(s.confirm(service), /当前授权/); assert.equal(s.sends(), 0);
  s.save({ ...s.authorization, expiresAt: '2020-01-01T00:00:00Z' }); assert.equal(readWorkbenchTurnAuthorization(s.root), undefined);
  s.save(); chmodSync(s.file, 0o644); assert.equal(readWorkbenchTurnAuthorization(s.root), undefined);
  chmodSync(s.file, 0o600); unlinkSync(s.file); symlinkSync('/tmp', s.file); assert.equal(readWorkbenchTurnAuthorization(s.root), undefined);
});

test('revocation after durable claim stays unknown and cannot be replayed', async t => {
  const s = await scenario(t);
  const policy = readWorkbenchTurnAuthorization(s.root)!;
  const firstAllows = policy.allows.bind(policy);
  let gates = 0;
  const revokeBeforeSecondGate: WorkbenchTurnAuthorization = { available: policy.available,
    allows(draft, native) { if (++gates === 2) unlinkSync(s.file); return firstAllows(draft, native); } };
  const service = s.service(revokeBeforeSecondGate);
  assert.equal((await s.confirm(service)).state, 'unknown'); assert.equal(s.sends(), 0);
  s.save(); s.reopen(); assert.equal((await s.confirm()).state, 'unknown'); assert.equal(s.sends(), 0);
});
