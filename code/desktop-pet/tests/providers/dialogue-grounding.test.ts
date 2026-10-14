import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DialogueRequest, TurnScope } from '../../contracts/index.js';
import type { MemoryTurnOutcome } from '../../contracts/memory-lifecycle.js';
import { contextInputUpperBound } from '../../app/input-budgets.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';
import { dialogueLiveV4, sourceAbsenceObservation } from './fixtures/dialogue-live-v4.js';

type RequestBody = { messages: { role: string; content: string }[]; [key: string]: unknown };
const signal = () => new AbortController().signal;
const reply = (text: string) => ({ text, expression: { emotion: 'neutral', intensity: 0.3, delivery: '自然', gesture: null } });
function harness(raw: string, afterRequest?: () => void) {
  const requests: RequestBody[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); afterRequest?.();
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: raw } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  return { requests, provider: new QwenDialogueProvider({ endpoint: 'https://controlled.invalid/chat/completions', model: 'qwen-plus-2025-12-01', apiKey: () => 'test-only',
    authorizer: { async authorize() { return { async settle() {} }; } } }, transport) };
}
function data(body: RequestBody) {
  const users = body.messages.filter(message => message.role === 'user');
  assert.equal(users.length, 1);
  return JSON.parse(users[0]!.content);
}
function outcome(body: RequestBody) {
  const row = body.messages.find(m => m.content.startsWith('程序提供的本轮记忆执行结果：'))!;
  return JSON.parse(row.content.slice(row.content.indexOf('：') + 1));
}

for (const fixture of dialogueLiveV4.cases) test(`original ${fixture.name} semantic failure remains unchanged when structurally accepted`, async t => {
  assert.equal(createHash('sha256').update(fixture.rawModelText).digest('hex'), fixture.modelTextSha256);
  const input: DialogueRequest = fixture.input, before = structuredClone(input), run = harness(fixture.rawModelText);
  const result = await run.provider.reply(input, signal());
  assert.deepEqual(result, fixture.originalReply); assert.equal(fixture.semanticAcceptance, false);
  assert.deepEqual(input, before); assert.equal(run.requests.length, 1);
  const body = run.requests[0]!, payload = data(body), currentId = `${input.scope.turnId}:user`;
  assert.equal(payload.currentMessage, input.text);
  assert.deepEqual(payload.history, input.context.recent.filter(m => m.id !== currentId).map(m => ({ role: m.role, text: m.text })));
  assert.deepEqual({ summary: payload.summary, memories: payload.memories, perception: payload.perception }, { summary: input.context.summary, memories: input.context.memories, perception: input.context.perception });
  assert.equal(JSON.stringify(payload).split(input.text).length - 1, 1);
  assert.deepEqual(outcome(body), { request: input.memoryOutcome!.request, status: input.memoryOutcome!.status, clarification: null });
  assert.equal(body.messages.filter(m => m.role === 'assistant').length, 0, 'old assistant text is historical data, not an output example');
  assert.ok(Buffer.byteLength(JSON.stringify(body.messages)) <= contextInputUpperBound(input.context, input.text), 'new encoding remains within the existing conservative counter');
  t.diagnostic(`semanticAcceptance=false: ${fixture.semanticFailure}; no real model call or response repair`);
});

test('separate post-forget absence counterexample remains a semantic failure, not proof the user never spoke', async t => {
  const input: DialogueRequest = sourceAbsenceObservation.input;
  const run = harness(JSON.stringify({ text: sourceAbsenceObservation.originalReply.text, expression: sourceAbsenceObservation.originalReply.expression }));
  const result = await run.provider.reply(input, signal());
  assert.equal(result.text, sourceAbsenceObservation.originalReply.text);
  assert.deepEqual(data(run.requests[0]!).memories, []);
  assert.equal(sourceAbsenceObservation.semanticAcceptance, false);
  t.diagnostic('New source-suite observation is independently versioned; empty current memory does not establish historical absence.');
});

test('a missing saved current is sent once while identical text in a different historical turn remains history', async () => {
  const original: DialogueRequest = dialogueLiveV4.cases[1].input;
  const input = { ...original, context: { ...original.context, recent: [{ characterId: original.scope.characterId, id: 'older:user', role: 'user' as const, text: original.text, createdAt: '2026-09-01T00:00:00Z' }] } };
  const run = harness(JSON.stringify(reply('可以继续聊。')));
  await run.provider.reply(input, signal());
  assert.deepEqual(data(run.requests[0]!).history, [{ role: 'user', text: original.text }]);
  assert.equal(data(run.requests[0]!).currentMessage, original.text, 'identity determines current; equal old text is not silently discarded');
});

test('duplicate or mismatched current identity and cross-character history reject before transport', async () => {
  const original: DialogueRequest = dialogueLiveV4.cases[0].input, current = original.context.recent[0]!;
  for (const recent of [[current, current], [{ ...current, text: '被替换的本轮输入' }], [{ ...current, role: 'assistant' as const }], [{ ...current, characterId: 'sweetheart' as const }]]) {
    const run = harness(JSON.stringify(reply('不会发出')));
    await assert.rejects(run.provider.reply({ ...original, context: { ...original.context, recent } }, signal()));
    assert.equal(run.requests.length, 0);
  }
});

test('known forget outcomes send no target body, historical evidence or internal diagnostics', async () => {
  const base: DialogueRequest = dialogueLiveV4.cases[1].input;
  for (const status of ['applied', 'unchanged', 'rejected', 'needs_clarification'] as const) {
    const memoryOutcome: MemoryTurnOutcome = { scope: base.scope, request: 'forget', status, results: [], affectedIds: status === 'applied' ? ['private-id'] : [], retrievalInvalidated: status === 'applied', clarification: status === 'needs_clarification' ? '你指的是哪件事？' : null, rejectionCode: 'private-diagnostic' };
    const run = harness(JSON.stringify(reply('按实际结果回应。')));
    await run.provider.reply({ ...base, memoryOutcome }, signal());
    const body = run.requests[0]!, payload = data(body), encoded = JSON.stringify(body);
    assert.deepEqual(Object.keys(payload), ['currentMessage']);
    for (const value of [base.text, '糯米', '团子', 'private-id', 'private-diagnostic', ...base.context.recent.map(m => m.text)]) assert.equal(encoded.includes(value), false);
    assert.deepEqual(outcome(body), { request: 'forget', status, clarification: memoryOutcome.clarification });
  }
});

test('absent outcome remains null and an arbitrary long reply is not replaced or truncated', async () => {
  const { memoryOutcome: _unused, ...input } = dialogueLiveV4.cases[1].input;
  const text = '这是独立受控生成的完整内容。😀'.repeat(800), run = harness(JSON.stringify(reply(text)));
  assert.equal((await run.provider.reply(input, signal())).text, text);
  assert.equal(outcome(run.requests[0]!), null);
  assert.equal('max_tokens' in run.requests[0]!, false); assert.equal('max_completion_tokens' in run.requests[0]!, false);
});

test('concurrent character requests keep snapshots separate and a cancelled late reply is never returned', async () => {
  const original: DialogueRequest = dialogueLiveV4.cases[1].input;
  const gates: ((response: Response) => void)[] = [], bodies: RequestBody[] = [];
  const transport = new ProviderTransport((_url, init) => new Promise<Response>(resolve => { bodies.push(JSON.parse(String(init?.body))); gates.push(resolve); }));
  const provider = new QwenDialogueProvider({ endpoint: 'https://controlled.invalid/chat/completions', model: 'test-only', apiKey: () => 'test-only', authorizer: { async authorize() { return { async settle() {} }; } } }, transport);
  const scope: TurnScope = { ...original.scope, characterId: 'sweetheart', turnId: 'other-turn', generation: 2 };
  const other: DialogueRequest = { scope, text: '另一角色本轮问题', context: { scope, characterPrompt: '另一角色', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 32768 } };
  const controller = new AbortController(), first = provider.reply(original, controller.signal), rejected = assert.rejects(first, { name: 'AbortError' });
  const second = provider.reply(other, signal());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(gates.length, 2);
  controller.abort(); gates[1]!(Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply('另一角色的回复')) } }] }));
  // This controlled fetch deliberately ignores abort; deliver its late result before awaiting rejection.
  gates[0]!(Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply('迟到回复')) } }] }));
  const answer = await second; assert.deepEqual(answer.scope, scope); await rejected;
  assert.equal(data(bodies[0]!).currentMessage, original.text); assert.equal(data(bodies[1]!).currentMessage, other.text);
  assert.equal(JSON.stringify(bodies[1]).includes('糯米'), false); assert.deepEqual(original, dialogueLiveV4.cases[1].input);
});
