import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseIdleCodex } from './release-idle-codex.mjs';
function fixture() {
  const target = { environmentId: 'env', projectId: 'project', workspaceRoot: '/workspace',
    providerInstanceId: 'codex', threadId: 'thread', nativeThreadId: 'native-original' };
  const snapshot = { snapshotSequence: 10, thread: { id: target.threadId, projectId: target.projectId,
    modelSelection: { instanceId: 'codex' }, settledOverride: null, activities: [],
    session: { providerName: 'codex', providerInstanceId: 'codex', status: 'ready', activeTurnId: null },
    latestTurn: { turnId: 'turn-original', state: 'completed' } } };
  const binding = { threadId: target.threadId, nativeThreadId: target.nativeThreadId,
    provider: 'codex', providerInstanceId: 'codex' };
  const calls = []; let dispatched = false;
  const client = { async environmentDescriptor() { return { environmentId: 'env' }; },
    async shellSnapshot() { return { projects: [{ id: 'project', workspaceRoot: '/workspace' }] }; },
    async threadSnapshot() { const copy = structuredClone(snapshot);
      if (dispatched) { copy.thread.session.status = 'stopped'; copy.thread.settledOverride = 'settled'; } return copy; },
    async dispatch(command) { calls.push(command); dispatched = true; return { sequence: 11 }; },
    async readReceipt() { return { status: 'accepted', aggregateId: 'thread' }; } };
  return { target, snapshot, binding, calls, client, readBinding: async () => structuredClone(binding), wait: async () => {} };
}
test('one guarded original settle releases only the completed same thread and preserves its native binding', async () => {
  const f = fixture(), result = await releaseIdleCodex(f);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].type, 'thread.settle');
  assert.equal(f.calls[0].threadId, 'thread');
  assert.equal(result.after.thread.session.status, 'stopped'); assert.equal(result.nativeBinding.nativeThreadId, 'native-original');
  assert.equal(result.modelCalls, 0); assert.equal(result.providerTurnStarts, 0);
});
test('open approvals and async questions remain pending and prevent a handoff', async () => {
  for (const kind of ['approval.requested', 'user-input.requested']) {
    const f = fixture(); f.snapshot.thread.activities = [{ kind, payload: { requestId: 'open' } }];
    await assert.rejects(releaseIdleCodex(f), /open request/); assert.equal(f.calls.length, 0);
  }
});
test('active, unfinished, changed provider/native and other project targets never dispatch a stop', async () => {
  for (const change of [f => f.snapshot.thread.session.status = 'running',
    f => f.snapshot.thread.session.activeTurnId = 'active', f => f.snapshot.thread.latestTurn.state = 'running',
    f => f.snapshot.thread.settledOverride = 'active', f => f.binding.nativeThreadId = 'foreign',
    f => f.snapshot.thread.modelSelection.instanceId = 'dsh', f => f.target.projectId = 'other',
    f => f.target.environmentId = 'other']) {
    const f = fixture(); change(f); await assert.rejects(releaseIdleCodex(f)); assert.equal(f.calls.length, 0);
  }
});
test('unknown dispatch and rejected receipt are not retried', async () => {
  const f = fixture(); f.client.dispatch = async command => { f.calls.push(command); throw Error('network unknown'); };
  await assert.rejects(releaseIdleCodex(f)); assert.equal(f.calls.length, 1);
  const rejected = fixture(); rejected.client.readReceipt = async () => ({ status: 'rejected', aggregateId: 'thread' });
  await assert.rejects(releaseIdleCodex(rejected)); assert.equal(rejected.calls.length, 1);
});
test('a session re-engaged after settlement is never claimed as a successful handoff', async () => {
  const f = fixture(), original = f.client.threadSnapshot;
  f.client.threadSnapshot = async () => { const value = await original();
    if (f.calls.length) { value.thread.session.status = 'running'; value.thread.session.activeTurnId = 'new'; } return value; };
  await assert.rejects(releaseIdleCodex(f), /re-engaged/); assert.equal(f.calls.length, 1);
});
