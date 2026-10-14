import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectTerminalEvidence, ProjectTerminalMaterial } from '../../contracts/project-memory.js';
import { ManagementError } from '../../contracts/management.js';
import { SqliteProjectMemory } from '../../projects/project-memory-sqlite.js';
import { createProjectTerminalExtractor, type ProjectTerminalDeriver } from '../../projects/project-terminal-extractor.js';

const NOW = '2026-09-27T04:00:00.000Z';
const evidence: ProjectTerminalEvidence = {
  projectId: 'project-a', taskId: 'task-a', nativeTurnId: 'turn-a', terminalEventId: 'event-a',
  terminalPhase: 'completed', resultRef: 't3:local:thread-a:message:assistant-a',
  occurredAt: NOW, extractionVersion: 'b54-t3-terminal-v1',
};
const material = (event: ProjectTerminalEvidence = evidence): ProjectTerminalMaterial => ({
  version: '0.1.0', evidence: event, source: 't3_thread_detail',
  userMessages: [{ id: 'user-a', text: '请把这个项目的验收条件记为必须通过真实 Host。' }],
  assistantMessage: { id: 'assistant-a', text: '建议先补合成检查；构建已经通过。' },
});
const deriver: ProjectTerminalDeriver = async () => ({ outcome: 'proposals', claims: [
  { stableKey: 'user-rule', kind: 'constraint', text: '项目验收须通过真实 Host', basis: 'explicit_user',
    sourceMessageIds: ['user-a'] },
  { stableKey: 'assistant-suggestion', kind: 'open_question', text: '建议补合成检查', basis: 'model_suggestion',
    sourceMessageIds: ['assistant-a'] },
  { stableKey: 'execution-claim', kind: 'fact', text: '构建已通过', basis: 'verified_execution',
    sourceMessageIds: ['assistant-a'] },
] });
const port = (value: unknown = material()) => ({ readTerminalMaterial: async () => value as ProjectTerminalMaterial });
const error = (code: string) => (value: unknown) => value instanceof ManagementError && value.code === code;

function fixture(t: TestContext) {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../artifacts/W3/project-memory-54/tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'terminal-'));
  const filename = join(root, 'project-memory.sqlite');
  const stores: SqliteProjectMemory[] = [];
  const open = (options: ConstructorParameters<typeof SqliteProjectMemory>[1]) => {
    const store = new SqliteProjectMemory(filename, options); stores.push(store); return store;
  };
  t.after(async () => { for (const store of stores) await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { open };
}

test('exact terminal message IDs become sources; independent checks alone can accept claims', async t => {
  const seen: ProjectTerminalEvidence[] = [];
  const extractor = createProjectTerminalExtractor({
    readTerminalMaterial: async event => { seen.push(event); return material(event); },
  }, deriver);
  const store = fixture(t).open({ autoProcess: false, extractor,
    verifyUserDecision: (_event, claim) => claim.stableKey === 'user-rule',
    verifyExecution: () => false });
  const queued = await store.enqueueTerminal(evidence);
  assert.equal((await store.getJob('project-a', queued.jobId))?.state, 'queued');
  assert.equal(await store.runPending(), 1);
  assert.deepEqual(seen, [evidence]);
  assert.equal((await store.getJob('project-a', queued.jobId))?.state, 'done');
  const rows = await store.list({ projectId: 'project-a', limit: 10 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => [row.text, row.status]).sort(), [
    ['建议补合成检查', 'candidate'], ['构建已通过', 'candidate'], ['项目验收须通过真实 Host', 'accepted'],
  ].sort());
  assert.deepEqual(rows.find(row => row.text.startsWith('项目验收'))?.sources, [{
    taskId: 'task-a', nativeTurnId: 'turn-a', terminalEventId: 'event-a',
    recordedAt: NOW, userInputId: 'user-a',
  }]);
  assert.deepEqual(rows.find(row => row.text === '构建已通过')?.sources, [{
    taskId: 'task-a', nativeTurnId: 'turn-a', terminalEventId: 'event-a',
    recordedAt: NOW, artifactRef: evidence.resultRef,
  }]);
  assert.equal((await store.recall({ projectId: 'project-a', limit: 10 })).length, 1);
  assert.deepEqual(await store.list({ projectId: 'project-b', limit: 10 }), []);
  assert.equal((await store.enqueueTerminal(evidence)).state, 'already_queued');
  assert.equal(await store.runPending(), 0);
});

test('rejects partial, stale, cross-project and unbounded material before derivation', async () => {
  let calls = 0;
  const derive: ProjectTerminalDeriver = async () => { calls++; return { outcome: 'no_change' }; };
  const bad: unknown[] = [
    { ...material(), evidence: { ...evidence, projectId: 'project-b' } },
    { ...material(), evidence: { ...evidence, terminalEventId: 'old-event' } },
    { ...material(), evidence: { ...evidence, nativeTurnId: 'old-turn' } },
    { ...material(), userMessages: [] },
    { ...material(), userMessages: [{ id: 'user-a', text: '   ' }] },
    { ...material(), userMessages: [{ id: 'user-a', text: 'ok', streaming: true }] },
    { ...material(), userMessages: [{ id: 'user-a', text: 'ok' }, { id: 'user-a', text: 'duplicate' }] },
    { ...material(), assistantMessage: undefined },
    { ...material(), assistantMessage: { id: 'wrong-assistant', text: 'wrong' } },
    { ...material(), assistantMessage: { id: 'assistant-a', text: 'ok', partial: true } },
    { ...material(), source: 'untrusted_summary' },
    { ...material(), userMessages: [{ id: 'user-a', text: 'a'.repeat(240001) }] },
  ];
  for (const value of bad) {
    await assert.rejects(createProjectTerminalExtractor(port(value), derive)(evidence), error('unavailable'));
  }
  assert.equal(calls, 0);
});

test('rejects invented message IDs, empty proposal success and unsupported promotion basis', async () => {
  const invalid = [
    { outcome: 'proposals', claims: [] },
    { outcome: 'proposals', claims: [{ stableKey: 'fake', kind: 'fact', text: '假来源', basis: 'model_suggestion', sourceMessageIds: ['invented'] }] },
    { outcome: 'proposals', claims: [{ stableKey: 'user-claimed', kind: 'decision', text: '用户决定', basis: 'explicit_user', sourceMessageIds: ['assistant-a'] }] },
    { outcome: 'proposals', claims: [{ stableKey: 'result-claimed', kind: 'fact', text: '已执行', basis: 'verified_execution', sourceMessageIds: ['user-a'] }] },
    { outcome: 'proposals', claims: [{ stableKey: 'duplicate', kind: 'fact', text: '重复', basis: 'model_suggestion', sourceMessageIds: ['user-a', 'user-a'] }] },
    { outcome: 'proposals', claims: [{ stableKey: 'fake', kind: 'fact', text: '假来源', basis: 'model_suggestion', sourceMessageIds: ['user-a'], sources: [{ userInputId: 'invented' }] }] },
    { outcome: 'no_change', claims: [] },
  ];
  for (const response of invalid) {
    await assert.rejects(createProjectTerminalExtractor(port(), async () => response as never)(evidence),
      value => value instanceof ManagementError);
  }
  assert.deepEqual(await createProjectTerminalExtractor(port(), async () => ({ outcome: 'no_change' }))(evidence), []);
});

test('explicit no-change is allowed for complete failed and cancelled turns without a result', async () => {
  for (const terminalPhase of ['failed', 'cancelled'] as const) {
    const event: ProjectTerminalEvidence = {
      projectId: evidence.projectId, taskId: evidence.taskId, nativeTurnId: evidence.nativeTurnId,
      terminalEventId: evidence.terminalEventId, occurredAt: evidence.occurredAt,
      extractionVersion: evidence.extractionVersion, terminalPhase,
    };
    const turn = { ...material(event), assistantMessage: undefined };
    const extract = createProjectTerminalExtractor(port(turn), async input => {
      assert.equal(input.evidence.terminalPhase, terminalPhase);
      assert.equal(input.assistantMessage, undefined);
      assert.equal(Object.isFrozen(input.userMessages[0]), true);
      return { outcome: 'no_change' };
    });
    assert.deepEqual(await extract(event), []);
  }
});

test('failed read keeps job retryable; cold restart, withdrawal and changed stable key do not revive it', async t => {
  const f = fixture(t);
  let available = false;
  const extractor = createProjectTerminalExtractor({ readTerminalMaterial: async event => {
    if (!available) throw new Error('private provider detail must not enter the job error');
    return material(event);
  } }, deriver);
  const first = f.open({ autoProcess: false, extractor });
  const queued = await first.enqueueTerminal(evidence);
  await first.runPending();
  assert.deepEqual([ (await first.getJob('project-a', queued.jobId))?.state,
    (await first.getJob('project-a', queued.jobId))?.errorCode ], ['failed', 'extraction_failed']);
  assert.deepEqual(await first.list({ projectId: 'project-a', limit: 10 }), []);
  await first.close();
  available = true;
  const reopened = f.open({ autoProcess: false, extractor });
  await reopened.retryJob('project-a', queued.jobId);
  await reopened.runPending();
  assert.equal((await reopened.getJob('project-a', queued.jobId))?.state, 'done');
  const rows = await reopened.list({ projectId: 'project-a', limit: 10 });
  const target = rows.find(row => row.text === '构建已通过')!;
  await reopened.change({ operationId: 'withdraw-a', type: 'withdraw', projectId: 'project-a',
    id: target.id, expectedVersion: target.version });
  const changedKey = createProjectTerminalExtractor(port(material({ ...evidence, extractionVersion: 'v2' })),
    async () => ({ outcome: 'proposals', claims: [{ stableKey: 'renamed-claim', kind: 'fact', text: '构建已通过',
      basis: 'model_suggestion', sourceMessageIds: ['assistant-a'] }] }));
  const second = f.open({ autoProcess: false, extractor: changedKey });
  await second.enqueueTerminal({ ...evidence, extractionVersion: 'v2' });
  await second.runPending();
  assert.equal((await second.list({ projectId: 'project-a', limit: 10 })).length, rows.length);
  assert.equal((await second.get('project-a', target.id))?.status, 'withdrawn');
});
