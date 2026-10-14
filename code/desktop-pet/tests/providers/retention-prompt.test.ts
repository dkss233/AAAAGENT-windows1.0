import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemorySource, MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { QwenMemoryTurnProvider } from '../../providers/qwen-memory-lifecycle.js';
import { ProviderTransport } from '../../providers/transport.js';
import { memoryTurnPlanExamples } from '../../providers/memory-turn-examples.js';
import { lifecycleLiveV2 } from './fixtures/lifecycle-live-v2.js';

const scope = lifecycleLiveV2.scope;
const currentWire = JSON.parse(lifecycleLiveV2.inputMessages[1].content).currentMessage;
function input(currentText: string, oldText?: string, withMemory = false): MemoryTurnInput {
  const source = (id: string, text: string, patch: Partial<MemorySource> = {}): MemorySource => ({ scope, id, text, version: 1, kind: 'transcript', messageRole: 'user', createdAt: currentWire.createdAt, sourceVersions: [], evidenceEligible: true, ...patch });
  const sources = [source(`${scope.turnId}:user`, currentText)];
  if (oldText !== undefined) sources.push(source('old:user', oldText));
  if (withMemory) sources.push(source('memory:practice', '用户每周五练琴。', { kind: 'memory', messageRole: null, version: 2, sourceVersions: [{ id: 'old:user', version: 1 }] }));
  return { scope, currentMessageId: sources[0]!.id, sources,
    messages: sources.filter(s => s.kind === 'transcript').map(s => ({ characterId: scope.characterId, id: s.id, text: s.text, role: 'user', createdAt: s.createdAt })),
    relevantMemories: sources.filter(s => s.kind === 'memory').map(s => ({ characterId: scope.characterId, id: s.id, text: s.text, version: s.version, sourceIds: ['old:user'] })) };
}
function harness(rawModelText: string) {
  const requests: any[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: rawModelText } }], usage: lifecycleLiveV2.usage });
  });
  const config = { endpoint: 'https://controlled.invalid/chat/completions', model: 'qwen-plus-2025-12-01', apiKey: () => 'test-only', authorizer: { async authorize() { return { async settle() {} }; } } };
  return { provider: new QwenMemoryTurnProvider(config, transport), requests };
}
const signal = () => new AbortController().signal;

test('exact live-v2 response still fails at unsuppressed retention, with no repair or retry', async t => {
  const run = harness(lifecycleLiveV2.rawModelText);
  await assert.rejects(run.provider.plan(input(currentWire.text), signal()), { message: 'Fragment must retain an explicitly suppressed readable transcript or summary' });
  assert.equal(run.requests.length, 1);
  assert.deepEqual(JSON.parse(run.requests[0].messages[1].content), JSON.parse(lifecycleLiveV2.inputMessages[1].content));
  const recorded = JSON.parse(lifecycleLiveV2.rawModelText);
  assert.deepEqual(recorded.suppressSources, []); assert.equal(recorded.retainSources.length, 1); assert.equal(recorded.retainSources[0].end, 17);
  assert.equal(Array.from(currentWire.text).length, 13);
  t.diagnostic('original_live_failure: unsuppressed retention rejected; source=13 code points; model end=17; no actual provider call');
});

test('isolated recorded end17 is still rejected when suppression is explicitly supplied', async () => {
  const controlled = JSON.parse(lifecycleLiveV2.rawModelText);
  controlled.suppressSources = [{ id: 's0', version: 1 }];
  const run = harness(JSON.stringify(controlled));
  await assert.rejects(run.provider.plan(input(currentWire.text), signal()), { message: 'Invalid Unicode code point range' });
  assert.equal(run.requests.length, 1);
});

function withSources(data: MemoryTurnInput, sources: MemorySource[]): MemoryTurnInput {
  return { ...data, sources, messages: sources.filter(s => s.kind === 'transcript').map(s => ({ characterId: scope.characterId, id: s.id, text: s.text, role: s.messageRole!, createdAt: s.createdAt })),
    relevantMemories: sources.filter(s => s.kind === 'memory').map(s => ({ characterId: scope.characterId, id: s.id, text: s.text, version: s.version, sourceIds: s.sourceVersions!.map(ref => ref.id) })) };
}
const correction = input('改为每周六练琴。', '我每周五练琴。', true);
const assistant = (id: string, text: string, sourceVersions: NonNullable<MemorySource['sourceVersions']>): MemorySource => ({ ...correction.sources[0]!, id, text, messageRole: 'assistant', sourceVersions });
const summary = input('忘记练琴的事。', '我每周五练琴。', true);
const summarySources = summary.sources.map(s => s.kind === 'memory' ? { ...s, id: 'summary:practice', kind: 'summary' as const } : s);
const clarify = input('两个安排忘掉一个。', '周五练琴。');
const examples = [input('我每周五练琴。'), input('我哪天练琴？', '忘记练琴的事。'),
  withSources(correction, [...correction.sources, assistant('old:assistant', '你周五练琴。', [{ id: 'old:user', version: 1 }, { id: 'memory:practice', version: 2 }]), assistant('echo:assistant', '对，是周五。', [{ id: 'old:assistant', version: 1 }])]),
  withSources(summary, [...summarySources, summary.sources[2]!, assistant('forget:assistant', '记得，你周五练琴。', [{ id: 'old:user', version: 1 }, { id: 'summary:practice', version: 2 }, { id: 'memory:practice', version: 2 }])]),
  input('忘记练琴的事。', '周五练琴，周日跑步。'),
  withSources(clarify, [...clarify.sources, { ...clarify.sources[1]!, id: 'other:user', text: '周日跑步。' }])];
for (const [index, label] of ['natural add', 'query after old forget', 'correction with assistant descendants', 'memory raw summary and assistant forget', 'mixed-source forget', 'clarification before mutations'].entries()) {
  test(`complete ${label} example obeys strict six-field relationships`, async () => {
    const example = memoryTurnPlanExamples[index]!, data = examples[index]!;
    const run = harness(JSON.stringify(example.plan)), result = await run.provider.plan(data, signal());
    assert.equal(result.request, example.plan.request);
    const emitted = run.requests[0].messages[0].content.split('\n').filter((line: string) => line.startsWith('{"request"')).map((line: string) => JSON.parse(line));
    assert.deepEqual(emitted, memoryTurnPlanExamples.map(item => item.plan));
    for (const output of emitted) assert.deepEqual(Object.keys(output).sort(), ['changes', 'clarification', 'reason', 'request', 'retainSources', 'suppressSources']);
    if (index === 0) {
      assert.deepEqual(result.suppressSources, []); assert.deepEqual(result.retainSources, []);
      const op = result.changes[0]!.operation; assert.equal(op.type, 'add'); if (op.type === 'add') assert.deepEqual(op.sourceIds, [data.currentMessageId]);
    } else if (index === 1) assert.deepEqual([result.changes, result.suppressSources, result.retainSources], [[], [], []]);
    else if (index === 2) {
      assert.deepEqual(result.suppressSources.map(s => s.id), ['old:user', 'old:assistant', 'echo:assistant']); assert.deepEqual(result.retainSources, []);
      const op = result.changes[0]!.operation; assert.equal(op.type, 'update');
      if (op.type === 'update') { assert.equal(op.id, 'memory:practice'); assert.deepEqual(op.sourceIds, [data.currentMessageId]); }
    } else if (index === 3) {
      assert.deepEqual(result.suppressSources.map(s => s.id), [data.currentMessageId, 'old:user', 'summary:practice', 'forget:assistant']);
      assert.deepEqual(result.retainSources, []);
      assert.deepEqual(result.changes.map(c => c.operation), [{ type: 'soft_delete', id: 'memory:practice', expectedVersion: 2 }]);
    } else if (index === 4) {
      const retained = result.retainSources![0]!;
      assert.equal(retained.source.id, 'old:user'); assert.deepEqual(retained.supportSourceIds, []);
      assert.equal(Array.from(data.sources[1]!.text).slice(retained.start, retained.end).join(''), '周日跑步。');
      assert.deepEqual(result.changes, []); assert.equal(result.suppressSources.length, 2);
    } else {
      assert.deepEqual([result.changes, result.suppressSources, result.retainSources], [[], [], []]);
      assert.equal(result.clarification, '你想忘记哪一个安排？');
    }
  });
}

test('no-memory raw and summary forget remains executable with no invented memory target', async () => {
  const data = withSources(summary, summarySources);
  const plan = { request: 'forget', changes: [], suppressSources: [{ id: 's0', version: 1 }, { id: 's1', version: 1 }, { id: 's2', version: 2 }], retainSources: [], clarification: null, reason: '只有原文及摘要，无memory' };
  const run = harness(JSON.stringify(plan)), result = await run.provider.plan(data, signal());
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.suppressSources.map(s => s.id), [data.currentMessageId, 'old:user', 'summary:practice']);
  assert.equal(run.requests.length, 1);
});

test('summary cannot become soft_delete target even when its text and version match a memory', async () => {
  const data = examples[3]!, original = memoryTurnPlanExamples[3]!.plan;
  const illegal = { ...original, changes: [{ reason: 'controlled wrong kind', operation: { type: 'soft_delete', id: 's2', expectedVersion: 2 } }] };
  const run = harness(JSON.stringify(illegal));
  await assert.rejects(run.provider.plan(data, signal()), { message: 'Unknown wire source or wrong source kind' });
  assert.equal(run.requests.length, 1);
});
