import { companionFixture } from './companion-fixture.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MemorySource, MemoryTurnInput, MemoryTurnProvider } from '../../contracts/memory-lifecycle.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { contextInputUpperBound, memoryTurnInputUpperBound } from '../../app/input-budgets.js';
import { QwenMemoryTurnProvider } from '../../providers/qwen-memory-lifecycle.js';
import { MEMORY_TURN_PROMPT } from '../../providers/memory-lifecycle-prompt.js';
import { ProviderTransport } from '../../providers/transport.js';
import { lifecycleLiveV3 as historicalFixture } from './fixtures/lifecycle-live-v3.js';

type CapturedTurn = typeof lifecycleLiveV3.turns[number];
const lifecycleLiveV3 = companionFixture(historicalFixture);
const signal = () => new AbortController().signal;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const actualId = (wireId: string) => `fixture:${wireId}`;
function recordedInput(turn: CapturedTurn): MemoryTurnInput {
  const data = JSON.parse(turn.inputDataContent);
  const sources: MemorySource[] = [data.currentMessage, ...data.evidence].map((source: MemorySource) => ({ ...source, scope: turn.scope, id: actualId(source.id),
    sourceVersions: source.sourceVersions!.map(ref => ({ ...ref, id: actualId(ref.id) })) }));
  return { scope: turn.scope, currentMessageId: actualId(data.currentMessage.id), sources,
    messages: sources.filter(s => s.kind === 'transcript').map(s => ({ characterId: turn.scope.characterId, id: s.id, text: s.text, role: s.messageRole!, createdAt: s.createdAt })),
    relevantMemories: sources.filter(s => s.kind === 'memory').map(s => ({ characterId: turn.scope.characterId, id: s.id, text: s.text, version: s.version, sourceIds: s.sourceVersions!.map(ref => ref.id) })) };
}
function harness(rawModelText: string) {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: rawModelText } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  return { requests, provider: new QwenMemoryTurnProvider({ endpoint: 'https://controlled.invalid/chat/completions', model: 'qwen-plus-2025-12-01', apiKey: () => 'test-only',
    authorizer: { async authorize() { return { async settle() {} }; } } }, transport) };
}

for (const turn of lifecycleLiveV3.turns) test(`live-v3 ${turn.name}: byte-preserved response at unchanged strict parser`, async () => {
  assert.equal(sha(turn.modelText), turn.modelTextSha256);
  const input = recordedInput(turn), run = harness(turn.modelText);
  const error = turn.name === '06-raw-only-forget' ? 'Unknown wire source or wrong source kind' : turn.name === '08-ambiguous-request' ? 'Clarification cannot include mutations' : null;
  if (error) await assert.rejects(run.provider.plan(input, signal()), { message: error });
  else {
    const plan = await run.provider.plan(input, signal());
    if (turn.name === '01-natural-add') {
      assert.equal(plan.changes.length, 1); assert.equal(plan.changes[0]!.operation.type, 'add');
      assert.deepEqual([plan.suppressSources, plan.retainSources], [[], []]);
    } else if (turn.name === '02-long-term-query') {
      assert.equal(input.relevantMemories.length, 1); assert.equal(plan.request, 'none');
      assert.deepEqual([plan.changes, plan.suppressSources, plan.retainSources], [[], [], []]);
    } else {
      assert.deepEqual(input.sources.filter(s => s.messageRole === 'assistant').map(s => s.evidenceEligible), [true, true]);
      assert.ok(!plan.suppressSources.some(s => ['fixture:s3', 'fixture:s4'].includes(s.id)));
      // Structural acceptance is not transaction acceptance; SQLite checks omissions below.
    }
  }
  assert.equal(run.requests.length, 1);
  assert.deepEqual(JSON.parse(run.requests[0]!.messages[1]!.content), JSON.parse(turn.inputDataContent));
});

const unchanged: MemoryTurnProvider = { async plan(input) { return { scope: input.scope, request: 'none', changes: [], suppressSources: [], retainSources: [], clarification: null, reason: 'controlled seed only' }; } };
function port(store: SqliteMemoryStore, provider = unchanged) {
  return new SqliteLifecycleMemoryPort(store, {
    context: { inputTokenBudget: 32_768, maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, countTokens: contextInputUpperBound, relevance: () => 1 },
    turn: { provider, inputTokenBudget: 32_768, countTokens: memoryTurnInputUpperBound },
    summary: { minMessages: 2, maxMessages: 24, inputTokenBudget: 32_768, countTokens: () => 1, provider: { async summarize() { throw new Error('not used in this replay'); } } },
  });
}
/** Seed the captured graph through real storage/issued assistant contexts, with controlled IDs. */
async function seeded(t: TestContext, turn: CapturedTurn) {
  const parent = fileURLToPath(new URL('../../../../../artifacts/W2/lifecycle-v3-prompt-fix/tmp/', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(`${parent}case-`);
  const input = recordedInput(turn), store = new SqliteMemoryStore({ filename: `${directory}/synthetic.sqlite`, retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => '2026-09-06T18:00:00.000Z' });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const history = input.sources.filter(s => s.id !== input.currentMessageId).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const source of history) {
    assert.equal(source.version, 1, 'captured fixtures have initial versions');
    const scope = { ...turn.scope, turnId: `seed:${source.id}` };
    if (source.kind === 'memory') {
      assert.equal(store.apply({ scope, operationId: `seed:${source.id}`, reason: 'captured synthetic fact', createdAt: source.createdAt,
        operation: { type: 'add', id: source.id, text: source.text, sourceIds: source.sourceVersions!.map(ref => ref.id) } }).status, 'applied');
    } else if (source.kind === 'summary') store.recordDerived(scope, { id: source.id, kind: 'summary', text: source.text, sourceIds: source.sourceVersions!.map(ref => ref.id), createdAt: source.createdAt });
    else if (source.messageRole === 'user') store.append(scope, [{ characterId: scope.characterId, id: source.id, role: 'user', text: source.text, createdAt: source.createdAt }]);
    else {
      const current = source.sourceVersions!.map(ref => input.sources.find(s => s.id === ref.id)!).filter(s => s.messageRole === 'user').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]!;
      const seedPort = port(store);
      assert.equal((await seedPort.prepareTurn(scope, current.id, current.text, signal())).status, 'unchanged');
      const context = await seedPort.context(scope, current.text, null, signal());
      await seedPort.appendAssistant(scope, { characterId: scope.characterId, id: source.id, role: 'assistant', text: source.text, createdAt: source.createdAt }, context, current.id, signal());
    }
    const record = store.inspect(scope, source.id)!;
    assert.equal(record.evidenceEligible, true);
    assert.deepEqual(record.sources.map(ref => ref.id).sort(), source.sourceVersions!.map(ref => ref.id).sort(), 'issued context has the captured dependency graph');
  }
  const current = input.sources[0]!;
  store.append(turn.scope, [{ characterId: turn.scope.characterId, id: current.id, role: 'user', text: current.text, createdAt: current.createdAt }]);
  const snapshot = () => input.sources.map(s => store.inspect(turn.scope, s.id));
  function replay(raw: string) {
    const run = harness(raw);
    const bound = port(store, { async plan(selected, signal) {
      assert.deepEqual(selected.sources.map(s => s.id).sort(), input.sources.map(s => s.id).sort(), 'no captured source omitted or invented');
      // Restore input order for original request-local s aliases; never rewrite the response.
      const sources = input.sources.map(s => selected.sources.find(item => item.id === s.id)!);
      return run.provider.plan({ ...selected, sources }, signal);
    } });
    return { requests: run.requests, execute: () => bound.prepareTurn(turn.scope, current.id, current.text, signal()) };
  }
  return { store, input, snapshot, replay };
}

for (const name of ['03-natural-correction', '04-explicit-forget'] as const) test(`live-v3 ${name}: original assistant omissions reject atomically in real SQLite`, async t => {
  const turn = lifecycleLiveV3.turns.find(row => row.name === name)!;
  const f = await seeded(t, turn), before = f.snapshot(), revision = f.store.revision(turn.scope), run = f.replay(turn.modelText);
  const outcome = await run.execute();
  assert.equal(outcome.status, 'rejected'); assert.equal(outcome.rejectionCode, 'unresolved_source_disposition');
  assert.deepEqual(f.snapshot(), before); assert.equal(f.store.revision(turn.scope), revision); assert.equal(run.requests.length, 1);
});

// Separately authored legal candidates, not altered real outputs or production repair/retry code.
const candidates = [
  { name: '03-natural-correction', plan: { request: 'correction', changes: [{ reason: '用户更正猫名', operation: { type: 'update', id: 's1', expectedVersion: 1, text: '用户养了一只猫，名字叫糯米。', sourceIds: ['s0'] } }], suppressSources: ['s2', 's3', 's4'].map(id => ({ id, version: 1 })), retainSources: [], clarification: null, reason: '显式处置已读旧原文和助手回声' } },
  { name: '04-explicit-forget', plan: { request: 'forget', changes: [{ reason: '遗忘养猫及猫名', operation: { type: 'soft_delete', id: 's1', expectedVersion: 1 } }], suppressSources: ['s0', 's2', 's3', 's4', 's5', 's6'].map(id => ({ id, version: 1 })), retainSources: [], clarification: null, reason: '显式处置原文与直接间接回声' } },
  { name: '06-raw-only-forget', plan: { request: 'forget', changes: [], suppressSources: ['s0', 's1', 's2'].map(id => ({ id, version: 1 })), retainSources: [], clarification: null, reason: '无memory，处理原文及summary' } },
  { name: '08-ambiguous-request', plan: { request: 'forget', changes: [], suppressSources: [], retainSources: [], clarification: '你想忘记哪一个安排？', reason: '先明确目标，暂不动作' } },
];
for (const candidate of candidates) test(`controlled legal ${candidate.name}: executes through provider and SQLite without retry`, async t => {
  const turn = lifecycleLiveV3.turns.find(row => row.name === candidate.name)!;
  const f = await seeded(t, turn), before = f.snapshot(), run = f.replay(JSON.stringify(candidate.plan));
  const outcome = await run.execute(); assert.equal(run.requests.length, 1);
  if (candidate.name === '08-ambiguous-request') {
    assert.equal(outcome.status, 'needs_clarification'); assert.deepEqual(f.snapshot(), before);
    assert.equal(outcome.clarification, candidate.plan.clarification); assert.deepEqual(outcome.affectedIds, []);
  } else {
    assert.equal(outcome.status, 'applied', outcome.rejectionCode ?? '');
    for (const source of candidate.plan.suppressSources) assert.notEqual(f.store.inspect(turn.scope, actualId(source.id))!.state, 'active');
    if (candidate.name === '03-natural-correction') {
      const memory = f.store.inspect(turn.scope, 'fixture:s1')!;
      assert.equal(memory.state, 'active'); assert.equal(memory.version, 2); assert.equal(memory.text, '用户养了一只猫，名字叫糯米。');
      assert.deepEqual(memory.sources, [{ id: 'fixture:s0', version: 1 }]);
      assert.equal(f.store.inspect(turn.scope, 'fixture:s5')!.state, 'active', 'unaffected user query is retained');
    } else assert.equal(f.store.visible(turn.scope, 'memory').length, 0);
  }
});

test('reorganized prompt stays below the approved 8115 byte ceiling', () => {
  assert.equal(Buffer.byteLength(lifecycleLiveV3.systemPrompt), 8115);
  assert.ok(Buffer.byteLength(MEMORY_TURN_PROMPT) <= 8115);
});
