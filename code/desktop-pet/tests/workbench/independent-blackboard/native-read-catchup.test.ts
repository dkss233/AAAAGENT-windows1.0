import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTaskEvent } from '../../../workbench/events.js';
import { t3ShellToTaskEvent } from '../../../workbench/t3-read.js';
import type { WorkbenchTaskEvent, WorkbenchTaskRef } from '../../../contracts/workbench.js';

const ref: WorkbenchTaskRef = { id: 'task-c', projectId: 'local-project', provider: 'codex', origin: 't3',
  environmentId: 'env', t3ProjectId: 'native-project', threadId: 'original-c', providerInstanceId: 'codex' };
function cold(sequence: number, turnId: string, state: 'running' | 'completed' = 'completed') {
  return t3ShellToTaskEvent(ref, { id: 'original-c', projectId: 'native-project', modelSelection: { instanceId: 'codex' },
    latestTurn: { turnId, state, completedAt: state === 'completed' ? '2026-10-01T16:16:00Z' : null,
      assistantMessageId: state === 'completed' ? 'result-' + turnId : null },
    hasPendingApprovals: false, hasPendingUserInput: false }, sequence, '2026-10-01T16:19:00Z');
}
test('a latest native cold read catches up when the running frame was never observed', () => {
  const old = applyTaskEvent(null, cold(115, 'previous'));
  const next = applyTaskEvent(old, cold(135, 'actual-confirmed'));
  assert.equal(next.nativeTurnId, 'actual-confirmed'); assert.equal(next.phase, 'completed');
  assert.equal(next.terminalEvent?.nativeTurnId, 'actual-confirmed');
  assert.match(next.resultRef!, /result-actual-confirmed$/);
  assert.equal(applyTaskEvent(next, cold(115, 'previous')), next);
});
test('a foreign streamed terminal cannot replace the currently named turn', () => {
  for (const state of ['running', 'completed'] as const) {
    const original = applyTaskEvent(null, cold(115, 'current', state));
    const foreign: WorkbenchTaskEvent = { ...cold(135, 'foreign'), evidence: 't3_event', nativeEventId: 'provider-event' };
    assert.equal(applyTaskEvent(original, foreign), original);
  }
});
test('same-turn terminal protection, sequence ordering and task identity remain enforced', () => {
  const original = applyTaskEvent(null, cold(135, 'actual-confirmed'));
  assert.equal(applyTaskEvent(original, cold(136, 'actual-confirmed', 'running')), original);
  assert.equal(applyTaskEvent(original, cold(134, 'previous')), original);
  const unnamed: WorkbenchTaskEvent = { eventId: 'unnamed', taskId: ref.id, sequence: 136,
    phase: 'completed', observedAt: '2026-10-01T16:19:00Z', evidence: 'native_read' };
  assert.equal(applyTaskEvent(original, unnamed), original);
  assert.throws(() => applyTaskEvent(original, { ...cold(136, 'other'), taskId: 'other-task' }), /task_identity_mismatch/);
});
