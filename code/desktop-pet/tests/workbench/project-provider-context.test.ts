import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectMemoryItem } from '../../contracts/project-memory.js';
import type { ProjectProviderContextBinding, ProjectProviderContextCapacityPort } from '../../contracts/project-provider-context.js';
import { prepareProjectProviderContext } from '../../workbench/project-provider-context.js';

const binding: ProjectProviderContextBinding = {
  projectId: 'project-1', taskId: 'task-1', environmentId: 'env-1', threadId: 'thread-1',
  providerInstanceId: 'codex', modelId: 'selected-model', branchRef: 'main', snapshotSequence: 12,
  commandId: 'command-1', draftId: 'draft-1', draftVersion: 3, messageId: 'input-1',
};
const memory = (overrides: Partial<ProjectMemoryItem> = {}): ProjectMemoryItem => ({
  id: 'memory-1', projectId: 'project-1', kind: 'decision', status: 'accepted', version: 4,
  text: '仅在主分支调整遗忘曲率。', branchRef: 'main', condition: '主分支',
  sources: [{ taskId: 'task-1', nativeTurnId: 'turn-2', recordedAt: '2026-09-27T00:00:00Z' }],
  createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T01:00:00Z', ...overrides,
});
const syntheticCapacity: ProjectProviderContextCapacityPort = { async verify() { return 'fits'; } };

test('without actual provider capacity memory supplement is unavailable and no provider receives it', async () => {
  assert.deepEqual(await prepareProjectProviderContext({ binding,
    durableMessageText: '请继续工作', memories: [memory()] }),
  { status: 'unavailable', reason: 'capacity_unverified' });
  const refusing: ProjectProviderContextCapacityPort = { async verify() { return 'unavailable'; } };
  assert.deepEqual(await prepareProjectProviderContext({ binding,
    durableMessageText: '请继续工作', memories: [memory()] }, refusing),
  { status: 'unavailable', reason: 'capacity_unverified' });
});

test('provider-only copy carries exact accepted item and provenance without changing durable message or adding history', async () => {
  const durableMessageText = '请继续工作';
  const item = memory();
  let inspected = false;
  const capacity: ProjectProviderContextCapacityPort = { async verify(candidate) {
    inspected = true;
    assert.equal(candidate.durableMessageText, durableMessageText);
    assert.equal(candidate.records.length, 1);
    assert.equal(candidate.records[0]?.payload.sources[0]?.nativeTurnId, 'turn-2');
    assert.match(candidate.providerProjectionText, /^请继续工作\n\n\[项目记忆\]\(t3-context:\/\/v1\/project-memory\/[a-f0-9]{64}\)$/u);
    assert.equal(candidate.providerProjectionText.includes('最近轮次'), false);
    return 'fits'; // Controlled fixture only; no production budget adapter exists.
  } };
  const result = await prepareProjectProviderContext({ binding, durableMessageText,
    memories: [item] }, capacity);
  assert.equal(inspected, true);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(durableMessageText, '请继续工作');
  assert.equal(result.durableMessageText, durableMessageText);
  assert.deepEqual(result.records[0]?.payload, {
    status: 'accepted', projectId: 'project-1', id: 'memory-1', version: 4, kind: 'decision',
    text: '仅在主分支调整遗忘曲率。', branchRef: 'main', condition: '主分支', sources: item.sources,
  });
  assert.equal(result.records[0]?.kind, 'project-memory');
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/u);
  const same = await prepareProjectProviderContext({ binding, durableMessageText,
    memories: [item] }, syntheticCapacity);
  assert.equal(same.status, 'ready');
  if (same.status === 'ready') assert.equal(same.fingerprint, result.fingerprint);
  const revised = await prepareProjectProviderContext({ binding: { ...binding, draftVersion: 4 },
    durableMessageText, memories: [item] }, syntheticCapacity);
  assert.equal(revised.status, 'ready');
  if (revised.status === 'ready') assert.notEqual(revised.fingerprint, result.fingerprint);
});

test('candidate refuses withdrawn, superseded, cross-project, cross-branch and duplicate records before budget verification', async () => {
  let calls = 0;
  const capacity: ProjectProviderContextCapacityPort = { async verify() { calls++; return 'fits'; } };
  for (const item of [memory({ status: 'withdrawn' }), memory({ status: 'candidate' }),
    memory({ supersededById: 'memory-2' }), memory({ projectId: 'project-2' }),
    memory({ branchRef: 'other' })]) {
    assert.deepEqual(await prepareProjectProviderContext({ binding, durableMessageText: '继续',
      memories: [item] }, capacity), { status: 'unavailable', reason: 'invalid_memory' });
  }
  assert.deepEqual(await prepareProjectProviderContext({ binding, durableMessageText: '继续',
    memories: [memory(), memory()] }, capacity), { status: 'unavailable', reason: 'invalid_memory' });
  assert.equal(calls, 0);
});

test('large source payload and invalid command identity fail closed; selected source is frozen across capacity check', async () => {
  const large = memory({ sources: Array.from({ length: 2000 }, () =>
    ({ recordedAt: '2026-09-27T00:00:00Z' })) });
  assert.deepEqual(await prepareProjectProviderContext({ binding, durableMessageText: '继续',
    memories: [large] }, syntheticCapacity), { status: 'unavailable', reason: 'record_too_large' });
  assert.deepEqual(await prepareProjectProviderContext({ binding: { ...binding, commandId: '' },
    durableMessageText: '继续', memories: [memory()] }, syntheticCapacity),
  { status: 'unavailable', reason: 'invalid_binding' });
  const mutable = memory();
  const capacity: ProjectProviderContextCapacityPort = { async verify() {
    (mutable.sources as { recordedAt: string }[])[0]!.recordedAt = 'changed';
    return 'fits';
  } };
  const result = await prepareProjectProviderContext({ binding, durableMessageText: '继续',
    memories: [mutable] }, capacity);
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.records[0]?.payload.sources[0]?.recordedAt,
    '2026-09-27T00:00:00Z');
});
