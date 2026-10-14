import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNativeHttpRead, makeReadRpcFilter } from '../../../workbench/native-mount/policy.mjs';
const request = (id, tag, payload = {}) => ({ _tag: 'Request', id, tag, payload, headers: [['authorization', 'untrusted']] });
test('mixed native batch never forwards dispatch or provider/device mutations', () => {
  const filter = makeReadRpcFilter();
  const result = filter.filter(JSON.stringify([
    request('a', 'orchestration.subscribeThread', { threadId: 'real-id' }),
    ...['orchestration.dispatchCommand', 'server.refreshProviders', 'device.list',
      'subscribeTerminalMetadata', 'pullRequests.list', 'review.getDiffPreview',
      'server.reportClientActivity'].map((tag, n) => request(n, tag)),
  ]));
  assert.equal(result.forward.length, 0);
  assert.equal(result.rejected.length, 8);
  const read = filter.filter(JSON.stringify(request('b', 'orchestration.subscribeThread', { threadId: 'real-id' }))).forward[0];
  assert.deepEqual(read.headers, []);
  assert.deepEqual(read.payload, { threadId: 'real-id' });
  for (const rejected of result.rejected) assert.equal(rejected.exit.cause[0].error._tag, 'EnvironmentAuthorizationError');
});
test('controls affect only live read IDs and completed IDs cannot be reused as controls', () => {
  const a = makeReadRpcFilter(), b = makeReadRpcFilter();
  a.filter(JSON.stringify(request(1, 'server.getConfig')));
  assert.throws(() => b.filter(JSON.stringify({ _tag: 'Interrupt', requestId: 1 })));
  assert.equal(a.filter(JSON.stringify({ _tag: 'Ack', requestId: 1 })).forward.length, 1);
  a.receive(JSON.stringify({ _tag: 'Exit', requestId: 1, exit: { _tag: 'Success', value: {} } }));
  assert.throws(() => a.filter(JSON.stringify({ _tag: 'Interrupt', requestId: 1 })));
});
test('HTTP reads are explicit; provider catalog, dispatch, auth changes and arbitrary paths remain closed', () => {
  assert.equal(isNativeHttpRead('GET', '/api/orchestration/threads/real-id/events'), true);
  for (const [method, path] of [['POST', '/api/orchestration/dispatch'], ['GET', '/api/orchestration/provider-models'],
    ['POST', '/oauth/token'], ['GET', '/api/auth/clients'], ['GET', '/api/orchestration/threads/a/unrecognized']])
    assert.equal(isNativeHttpRead(method, path), false);
});

test('native child read accepts only GET relations/full child paths', () => {
  for (const path of ['/api/orchestration/threads/parent/native-children', '/api/orchestration/threads/parent/native-children/native-child-id']) {
    assert.equal(isNativeHttpRead('GET', path), true);
    assert.equal(isNativeHttpRead('POST', path), false);
  }
  for (const path of ['/api/orchestration/native-children/child', '/api/orchestration/threads/parent/native-children/child/resume', '/api/orchestration/threads/parent/native-children/child/turn/start']) assert.equal(isNativeHttpRead('GET', path), false);
});
