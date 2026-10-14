import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReadRpcFilter, makeExecutionRpcFilter } from '../../../workbench/native-mount/policy.mjs';

const request = (id, tag, payload = {}) => ({ _tag: 'Request', id, tag, payload,
  headers: [['Authorization', 'untrusted browser header']] });
const exit = (requestId, value) => JSON.stringify({ _tag: 'Exit', requestId, exit: { _tag: 'Success', value } });
const candidate = { path: '/original/selected', title: 'selected', projectId: 'existing-project',
  sources: ['codex', 'dsh'], threadCount: 2, lastActiveAt: '2025-01-01T00:00:00Z', alreadyImported: true };
const create = { type: 'project.create', commandId: 'onboarding:project:create:new-project', projectId: 'new-project',
  title: 'selected', workspaceRoot: candidate.path, createWorkspaceRootIfMissing: false,
  defaultModelSelection: null, createdAt: '2026-10-05T00:00:00Z' };
const importInput = { projectId: 'existing-project', expectedWorkspaceRoot: candidate.path };
const gate = { async reserve() { return { kind: 'deny', response: { _tag: 'Exit', exit: { _tag: 'Failure' } } }; }, receive() {} };
async function scan(filter, id = 'scan', project = candidate) {
  assert.equal((await filter.filter(JSON.stringify(request(id, 'agentSessions.scan')))).forward.length, 1);
  filter.receive(exit(id, { candidates: [project], scannedAt: '2026-10-05T00:00:00Z' }));
}

test('readonly discovery accepts original empty scan and never admits history imports or arbitrary roots', () => {
  const filter = makeReadRpcFilter();
  const found = filter.filter(JSON.stringify(request('scan', 'agentSessions.scan')));
  assert.equal(found.forward.length, 1); assert.deepEqual(found.forward[0].headers, []);
  for (const [tag, payload] of [['agentSessions.scan', { root: '/private' }],
    ['agentSessions.import', importInput], ['orchestration.dispatchCommand', create]])
    assert.equal(filter.filter(JSON.stringify(request(tag, tag, payload))).forward.length, 0);
});

test('import uses only exact original scan project IDs and paths on this authenticated channel', async () => {
  const filter = makeExecutionRpcFilter(gate);
  assert.equal((await filter.filter(JSON.stringify(request('before', 'agentSessions.import', importInput)))).forward.length, 0);
  await scan(filter);
  for (const payload of [{ ...importInput, projectId: 'other-project' }, { ...importInput, expectedWorkspaceRoot: '/other' },
    { projectId: importInput.projectId }, { ...importInput, sources: ['all'] }])
    assert.equal((await filter.filter(JSON.stringify(request('bad', 'agentSessions.import', payload)))).forward.length, 0);
  const accepted = await filter.filter(JSON.stringify(request('import', 'agentSessions.import', importInput)));
  assert.equal(accepted.forward.length, 1); assert.deepEqual(accepted.forward[0].headers, []);
  assert.deepEqual(accepted.forward[0].payload, importInput);
  assert.equal((await makeExecutionRpcFilter(gate).filter(JSON.stringify(request('separate', 'agentSessions.import', importInput)))).forward.length, 0);
});

test('selected project creation requires original success before import; mixed operations and unrelated writes stay closed', async () => {
  const filter = makeExecutionRpcFilter(gate); await scan(filter, 'scan', { ...candidate, projectId: undefined, alreadyImported: false });
  for (const payload of [{ ...create, workspaceRoot: '/unscanned' }, { ...create, createWorkspaceRootIfMissing: true },
    { ...create, defaultModelSelection: { instanceId: 'codex', model: 'unselected' } },
    { ...create, scripts: [{ command: 'touch /private' }] }, { ...create, type: 'project.delete' }])
    assert.equal((await filter.filter(JSON.stringify(request('bad', 'orchestration.dispatchCommand', payload)))).forward.length, 0);
  const selected = { ...importInput, projectId: create.projectId };
  assert.equal((await filter.filter(JSON.stringify(request('create', 'orchestration.dispatchCommand', create)))).forward.length, 1);
  assert.equal((await filter.filter(JSON.stringify(request('early', 'agentSessions.import', selected)))).forward.length, 0);
  filter.receive(JSON.stringify({ _tag: 'Exit', requestId: 'create', exit: { _tag: 'Failure' } }));
  assert.equal((await filter.filter(JSON.stringify(request('failed', 'agentSessions.import', selected)))).forward.length, 0);
  assert.equal((await filter.filter(JSON.stringify(request('retry', 'orchestration.dispatchCommand', create)))).forward.length, 1);
  filter.receive(exit('retry', { sequence: 5 }));
  assert.equal((await filter.filter(JSON.stringify(request('selected', 'agentSessions.import', selected)))).forward.length, 1);
  const mixed = await filter.filter(JSON.stringify([request('write', 'agentSessions.import', importInput), request('read', 'server.getConfig')]));
  assert.equal(mixed.forward.length, 0);
  assert.equal((await filter.filter(JSON.stringify(request('settings', 'server.updateSettings', {})))).forward.length, 0);
});
