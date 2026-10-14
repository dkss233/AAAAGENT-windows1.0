import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDshNativeHistory, decodeDshNativeHistory } from './dsh-native-history.mjs';

const scope = { sessionId: 't3_exact', cwd: '/project/exact', preset: 'desktop-pet-work-v1' };
function fixture() {
  const event = (type, data, seq) => ({ type, data, seq, time: 1700000000000 + seq });
  const human = (n, seq) => event('user/message', { role: 'user', id: `user-${n}`,
    source: { kind: 'user', rpcId: `request-${n}` }, content: [{ type: 'text', text: `input-${n}` }] }, seq);
  const assistant = (n, seq) => event('assistant/message', { turn: n, message: { role: 'assistant',
    id: `answer-${n}`, content: [{ type: 'reasoning', text: 'private-reasoning' },
      { type: 'text', text: `reply-${n}` }] } }, seq);
  return { ...scope, version: '0.1.0', running: false, throughSeq: 10, events: [
    event('permission/preset', {}, 0),
    event('session/created', {}, 1), event('turn/start', { turn: 1 }, 2), human(1, 3),
    event('user/message', { role: 'user', id: 'hidden', source: { kind: 'runtime-context' },
      content: [{ type: 'text', text: 'private-context' }] }, 4), assistant(1, 5),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
    event('turn/start', { turn: 2 }, 7), human(2, 8), assistant(2, 9),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 10),
  ] };
}
function rpcFor(history, alter = () => {}) {
  const calls = [], listed = { items: [{ sessionId: scope.sessionId, cwd: scope.cwd, running: history.running,
    projections: { asOfSeq: history.throughSeq, values: { agentPreset: scope.preset } } }] };
  alter(listed);
  return { calls, async call(method, args) {
    calls.push({ method, args });
    assert.ok(['session/list', 'session/page'].includes(method), 'No native write/model method');
    if (method === 'session/list') return listed;
    assert.deepEqual(args.request.address, { kind: 'session', sessionId: scope.sessionId });
    assert.equal(args.request.throughSeq, history.throughSeq);
    const end = args.request.beforeSeq ?? history.throughSeq + 1;
    const events = history.events.filter(e => e.seq < end).slice(-4);
    return { records: events.map(event => ({ type: 'event', event })), hasMore: events[0]?.seq > 0 };
  } };
}

test('exact original session reads backwards across pages and presents two native turns without hidden content', async () => {
  const original = fixture(), rpc = rpcFor(original), history = await readDshNativeHistory(rpc, scope);
  const dto = decodeDshNativeHistory(history);
  assert.deepEqual(dto.rows.map(row => [row.role, row.text, row.nativeTurn]),
    [['user', 'input-1', 1], ['assistant', 'reply-1', 1], ['user', 'input-2', 2], ['assistant', 'reply-2', 2]]);
  assert.deepEqual(dto.turns.map(t => [t.nativeTurn, t.state]), [[1, 'completed'], [2, 'completed']]);
  assert.equal(dto.nativeSessionId, scope.sessionId); assert.equal(dto.throughSeq, 10);
  assert.equal(dto.status, 'ready'); assert.equal(dto.readonly, true);
  assert.ok(!JSON.stringify(dto).includes('private-')); assert.equal(rpc.calls.length, 4);
  assert.equal(new Set(dto.rows.map(row => row.id)).size, 4);
  assert.deepEqual(dto.rows.map(row => row.id), decodeDshNativeHistory(history).rows.map(row => row.id));
});

test('changed session, workspace, preset and child identity fail before a page read', async t => {
  for (const change of [x => x.items[0].sessionId = 't3_other', x => x.items.push({ ...x.items[0] }),
    x => x.items[0].cwd = '/other', x => x.items[0].projections.values.agentPreset = 'other',
    x => x.items[0].parentSessionId = 'parent', x => x.items[0].origin = 'subagent']) {
    await t.test(String(change), async () => {
      const rpc = rpcFor(fixture(), change); await assert.rejects(readDshNativeHistory(rpc, scope));
      assert.equal(rpc.calls.length, 1);
    });
  }
});

test('missing beginning, noncontiguous pages and repeating pages never become a complete history', async t => {
  for (const records of [[3, 4], [0, 3], [0, 0], [0, 11]]) {
    await t.test(records.join(','), async () => {
      const history = fixture(), rpc = rpcFor(history), old = rpc.call.bind(rpc);
      rpc.call = async (method, args) => method === 'session/list' ? old(method, args) :
        { records: records.map(seq => ({ type: 'event', event: { seq } })), hasMore: false };
      await assert.rejects(readDshNativeHistory(rpc, scope));
    });
  }
});

test('completion from another turn, duplicate native messages and stale running flag are rejected', () => {
  for (const change of [h => h.events[10].data.turn = 1, h => h.events[9].data.message.id = 'answer-1',
    h => h.events[8].data.source.rpcId = 'request-1', h => h.running = true,
    h => h.events.splice(3, 1), h => h.events[2].data.turn = 0]) {
    const history = fixture(); change(history); assert.throws(() => decodeDshNativeHistory(history));
  }
});

test('unfinished and unknown native lifecycles remain distinct from completed', () => {
  const running = fixture(); running.events.pop(); running.throughSeq = 9; running.running = true;
  const dto = decodeDshNativeHistory(running); assert.equal(dto.status, 'running');
  assert.equal(dto.turns[1].state, 'running'); assert.equal(dto.turns[1].completedAt, null);
  const unknown = fixture(); unknown.events[10].data.reason.kind = 'new-terminal-reason';
  assert.equal(decodeDshNativeHistory(unknown).turns[1].state, 'unknown');
});

test('unsupported visible content and excessive text are not silently omitted', () => {
  const image = fixture(); image.events[8].data.content = [{ type: 'image', url: 'private' }];
  assert.throws(() => decodeDshNativeHistory(image), /requires original session/);
  const large = fixture(); large.events[8].data.content[0].text = 'a'.repeat(256 * 1024);
  assert.throws(() => decodeDshNativeHistory(large), /exceeds bound/);
});
