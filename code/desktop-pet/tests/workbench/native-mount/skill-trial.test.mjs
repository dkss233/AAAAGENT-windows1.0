import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillTrialGate } from '../../../workbench/native-mount/skill-trial-gate.mjs';
import { makeReadRpcFilter } from '../../../workbench/native-mount/policy.mjs';
const config = { mode: 'bounded-codex-skill-trial', configurationVerified: true, accountCategory: 'chatgpt', projectId: 'fixture-project', threadIds: ['ordinary', 'multi'], cwd: process.platform === 'win32' ? join(tmpdir(), 'aaaagent-codex-skill-input-54-test') : '/private/tmp/aaaagent-codex-skill-input-54-test', providerInstanceId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'low', parentTurnsMax: 2, automaticCommandIds: ['auto-1', 'auto-2'], expiresAt: '2099-01-01T00:00:00Z' };
const request = (id = 'manual-1', overrides = {}) => ({ _tag: 'Request', id, tag: 'orchestration.dispatchCommand', payload: { type: 'thread.turn.start', commandId: id, threadId: 'ordinary', modelSelection: { instanceId: 'codex', model: 'gpt-6-astra', options: { reasoningEffort: 'low' } }, message: { role: 'user', text: '$grill-me review', context: { records: [{ kind: 'skill', name: 'grill-me', path: '/skills/grill-me/SKILL.md' }] } }, ...overrides }, headers: [['authorization', 'must-not-forward']] });
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aaa-skill-gate-')), file = join(dir, 'ledger.json');
  const gate = createSkillTrialGate(config, file);
  try { fn(gate, file); } finally { gate.close(); rmSync(dir, { recursive: true, force: true }); }
}
test('only exact synthetic target/provider/model and selected Skill can reserve a turn', () => fixture(gate => {
  for (const overrides of [{ threadId: 'private-user-thread' }, { modelSelection: { instanceId: 'dsh', model: 'gpt-6-astra' } }, { modelSelection: { instanceId: 'codex', model: 'guessed' } }, { bootstrap: {} }, { providerOnlyProjectContext: {} }, { message: { role: 'user', text: 'no selection' } }]) assert.equal(gate.reserve(request('denied', overrides)).kind, 'deny');
  assert.deepEqual(gate.audit(), { automaticParentTurnsReserved: 0, manualParentTurnsReserved: 0, unresolvedReceipts: 0 });
}));
test('durable reservation precedes send, freezes content and never resends a lost reply', () => fixture((gate, file) => {
  assert.equal(gate.reserve(request()).kind, 'forward');
  assert.equal(JSON.parse(readFileSync(file)).commands['manual-1'].threadId, 'ordinary');
  assert.equal(gate.reserve(request()).kind, 'deny');
  assert.equal(gate.reserve(request('manual-1', { message: { role: 'user', text: 'changed' } })).kind, 'deny');
  assert.equal(gate.reserve(request('manual-2')).kind, 'deny');
  gate.close(); const recovered = createSkillTrialGate(config, file);
  try {
    assert.equal(recovered.reserve(request()).kind, 'deny');
    recovered.reconcile('manual-1', { commandId: 'manual-1', aggregateId: 'ordinary', status: 'accepted', resultSequence: 12 });
    assert.deepEqual(recovered.reserve(request()).response.exit, { _tag: 'Success', value: { sequence: 12 } });
    assert.equal(recovered.capability().parentTurnsRemaining, 1);
  } finally { recovered.close(); }
}));
test('automatic checks have separate count and leave both user attempts available', () => fixture(gate => {
  for (const id of ['auto-1', 'auto-2']) { assert.equal(gate.reserve(request(id)).kind, 'forward'); gate.receive(id, { _tag: 'Success', value: { sequence: 1 } }); }
  assert.equal(gate.capability().parentTurnsRemaining, 2);
  for (const id of ['manual-1', 'manual-2']) { assert.equal(gate.reserve(request(id)).kind, 'forward'); gate.receive(id, { _tag: 'Success', value: { sequence: 2 } }); }
  assert.equal(gate.capability().parentTurnsRemaining, 0);
  assert.equal(gate.reserve(request('manual-3')).kind, 'deny');
}));
test('refuses a second live ledger writer and unknown receipt reconciliation', () => fixture((gate, file) => {
  assert.throws(() => createSkillTrialGate(config, file), /live candidate/);
  assert.throws(() => gate.reconcile('unknown', {}), /known test commands/);
}));
test('mixed RPC batches do not partially reserve and browser headers are removed', () => fixture(gate => {
  const filter = makeReadRpcFilter({ skillTrialGate: gate });
  const read = { _tag: 'Request', id: 'read', tag: 'server.getConfig', payload: {}, headers: [] };
  assert.equal(filter.filter(JSON.stringify([read, request()])).forward.length, 0);
  assert.equal(gate.audit().manualParentTurnsReserved, 0);
  const result = filter.filter(JSON.stringify(request()));
  assert.equal(result.forward.length, 1); assert.deepEqual(result.forward[0].headers, []);
  filter.receive(JSON.stringify({ _tag: 'Exit', requestId: 'manual-1', exit: { _tag: 'Success', value: { sequence: 9 } } }));
  assert.equal(gate.reserve(request()).kind, 'replay');
}));
test('expired or unverified configuration never authorizes a send', () => fixture((gate, file) => {
  assert.throws(() => createSkillTrialGate({ ...config, configurationVerified: false }, file + '-invalid'));
  const expired = createSkillTrialGate(config, file + '-expired', () => Date.parse('2100-01-01'));
  try { assert.equal(expired.capability(), null); assert.equal(expired.reserve(request()).kind, 'deny'); } finally { expired.close(); }
}));
test('workspace Skill discovery permits only exact trial cwd and provider without model refresh', () => fixture(gate => {
  const request = payload => ({ _tag:'Request',id:'discover',tag:'server.refreshProviders',payload,headers:[['private','discard']] });
  for (const payload of [{},{instanceId:'codex'},{instanceId:'dsh',cwd:config.cwd},{instanceId:'codex',cwd:'/private/user-project'},
    {instanceId:'codex',cwd:config.cwd,refreshModels:true}]) {
    assert.equal(makeReadRpcFilter({skillTrialGate:gate}).filter(JSON.stringify(request(payload))).forward.length,0);
  }
  const result=makeReadRpcFilter({skillTrialGate:gate}).filter(JSON.stringify(request({instanceId:'codex',cwd:config.cwd})));
  assert.equal(result.forward.length,1);assert.deepEqual(result.forward[0].headers,[]);
  assert.equal(makeReadRpcFilter().filter(JSON.stringify(request({instanceId:'codex',cwd:config.cwd}))).forward.length,0);
  assert.equal(gate.audit().manualParentTurnsReserved,0);assert.equal(gate.audit().automaticParentTurnsReserved,0);
}));
