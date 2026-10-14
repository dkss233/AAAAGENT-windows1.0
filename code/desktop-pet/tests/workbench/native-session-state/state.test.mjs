import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSessionState } from '../../../t3-native/apps/web/src/aaaagent/native-session-state.ts';

const earlier = '2026-10-03T05:00:00.000Z', later = '2026-10-03T05:01:00.000Z';
const turn = { turnId: 'original-turn', state: 'completed', requestedAt: earlier, startedAt: earlier, completedAt: later, assistantMessageId: 'original-reply' };
export const fixture = (status = 'running', changes = {}) => ({
  id: 'original-a', environmentId: 'original-environment', projectId: 'original-project', title: '同名原对话',
  modelSelection: { instanceId: 'original-provider', model: 'original-model' },
  archivedAt: null, createdAt: earlier, updatedAt: later,
  session: { status: 'stopped', lastError: null, updatedAt: earlier }, latestTurn: turn,
  settledAt: earlier, backgroundLiveness: null, hasPendingApprovals: false, hasPendingUserInput: false,
  nativeSessionObservation: { provider: 'codex', instanceId: 'original-provider', nativeId: 'original-native-a', status, checkedAt: later, syncVersion: 'observed-v1' },
  ...changes,
});

test('native continuation survives a stopped and settled local runtime', () => {
  const input = fixture(); const before = structuredClone(input);
  assert.equal(nativeSessionState(input).status, '原生进行中');
  assert.equal(nativeSessionState(input).category, 'working');
  assert.deepEqual(input, before);
  for (const [status, expected] of [['waiting_approval', '原生待审批'], ['waiting_answer', '原生待回答']]) {
    const state = nativeSessionState(fixture(status));
    assert.equal(state.status, expected); assert.equal(state.category, 'attention');
  }
});

test('local pending work keeps precedence over independent native observations', () => {
  assert.equal(nativeSessionState(fixture('running', { hasPendingApprovals: true, hasPendingUserInput: true })).status, '待审批');
  assert.equal(nativeSessionState(fixture('running', { hasPendingUserInput: true })).status, '待回答');
  for (const status of ['running', 'starting']) {
    const state = nativeSessionState(fixture('unknown', { session: { status, lastError: null, updatedAt: earlier } }));
    assert.equal(state.status, '进行中'); assert.equal(state.category, 'working');
  }
  assert.equal(nativeSessionState(fixture('unknown', { backgroundLiveness: 'working' })).category, 'working');
});

test('native readiness separates completed, failed, interrupted and unverified turns', () => {
  for (const [state, expected, category] of [['completed', '原生空闲', 'idle'], ['error', '原生上轮异常', 'attention'], ['interrupted', '原生上轮中断', 'attention']]) {
    const output = nativeSessionState(fixture('ready', { latestTurn: { ...turn, state } }));
    assert.equal(output.status, expected); assert.equal(output.category, category);
    assert.doesNotMatch(output.nativeStatus, /已结束/);
  }
  for (const [latestTurn, note] of [[null, '尚无已同步轮次'], [{ ...turn, state: 'running', completedAt: null }, '轮次状态待核验']]) {
    const output = nativeSessionState(fixture('ready', { latestTurn }));
    assert.equal(output.status, '原生空闲'); assert.equal(output.category, 'idle'); assert.match(output.description, new RegExp(note));
  }
});

test('unreadable and absent observations do not turn old completion into native completion', () => {
  const unknown = nativeSessionState(fixture('unknown'));
  assert.equal(unknown.status, '原生待核验'); assert.equal(unknown.category, 'attention');
  assert.match(unknown.description, /已同步内容保留/);
  for (const value of [null, undefined]) {
    const output = nativeSessionState(fixture('running', { nativeSessionObservation: value }));
    assert.equal(output.nativeStatus, '原生未核验'); assert.match(output.status, /本地已结束/);
    assert.doesNotMatch(output.status, /原生已结束/);
  }
  const old = fixture('running'); old.nativeSessionObservation.checkedAt = '2000-01-01T00:00:00.000Z';
  assert.equal(nativeSessionState(old).status, '原生进行中', 'checkedAt has no implicit TTL');
});

test('local errors use turn evidence time, never the synchronization timestamp', () => {
  const failedLocal = { status: 'error', lastError: 'previous local failure', updatedAt: earlier };
  const superseded = nativeSessionState(fixture('ready', { session: failedLocal }));
  assert.equal(superseded.status, '原生空闲'); assert.match(superseded.description, /本地上次异常/);
  assert.match(superseded.description, new RegExp(earlier));
  for (const updatedAt of [later, '2026-10-03T05:02:00.000Z']) {
    assert.equal(nativeSessionState(fixture('ready', { session: { ...failedLocal, updatedAt } })).status, '本地异常');
  }
  const newerCheck = fixture('ready', { session: { ...failedLocal, updatedAt: later }, latestTurn: { ...turn, completedAt: earlier } });
  newerCheck.nativeSessionObservation.checkedAt = '2026-10-04T00:00:00.000Z';
  assert.equal(nativeSessionState(newerCheck).status, '本地异常');
  for (const latestTurn of [{ ...turn, completedAt: null, startedAt: later }, { ...turn, completedAt: null, startedAt: null, requestedAt: later }]) {
    assert.equal(nativeSessionState(fixture('ready', { session: failedLocal, latestTurn })).status, '原生空闲');
  }
  assert.equal(nativeSessionState(fixture('unknown', { session: failedLocal })).status, '本地异常');
  assert.equal(nativeSessionState(fixture('running', { session: failedLocal })).status, '原生进行中');
});

test('same-name threads and observation changes share no cached state', () => {
  const a = fixture(), b = fixture('ready', { id: 'original-b', nativeSessionObservation: { ...fixture('ready').nativeSessionObservation, nativeId: 'original-native-b' } });
  assert.equal(nativeSessionState(a).status, '原生进行中'); assert.equal(nativeSessionState(b).status, '原生空闲');
  a.nativeSessionObservation = { ...a.nativeSessionObservation, status: 'unknown', syncVersion: 'observed-v2' };
  assert.equal(nativeSessionState(a).status, '原生待核验'); assert.equal(nativeSessionState(b).status, '原生空闲');
  assert.equal(a.id, 'original-a'); assert.equal(b.id, 'original-b');
});
