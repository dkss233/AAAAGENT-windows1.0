import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { QwenMemoryTurnProvider } from '../../providers/qwen-memory-lifecycle.js';
import { ProviderTransport } from '../../providers/transport.js';
import { lifecycleLiveV1 } from './fixtures/lifecycle-live-v1.js';

// Replaying recorded decisions is controlled protocol evidence. It cannot measure new prompt semantics.
const data = (index: number): MemoryTurnInput => {
  const row = lifecycleLiveV1.cases[index]!;
  return structuredClone({ scope: row.scope, currentMessageId: row.input.currentMessageId, sources: row.input.sources, messages: row.input.messages, relevantMemories: row.input.memories }) as MemoryTurnInput;
};
function harness(index: number, output: 'none' | 'recorded') {
  const original = data(index), requests: any[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    const wire = JSON.parse(request.messages[1].content), rows = [...wire.evidence, wire.currentMessage];
    const aliases = new Map(original.sources.map(s => [s.id, rows.find((row: any) => row.text === s.text && row.kind === s.kind)?.id]));
    const convert = (value: any, key = ''): any => {
      if (Array.isArray(value)) return value.map(v => convert(v, key));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v, k)]));
      return (key === 'id' || key === 'sourceIds') && typeof value === 'string' ? aliases.get(value) ?? value : value;
    };
    const plan = output === 'none' ? { request: 'none', changes: [], suppressSources: [], clarification: null, reason: '受控无变更' } : convert(JSON.parse(lifecycleLiveV1.cases[index]!.rawModelText));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...plan, retainSources: [] }) } }] });
  });
  return { provider: new QwenMemoryTurnProvider({ endpoint: 'https://controlled.invalid/chat/completions', model: 'test', apiKey: () => 'test-only', authorizer: { async authorize() { return { async settle() {} }; } } }, transport), requests };
}

test('real miss and duplicate database state remain preserved; wire keeps the exact current Chinese questions separate', async () => {
  assert.equal(lifecycleLiveV1.cases[0]!.input.memories.length, 0);
  assert.equal(lifecycleLiveV1.cases[0]!.memoriesBefore.length, 1);
  assert.equal(lifecycleLiveV1.cases[1]!.input.memories.length, 2);
  assert.deepEqual(lifecycleLiveV1.cases[1]!.input.memories.map(m => m.text), ['用户养了一只名叫团子的猫。', '用户养了一只名叫团子的猫']);
  for (let i = 0; i < 3; i++) {
    const run = harness(i, 'none'); await run.provider.plan(data(i), new AbortController().signal);
    const request = run.requests[0], wire = JSON.parse(request.messages[1].content);
    assert.equal(wire.currentMessage.text, data(i).sources.find(s => s.id === data(i).currentMessageId)!.text);
    assert.equal(wire.evidence.length + 1, data(i).sources.length);
    assert.equal(request.messages.length, 2);
  }
});

test('recorded previous-turn forget replay cannot pass the explicit current-message handling rule', async () => {
  const raw = JSON.parse(lifecycleLiveV1.cases[2]!.rawModelText);
  assert.equal(raw.request, 'forget'); assert(raw.reason.includes('本轮用户新问'));
  const run = harness(2, 'recorded');
  await assert.rejects(run.provider.plan(data(2), new AbortController().signal), /explicitly handle its current message/);
  assert.equal(run.requests.length, 1);
});

test('recorded correction mislabeled none is retained as a semantic limitation, not silently relabeled by keywords', async () => {
  const result = await harness(1, 'recorded').provider.plan(data(1), new AbortController().signal);
  assert.equal(result.request, 'none'); assert.equal(result.changes.length, 2);
  for (const { operation } of result.changes) assert.equal(operation.type, 'update');
  // A fresh real model run must verify that the revised current-only prompt fixes this decision.
});
