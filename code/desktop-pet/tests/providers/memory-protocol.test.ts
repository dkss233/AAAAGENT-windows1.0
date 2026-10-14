import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryMaintenanceInput, MemoryOperation } from '../../contracts/index.js';
import { QwenMemoryMaintenanceProvider } from '../../providers/qwen-dialogue.js';
import { type CallOutcome, ProviderTransport } from '../../providers/transport.js';
import { memoryLiveFailure } from './fixtures/memory-live-failure.js';

const input: MemoryMaintenanceInput = {
  scope: { characterId: 'friend', sessionId: 'protocol', turnId: 'memory', generation: 1 },
  messages: [{ characterId: 'friend', id: '<message-id>', role: 'user', text: '我换工作了。', createdAt: '2026-09-06T00:00:00Z' }],
  relevantMemories: [
    { characterId: 'friend', id: '<memory-id-1>', version: 2, text: '旧工作', sourceIds: ['expired-original'] },
    { characterId: 'friend', id: '<memory-id-2>', version: 1, text: '同一旧工作', sourceIds: ['expired-original'] },
  ],
};
const add: MemoryOperation = { type: 'add', id: 'new-memory', text: '用户每周三晚上固定练习吉他。', sourceIds: ['<message-id>'] };
function envelope(operation: unknown) { return { changes: [{ reason: '明确来源支持本次变化', operation }] }; }
function harness(response: unknown, raw = false) {
  const requests: any[] = [], outcomes: CallOutcome[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: raw ? response : JSON.stringify(response) }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
  });
  const provider = new QwenMemoryMaintenanceProvider({ endpoint: 'https://unit.invalid/chat/completions', model: 'qwen-plus-2025-12-01', apiKey: () => 'test-only-key', authorizer: { async authorize() { return { async settle(outcome) { outcomes.push(outcome); } }; } } }, transport);
  return { provider, requests, outcomes };
}
const signal = () => new AbortController().signal;

test('actual failed synthetic Qwen response remains rejected without silently repairing operation.add', async () => {
  const run = harness(memoryLiveFailure.rawModelText, true);
  await assert.rejects(run.provider.propose(memoryLiveFailure.input, signal()), /Unsupported memory operation/);
  assert.equal(run.requests.length, 1); assert.equal(run.outcomes[0]?.status, 'success');
  assert.deepEqual(run.outcomes[0]?.usage, { prompt_tokens: 11, completion_tokens: 7 });
});

test('explicit add shape accepts the diagnostic input with event fact and an exact provided source', async () => {
  const operation = { ...add, id: '7a3b9c1e-2f4d-4a8b-9c0e-5d6f7a8b9c0e', sourceIds: ['natural-add:user'] };
  const run = harness(envelope(operation));
  const result = await run.provider.propose(memoryLiveFailure.input, signal());
  assert.deepEqual(result[0]?.operation, operation); assert.deepEqual(result[0]?.scope, memoryLiveFailure.input.scope);
  assert.equal(result[0]?.operationId, 'natural-add:memory:0');
});

test('the emitted prompt supplies five complete parseable contract examples and a no-change envelope', async () => {
  const run = harness({ changes: [] });
  assert.deepEqual(await run.provider.propose(input, signal()), []);
  const payload = run.requests[0], prompt: string = payload.messages[0].content;
  const examples = prompt.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.deepEqual(examples.map(example => example.changes[0]?.operation.type ?? 'no_change'), ['add', 'update', 'merge', 'soft_delete', 'restore', 'no_change']);
  for (const example of examples) {
    const parsed = await harness(example).provider.propose(input, signal());
    assert.deepEqual(parsed.map(change => ({ reason: change.reason, operation: change.operation })), example.changes);
  }
  assert.deepEqual(JSON.parse(payload.messages[1].content), { messages: input.messages, memories: input.relevantMemories });
  assert.deepEqual(payload.response_format, { type: 'json_object' });
  assert.equal(payload.enable_thinking, false); assert.equal('max_tokens' in payload, false);
  assert.match(prompt, /短暂情绪不能当作稳定事实/);
  assert.match(prompt, /重要情绪经历可以保留明确的时间或事件限定/);
  assert.match(prompt, /memories.sourceIds 只是历史来源信息/);
  assert.match(prompt, /不要求用户逐条批准/);
});

test('ambiguous envelopes, alias fields and fields at the wrong nesting level are rejected', async () => {
  const valid = envelope(add), target = { id: '<memory-id-1>', expectedVersion: 2 };
  const invalid = [
    {}, { changes: null }, { changes: [], reason: 'extra' }, { operations: [add] },
    { changes: [{ ...valid.changes[0], sourceIds: ['<message-id>'] }] },
    { changes: [{ operation: add }] },
    envelope({ ...add, add: 'ambiguous-second-id' }),
    envelope({ type: 'add', id: 'new', text: 'text', sources: ['<message-id>'] }),
    envelope({ type: 'update', ...target, text: 'new text', source_ids: ['<message-id>'] }),
    envelope({ type: 'soft_delete', ...target, reason: 'wrong nesting' }),
    envelope({ type: 'restore', ...target, sourceIds: ['<message-id>'] }),
    envelope({ type: 'merge', targets: [target, { id: '<memory-id-2>', expectedVersion: 1 }], id: 'new', text: 'merged', sourceIds: ['<message-id>'] }),
    envelope({ type: 'merge', targets: [{ ...target, text: 'wrong nesting' }, { id: '<memory-id-2>', expectedVersion: 1 }], replacement: { id: 'new', text: 'merged', sourceIds: ['<message-id>'] } }),
    envelope({ type: 'merge', targets: [target, { id: '<memory-id-2>', expectedVersion: 1 }], replacement: { id: 'new', text: 'merged', sources: ['<message-id>'] } }),
    envelope({ type: 'delete', ...target }), envelope({ type: 'noop' }),
  ];
  for (const value of invalid) {
    const run = harness(value);
    await assert.rejects(run.provider.propose(input, signal())); assert.equal(run.requests.length, 1);
  }
});

test('empty identifiers/text and noninteger or string versions are not coerced into valid operations', async () => {
  for (const operation of [
    { ...add, id: '' }, { ...add, text: '   ' },
    { type: 'update', id: '<memory-id-1>', expectedVersion: '2', text: 'changed', sourceIds: ['<message-id>'] },
    { type: 'soft_delete', id: '<memory-id-1>', expectedVersion: 2.5 },
    { type: 'restore', id: '<memory-id-1>', expectedVersion: 0 },
    { type: 'merge', targets: [{ id: '<memory-id-1>', expectedVersion: 2 }, { id: '<memory-id-2>', expectedVersion: 1 }], replacement: { id: ' ', text: 'merged', sourceIds: ['<message-id>'] } },
  ]) await assert.rejects(harness(envelope(operation)).provider.propose(input, signal()));
  await assert.rejects(harness({ changes: [{ reason: ' ', operation: add }] }).provider.propose(input, signal()), /Memory reason required/);
});

test('strict structure retains expired-source, unknown-target and duplicate-merge protections', async () => {
  for (const sourceIds of [[], ['expired-original'], ['sweetheart-message'], [0]]) {
    await assert.rejects(harness(envelope({ ...add, sourceIds })).provider.propose(input, signal()));
  }
  const target = { id: '<memory-id-1>', expectedVersion: 2 };
  await assert.rejects(harness(envelope({ type: 'update', id: 'not-provided', expectedVersion: 1, text: 'changed', sourceIds: ['<message-id>'] })).provider.propose(input, signal()), /target\/version/);
  await assert.rejects(harness(envelope({ type: 'merge', targets: [target, target], replacement: { id: 'new', text: 'merged', sourceIds: ['<memory-id-1>'] } })).provider.propose(input, signal()), /Repeated merge target/);
  const kept = await harness(envelope({ ...add, sourceIds: ['<memory-id-1>'] })).provider.propose(input, signal());
  assert.deepEqual(kept[0]?.operation, { ...add, sourceIds: ['<memory-id-1>'] });
});

test('one malformed change rejects the entire response instead of publishing earlier proposals', async () => {
  await assert.rejects(harness({ changes: [envelope(add).changes[0], { reason: 'bad second', operation: { add: 'shortcut' } }] }).provider.propose(input, signal()), /Unsupported memory operation/);
});
