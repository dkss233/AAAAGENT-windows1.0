import { companionFixture } from './companion-fixture.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MemoryTurnInput, MemoryTurnProvider } from '../../contracts/memory-lifecycle.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { contextInputUpperBound, memoryTurnInputUpperBound } from '../../app/input-budgets.js';
import { QwenMemoryTurnProvider } from '../../providers/qwen-memory-lifecycle.js';
import { MEMORY_TURN_PROMPT } from '../../providers/memory-lifecycle-prompt.js';
import { ProviderTransport } from '../../providers/transport.js';
import { assembleContext } from '../../memory/context.js';
import { DEFAULT_CHARACTER_PROMPTS } from '../../companion/prompts.js';
import { lifecycleLiveV4 as historicalFixture } from './fixtures/lifecycle-live-v4.js';

const fixture = companionFixture(historicalFixture);
const signal = () => new AbortController().signal;
const input: MemoryTurnInput = fixture.planTrace.input;
const unchanged: MemoryTurnProvider = { async plan(value) { return { scope: value.scope, request: 'none', changes: [], suppressSources: [], retainSources: [], clarification: null, reason: 'controlled seed' }; } };
function port(store: SqliteMemoryStore, provider = unchanged) {
  return new SqliteLifecycleMemoryPort(store, {
    context: { inputTokenBudget: 32_768, maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, countTokens: contextInputUpperBound, relevance: () => 1 },
    turn: { provider, inputTokenBudget: 32_768, countTokens: memoryTurnInputUpperBound },
    summary: { minMessages: 2, maxMessages: 24, inputTokenBudget: 32_768, countTokens: () => 1, provider: { async summarize() { throw new Error('not used'); } } },
  });
}
function harness(raw: string) {
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: raw } }], usage: fixture.traceEntry.usage });
  });
  return { requests, provider: new QwenMemoryTurnProvider({ endpoint: 'https://controlled.invalid/chat/completions', model: 'qwen-plus-2025-12-01', apiKey: () => 'test-only',
    authorizer: { async authorize() { return { async settle() {} }; } } }, transport) };
}
const ordered = <T extends { readonly id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const normalized = (data: MemoryTurnInput) => ({ ...data, sources: ordered(data.sources), messages: ordered(data.messages), relevantMemories: ordered(data.relevantMemories) });

/** Rebuild only the original active read set, through real SQLite and an issued assistant context. */
async function seeded(t: TestContext) {
  const parent = fileURLToPath(new URL('../../../../../artifacts/W0-I/memory-dynamics-01/tmp/', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(`${parent}case-`);
  const store = new SqliteMemoryStore({ filename: `${directory}/synthetic.sqlite`, retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => '2026-09-06T18:00:00.000Z' });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const [current, memory, raw, assistant] = input.sources;
  assert.ok(current && memory && raw && assistant);
  const currentId = current.id, currentText = current.text;
  const scope = { ...input.scope, turnId: 'controlled-seed-assistant' };
  store.append(scope, [{ characterId: scope.characterId, id: raw.id, role: 'user', text: raw.text, createdAt: raw.createdAt }]);
  assert.equal(store.apply({ scope, operationId: 'controlled-add', reason: 'seed historical version', createdAt: memory.createdAt,
    operation: { type: 'add', id: memory.id, text: '用户养了一只猫，名字叫团子。', sourceIds: [raw.id] } }).status, 'applied');
  assert.equal(store.apply({ scope, operationId: 'controlled-update', reason: 'seed captured version', createdAt: raw.createdAt,
    operation: { type: 'update', id: memory.id, expectedVersion: 1, text: memory.text, sourceIds: [raw.id] } }).status, 'applied');
  const initial = port(store);
  assert.equal((await initial.prepareTurn(scope, raw.id, raw.text, signal())).status, 'unchanged');
  const ordinary = await initial.context(scope, raw.text, null, signal());
  assert.equal(ordinary.memories.length,0,'new formula does not reproduce the historical constant-relevance selector');
  const ranked=store.recall.rank(scope,raw.text).find(item=>item.source.id===memory.id)!;
  assert.equal(ranked.relevance,.2);assert.ok(Math.abs(ranked.priority-.16)<1e-12);
  // This fixture replays a frozen historical provider input, not current recall quality.
  const frozen=assembleContext({characterId:scope.characterId,contextRecords:s=>({characterId:s.characterId,revision:store.revision(s),recent:[{characterId:s.characterId,id:raw.id,role:'user',text:store.inspect(s,raw.id)!.text,createdAt:raw.createdAt}],summaries:[],memories:[{characterId:s.characterId,id:memory.id,version:store.inspect(s,memory.id)!.version,text:store.inspect(s,memory.id)!.text,sourceIds:[raw.id]}]}),assertContextCurrent:(s,r)=>store.assertContextCurrent(s,r)},scope,raw.text,null,store.now(),
    {prompts:DEFAULT_CHARACTER_PROMPTS,inputTokenBudget:32768,maxRecentMessages:24,maxMemories:32,countTokens:contextInputUpperBound,relevance:()=>1});
  const context=store.lifecycle.trackContext(frozen,raw.text);
  await initial.appendAssistant(scope, { characterId: scope.characterId, id: assistant.id, role: 'assistant', text: assistant.text, createdAt: assistant.createdAt }, context, raw.id, signal());
  assert.deepEqual(store.inspect(scope, assistant.id)!.sources, assistant.sourceVersions);
  store.append(input.scope, [{ characterId: input.scope.characterId, id: current.id, role: 'user', text: current.text, createdAt: current.createdAt }]);
  const snapshot = () => input.sources.map(s => store.inspect(input.scope, s.id));
  function replay(rawResponse: string) {
    const run = harness(rawResponse);
    const bound = port(store, { async plan(selected, signal) {
      assert.deepEqual(normalized(selected), normalized(input), 'actual storage supplies the original complete model input with current product identity');
      // Only restore the saved source ordering to reproduce the original per-request wire aliases.
      return run.provider.plan({ ...selected, sources: input.sources.map(s => selected.sources.find(row => row.id === s.id)!) }, signal);
    } });
    return { requests: run.requests, execute: () => bound.prepareTurn(input.scope, currentId, currentText, signal()) };
  }
  return { store, snapshot, replay };
}

test('original v4 memory-in-suppress response rejects exactly once and leaves actual SQLite unchanged', async t => {
  assert.equal(createHash('sha256').update(fixture.traceEntry.modelText).digest('hex'), fixture.modelTextSha256);
  assert.equal(fixture.originalSourcesUnchanged, true);
  const f = await seeded(t), before = f.snapshot(), revision = f.store.revision(input.scope), run = f.replay(fixture.traceEntry.modelText);
  await assert.rejects(run.execute(), { message: 'Use a memory operation for a memory target' });
  assert.equal(run.requests.length, 1);
  assert.deepEqual(JSON.parse(run.requests[0]!.messages[1]!.content), JSON.parse(fixture.traceEntry.inputMessages[1]!.content));
  assert.deepEqual(f.snapshot(), before); assert.equal(f.store.revision(input.scope), revision);
});

test('independent legal v4 same-input plan soft-deletes memory and suppresses raw/current/assistant atomically', async t => {
  // Authored independently; the captured response is neither mutated nor automatically repaired.
  const candidate = { request: 'forget', changes: [{ reason: '遗忘该事实', operation: { type: 'soft_delete', id: 's1', expectedVersion: 2 } }],
    suppressSources: [{ id: 's0', version: 1 }, { id: 's2', version: 1 }, { id: 's3', version: 1 }], retainSources: [], clarification: null, reason: '按实际kind分别处理memory与原文' };
  const f = await seeded(t), run = f.replay(JSON.stringify(candidate)), outcome = await run.execute();
  assert.equal(run.requests.length, 1); assert.equal(outcome.status, 'applied', outcome.rejectionCode ?? '');
  assert.deepEqual(JSON.parse(run.requests[0]!.messages[1]!.content), JSON.parse(fixture.traceEntry.inputMessages[1]!.content));
  const records = f.snapshot();
  assert.equal(records[1]!.state, 'deleted'); assert.equal(records[1]!.version, 3);
  for (const index of [0, 2, 3]) assert.equal(records[index]!.state, 'invalidated');
  assert.deepEqual(f.store.visible(input.scope, 'memory'), []);
  assert.deepEqual(f.store.search(input.scope, '猫 糯米', 32, 'lexical'), []);
});

test('v4 kind-routing prompt stays within the unchanged 8074-byte package ceiling', () => {
  assert.equal(Buffer.byteLength(fixture.traceEntry.inputMessages[0]!.content), 8074);
  assert.ok(Buffer.byteLength(MEMORY_TURN_PROMPT) <= 8074);
});
