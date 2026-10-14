import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { applyT3AdapterLayers, verifyT3EngineAdapter } from './prepare-t3-adapter.mjs';
import { sha256 } from './runtime.mjs';

const lock = JSON.parse(readFileSync(new URL('./t3-adapter-source.json', import.meta.url), 'utf8'));
const bundle = readFileSync(new URL('../../../../artifacts/runtime/engine-pin-54/t3-runtime/apps/server/dist/bin.mjs', import.meta.url), 'utf8');
const accepted = bundle.replace(lock.strictPolicyAfter, lock.strictPolicyBefore).replace(lock.after, lock.before);
const functionText = name => {
  const start = bundle.indexOf('function ' + name + '(');
  assert.ok(start >= 0);
  return bundle.slice(start, bundle.indexOf('\n}', start) + 2);
};

test('exact accepted bundle and two reviewed layers preserve the strict response guard', () => {
  if (lock.nativeSyncRuntime) {
    assert.equal(sha256(bundle), lock.nativeSyncRuntime.serverBundleSha256);
    assert.equal(sha256(functionText('verifyStrictOpenResponse')), lock.strictResponseGuardSha256);
    assert.equal(verifyT3EngineAdapter(new URL('../../../../artifacts/runtime/engine-pin-54/t3-runtime', import.meta.url).pathname).inventorySha256,
      lock.nativeSyncRuntime.inventorySha256);
    assert.throws(() => applyT3AdapterLayers(bundle), /input changed/);
    return;
  }
  assert.equal(sha256(accepted), lock.originalBundleSha256);
  assert.equal(applyT3AdapterLayers(accepted), bundle);
  assert.throws(() => applyT3AdapterLayers(accepted + '\n'), /input changed/);
  assert.throws(() => applyT3AdapterLayers(accepted, { ...lock, strictPolicyAfter: lock.strictPolicyAfter + '\nfunction verifyStrictOpenResponse(' }), /guard changed/);
});

test('compiled strict request selects untrusted and rejects each weaker open response', () => {
  const api = runInNewContext(functionText('runtimeModeToThreadConfig') + '\n' + functionText('buildThreadStartParams') + '\n' + functionText('verifyStrictOpenResponse') + '\n({runtimeModeToThreadConfig,buildThreadStartParams,verifyStrictOpenResponse})', {
    succeed$3: value => ({ ok: true, value }), fail$3: error => ({ ok: false, error }),
    CodexAppServerRequestError: { invalidParams: (message, unused, detail) => ({ message, detail }) },
  });
  const request = api.buildThreadStartParams({ cwd: '/owned', runtimeMode: 'approval-required' });
  assert.deepEqual(JSON.parse(JSON.stringify(request)), { cwd: '/owned', approvalPolicy: 'untrusted', sandbox: 'read-only', approvalsReviewer: 'user' });
  const strict = { cwd: '/owned', approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } };
  for (const method of ['thread/start', 'thread/resume']) {
    assert.equal(api.verifyStrictOpenResponse(strict, 'approval-required', '/owned', method).ok, true);
    for (const override of [
      { approvalPolicy: 'on-request' }, { approvalPolicy: 'never' }, { approvalPolicy: undefined },
      { approvalsReviewer: 'auto_review' }, { cwd: '/foreign' },
      { sandbox: { type: 'workspaceWrite' } }, { sandbox: { type: 'readOnly', networkAccess: true } },
    ]) assert.equal(api.verifyStrictOpenResponse({ ...strict, ...override }, 'approval-required', '/owned', method).ok, false);
  }
});
