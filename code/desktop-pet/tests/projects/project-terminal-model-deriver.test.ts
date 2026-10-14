import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectTerminalEvidence, ProjectTerminalMaterial } from '../../contracts/project-memory.js';
import type { ProjectTerminalModelCallPort } from '../../contracts/project-terminal-processing.js';
import { createProjectTerminalExtractor } from '../../projects/project-terminal-extractor.js';
import { createProjectTerminalModelDeriver } from '../../projects/project-terminal-model-deriver.js';
import { SqliteProjectMemory } from '../../projects/project-memory-sqlite.js';

const evidence: ProjectTerminalEvidence = {
  projectId: 'project-a', taskId: 'task-a', nativeTurnId: 'turn-a', terminalEventId: 'event-a',
  terminalPhase: 'completed', resultRef: 't3:local:thread-a:message:assistant-a',
  occurredAt: '2026-09-27T04:00:00.000Z', extractionVersion: 'b54-t3-terminal-v1',
};
const material = (event: ProjectTerminalEvidence = evidence): ProjectTerminalMaterial => ({
  version: '0.1.0', source: 't3_thread_detail', evidence: event,
  userMessages: [{ id: 'user-a', text: '项目验收必须经过真实 Host；请记住这个约束。' }],
  assistantMessage: { id: 'assistant-a', text: '建议先做合成测试。' },
});
const proposal = (overrides: Record<string, unknown> = {}) => ({
  stableKey: 'host-acceptance', kind: 'constraint', text: '项目验收须通过真实 Host',
  sourceMessageIds: ['user-a'], ...overrides,
});
const response = (claim: unknown = proposal()) => JSON.stringify({ outcome: 'proposals', claims: [claim] });
const model = (text: string, onCall?: (input: Parameters<ProjectTerminalModelCallPort['complete']>[0]) => void):
  ProjectTerminalModelCallPort => ({ complete: async input => { onCall?.(input); return text; } });
const extractor = (call: ProjectTerminalModelCallPort) =>
  createProjectTerminalExtractor({ readTerminalMaterial: async event => material(event) },
    createProjectTerminalModelDeriver(call));

function store(t: TestContext, call: ProjectTerminalModelCallPort) {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../artifacts/W3/project-terminal-deriver-54');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'model-deriver-'));
  const filename = join(root, 'project-memory.sqlite');
  const opened: SqliteProjectMemory[] = [];
  const open = (port: ProjectTerminalModelCallPort = call) => {
    const instance = new SqliteProjectMemory(filename, { autoProcess: false, extractor: extractor(port) });
    opened.push(instance); return instance;
  };
  t.after(async () => { for (const instance of opened) await instance.close(); rmSync(root, { recursive: true, force: true }); });
  return { open };
}

test('only exact terminal material enters model; valid proposal stays a sourced candidate', async t => {
  let calls = 0;
  const call = model(response(), input => {
    calls++;
    assert.deepEqual(input.evidence, evidence);
    assert.equal(input.userText.includes('project-a'), false);
    assert.deepEqual(JSON.parse(input.userText), {
      terminalPhase: 'completed', userMessages: material().userMessages,
      assistantMessage: material().assistantMessage,
    });
    assert.match(input.systemText, /candidate/);
  });
  const memory = store(t, call).open();
  const queued = await memory.enqueueTerminal(evidence);
  assert.equal((await memory.enqueueTerminal(evidence)).state, 'already_queued');
  assert.equal(await memory.runPending(), 1);
  assert.equal(await memory.runPending(), 0);
  assert.equal(calls, 1);
  assert.equal((await memory.getJob('project-a', queued.jobId))?.state, 'done');
  const items = await memory.list({ projectId: 'project-a', limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.status, 'candidate');
  assert.deepEqual(items[0]?.sources, [{ taskId: 'task-a', nativeTurnId: 'turn-a',
    terminalEventId: 'event-a', recordedAt: evidence.occurredAt, userInputId: 'user-a' }]);
  assert.deepEqual(await memory.recall({ projectId: 'project-a', limit: 10 }), []);
  assert.deepEqual(await memory.list({ projectId: 'project-b', limit: 10 }), []);
});

test('only an explicit no_change response completes without writing a proposal', async t => {
  const memory = store(t, model('{"outcome":"no_change"}')).open();
  const queued = await memory.enqueueTerminal(evidence);
  assert.equal(await memory.runPending(), 1);
  assert.equal((await memory.getJob('project-a', queued.jobId))?.state, 'done');
  assert.deepEqual(await memory.list({ projectId: 'project-a', limit: 10 }), []);
  const failed: ProjectTerminalEvidence = {
    projectId: evidence.projectId, taskId: evidence.taskId, nativeTurnId: evidence.nativeTurnId,
    terminalEventId: evidence.terminalEventId, terminalPhase: 'failed',
    occurredAt: evidence.occurredAt, extractionVersion: evidence.extractionVersion,
  };
  const derive = createProjectTerminalModelDeriver(model('{"outcome":"no_change"}'));
  assert.deepEqual(await derive({ version: '0.1.0', source: 't3_thread_detail',
    evidence: failed, userMessages: material().userMessages }), { outcome: 'no_change' });
});

test('terminal enqueue and duplicate acknowledgement finish before a slow model response', async t => {
  let release: ((value: string) => void) | undefined;
  let calls = 0;
  const pending = new Promise<string>(resolve => { release = resolve; });
  const memory = store(t, { complete: async () => { calls++; return pending; } }).open();
  const queued = await memory.enqueueTerminal(evidence);
  const draining = memory.runPending();
  assert.equal((await memory.enqueueTerminal(evidence)).state, 'already_queued');
  assert.equal((await memory.getJob('project-a', queued.jobId))?.state, 'running');
  assert.equal(calls, 1);
  release!(response());
  await draining;
  assert.equal((await memory.getJob('project-a', queued.jobId))?.state, 'done');
  assert.equal(calls, 1);
});

test('invalid, unbounded, forged or privilege-claiming outputs fail visibly', async t => {
  const bad = [
    '', '{"outcome":', '{"outcome":"proposals","claims":[]}',
    '{"outcome":"no_change","claims":[]}', '```json\n{"outcome":"no_change"}\n```',
    response(proposal({ sourceMessageIds: ['other-project-user'] })),
    response(proposal({ sourceMessageIds: ['user-a', 'user-a'] })),
    response(proposal({ stableKey: '../bad' })),
    response(proposal({ basis: 'explicit_user' })),
    response(proposal({ status: 'accepted' })),
    response(proposal({ text: 'x'.repeat(1001) })),
    response(proposal({ branchRef: 'x'.repeat(251) })),
    JSON.stringify({ outcome: 'proposals', claims: Array.from({ length: 21 }, (_, i) =>
      proposal({ stableKey: `key-${i}` })) }),
    ' '.repeat(32001) + '{"outcome":"no_change"}',
  ];
  for (const [index, text] of bad.entries()) {
    await t.test(`invalid response ${index}`, async child => {
      const memory = store(child, model(text)).open();
      const queued = await memory.enqueueTerminal(evidence);
      await memory.runPending();
      assert.deepEqual([(await memory.getJob('project-a', queued.jobId))?.state,
        (await memory.getJob('project-a', queued.jobId))?.errorCode], ['failed', 'extraction_failed']);
      assert.deepEqual(await memory.list({ projectId: 'project-a', limit: 10 }), []);
    });
  }
});

test('oversize terminal material is rejected before a model call', async () => {
  let calls = 0;
  const deriver = createProjectTerminalModelDeriver(model('{"outcome":"no_change"}', () => { calls++; }));
  await assert.rejects(deriver({ ...material(), userMessages: [{ id: 'user-a', text: '大'.repeat(10000) }] }));
  await assert.rejects(deriver({ ...material(), evidence: { ...evidence,
    resultRef: 't3:local:thread-a:message:someone-else' } }));
  assert.equal(calls, 0);
});

test('failed job can be explicitly retried; edits and withdrawals survive later extraction versions', async t => {
  let failing = true;
  const calls: ProjectTerminalModelCallPort = {
    complete: async () => { if (failing) throw new Error('synthetic provider failure'); return response(); },
  };
  const fixture = store(t, calls);
  const memory = fixture.open();
  const queued = await memory.enqueueTerminal(evidence);
  await memory.runPending();
  assert.equal((await memory.getJob('project-a', queued.jobId))?.state, 'failed');
  assert.deepEqual(await memory.list({ projectId: 'project-a', limit: 10 }), []);
  failing = false;
  await memory.retryJob('project-a', queued.jobId);
  await memory.runPending();
  const first = (await memory.list({ projectId: 'project-a', limit: 10 }))[0]!;
  assert.equal(first.status, 'candidate');
  const editedResult = await memory.change({ operationId: 'edit-a', type: 'edit', projectId: 'project-a',
    id: first.id, expectedVersion: first.version, text: '人工修订后的真实 Host 验收约束',
    source: { userInputId: 'user-edit', recordedAt: evidence.occurredAt } });
  assert.equal(editedResult.state, 'applied');
  const v2 = { ...evidence, extractionVersion: 'b54-t3-terminal-v2' };
  await memory.enqueueTerminal(v2);
  await memory.runPending();
  assert.equal((await memory.list({ projectId: 'project-a', limit: 10 })).length, 1);
  assert.equal((await memory.get('project-a', first.id))?.text, '人工修订后的真实 Host 验收约束');
  const edited = (await memory.get('project-a', first.id))!;
  await memory.change({ operationId: 'withdraw-a', type: 'withdraw', projectId: 'project-a',
    id: edited.id, expectedVersion: edited.version });
  const v3 = { ...evidence, extractionVersion: 'b54-t3-terminal-v3' };
  await memory.enqueueTerminal(v3);
  await memory.runPending();
  assert.equal((await memory.get('project-a', first.id))?.status, 'withdrawn');
  assert.equal((await memory.list({ projectId: 'project-a', limit: 10 })).length, 1);
});
