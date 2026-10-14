import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectContextInput, ProjectMemoryItem, ProjectMemoryQuery, ProjectRecentTurn } from '../../contracts/project-memory.js';
import { ManagementError } from '../../contracts/management.js';
import { ProjectContextAssembler } from '../../projects/project-context-assembler.js';
import { SqliteProjectMemory } from '../../projects/project-memory-sqlite.js';

const at = '2026-09-27T00:00:00Z';
const task = { origin: 't3', id: 'task-a', projectId: 'project-a', provider: 'codex',
  environmentId: 'env-a', t3ProjectId: 'native-a', threadId: 'thread-a',
  providerInstanceId: 'codex-a' } as const;
const turn = (id: string, text: string): ProjectRecentTurn => ({ nativeTurnId: id,
  messages: [{ id: `user-${id}`, role: 'user', text, createdAt: at }] });
const source = (id: string) => ({ userInputId: id, recordedAt: at });
const memory = (id: string, text: string, extra: Partial<ProjectMemoryItem> = {}): ProjectMemoryItem => ({
  id, projectId: 'project-a', kind: 'fact', text, status: 'accepted', version: 1,
  sources: [source(id)], createdAt: at, updatedAt: at, ...extra,
});
const input = (turns: readonly ProjectRecentTurn[] = [], max = 5000): ProjectContextInput => ({
  projectId: task.projectId, taskId: task.id, task, current: { messageId: 'current-1', text: '调整遗忘曲率' },
  recent: { version: '0.1.0', projectId: task.projectId, taskId: task.id,
    environmentId: task.environmentId, threadId: task.threadId, branchRef: 'branch/main',
    snapshotSequence: 3, turns, hasOlder: true }, branchRef: 'branch/main',
  budget: { source: 'verified_provider_configuration', providerInstanceId: task.providerInstanceId,
    modelId: 'configured-model', maxInputUtf8Bytes: max, fixedOverheadUtf8Bytes: 100 },
});
const size = (value: ProjectContextInput, turns: readonly ProjectRecentTurn[], memories: readonly ProjectMemoryItem[] = []) =>
  value.budget.fixedOverheadUtf8Bytes + Buffer.byteLength(JSON.stringify({ current: value.current,
    recentTurns: turns, memories }));
const fake = (items: readonly ProjectMemoryItem[], calls: string[] = []) => ({
  async recall(query: { projectId: string }) { calls.push(query.projectId); return items; },
});
const conflict = (error: unknown) => error instanceof ManagementError && error.code === 'version_conflict';

test('current and newest complete native turn fail precisely before memory reads', async () => {
  const turns = [turn('newest', '完整上一句😀')], calls: string[] = [];
  const base = input(turns);
  const assembler = new ProjectContextAssembler(fake([], calls));
  const currentOnly = size(base, [], []);
  const tooSmall = input(turns, currentOnly - 1);
  assert.deepEqual(await assembler.assemble(tooSmall), { status: 'over_budget', reason: 'current_input',
    projectId: task.projectId, taskId: task.id, currentMessageId: 'current-1' });
  const newestTooLarge = input(turns, size(base, turns) - 1);
  assert.deepEqual(await assembler.assemble(newestTooLarge), { status: 'over_budget',
    reason: 'newest_complete_turn', projectId: task.projectId, taskId: task.id,
    currentMessageId: 'current-1' });
  assert.deepEqual(calls, []);
});

test('older turns form a contiguous suffix and UTF-8/structured bytes include fixed overhead', async () => {
  const turns = [turn('old', '很早😀'), turn('middle', '中间一句'), turn('latest', '最新一句')];
  const base = input(turns);
  const tail = turns.slice(1);
  const result = await new ProjectContextAssembler(fake([])).assemble(input(turns, size(base, tail)));
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.recentTurns.map(row => row.nativeTurnId), ['middle', 'latest']);
  assert.equal(result.usedUtf8Bytes, size(base, tail));
  assert.equal(result.omittedOlderTurns, 1);
  assert.equal(result.hasOlderNativeHistory, true);
  assert.ok(Buffer.byteLength('😀') > '😀'.length);
  const noBackfill = [turn('older', '短'), turn('blocking', '占满预算'.repeat(20)), turns[2]!];
  const limited = input(noBackfill, size(input(noBackfill), [turns[2]!]));
  const stopped = await new ProjectContextAssembler(fake([])).assemble(limited);
  assert.equal(stopped.status, 'ready');
  if (stopped.status === 'ready') {
    assert.deepEqual(stopped.recentTurns.map(row => row.nativeTurnId), ['latest']);
    assert.equal(stopped.omittedOlderTurns, 2);
  }
});

test('Chinese relevance ranks accepted applicable memory after recent turns while retaining provenance and conditions', async () => {
  const latest = turn('latest', '先继续项目工作');
  const base = input([latest]);
  const relevant = memory('relevant', '遗忘曲率需要微调', { branchRef: 'branch/main',
    condition: '仅当用户打开高级调整时', version: 4,
    sources: [source('decision-1'), source('revision-4')] });
  const unrelated = memory('unrelated', '构建部署设置', { updatedAt: '2026-09-28T00:00:00Z' });
  const candidate = memory('candidate', '遗忘曲率应提高', { status: 'candidate' });
  const withdrawn = memory('withdrawn', '遗忘曲率旧值', { status: 'withdrawn' });
  const otherProject = memory('foreign', '遗忘曲率外部项目', { projectId: 'project-b' });
  const otherBranch = memory('other-branch', '遗忘曲率另一个分支', { branchRef: 'branch/other' });
  const superseded = memory('superseded', '遗忘曲率旧结论', { supersededById: 'relevant' });
  const calls: string[] = [];
  const assembler = new ProjectContextAssembler(fake([unrelated, candidate, withdrawn,
    otherProject, otherBranch, superseded, relevant], calls));
  const limit = size(base, [latest], [relevant]);
  const result = await assembler.assemble(input([latest], limit));
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.recentTurns, [latest]);
  assert.deepEqual(result.memories, [relevant]);
  assert.equal(result.memories[0]?.condition, '仅当用户打开高级调整时');
  assert.equal(result.memories[0]?.version, 4);
  assert.deepEqual(result.memories[0]?.sources, relevant.sources);
  assert.equal(result.omittedMemories, 1);
  assert.deepEqual(calls, ['project-a']);
});

test('assembler selects an older relevant memory beyond the former 100-row cutoff', async t => {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../artifacts/W3/recall-rank-54/tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let tick = 0;
  const store = new SqliteProjectMemory(join(root, 'project-memory.sqlite'), { autoProcess: false,
    now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, tick++)).toISOString() });
  t.after(async () => store.close());
  const old = await store.change({ operationId: 'relevant-old', type: 'create', projectId: task.projectId,
    kind: 'decision', text: '遗忘曲率需要调整', status: 'accepted', sources: [source('original')],
    branchRef: 'branch/main', condition: '按用户本轮要求' });
  for (let index = 0; index < 100; index++) await store.change({ operationId: `irrelevant-${index}`,
    type: 'create', projectId: task.projectId, kind: 'fact', text: `部署设置 ${index}`,
    status: 'accepted', sources: [source(`later-${index}`)] });
  const latest = turn('latest', '继续这个项目');
  const base = input([latest]);
  const result = await new ProjectContextAssembler(store).assemble(input([latest], size(base, [latest], [old.item!])));
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.recentTurns, [latest]);
  assert.deepEqual(result.memories, [old.item]);
  assert.equal(result.usedUtf8Bytes, size(base, [latest], [old.item!]));
});

test('assembler ranks from this input and complete newest user text, excluding assistant claims', async () => {
  const newest: ProjectRecentTurn = { nativeTurnId: 'latest', messages: [
    { id: 'u-1', role: 'user', text: '先讨论遗忘', createdAt: at },
    { id: 'a-1', role: 'assistant', text: '助手推测应提高阈值', createdAt: at },
    { id: 'u-2', role: 'user', text: '再看曲率', createdAt: at },
  ] };
  let observed: ProjectMemoryQuery | undefined;
  const assembler = new ProjectContextAssembler({ async recall(query) { observed = query; return []; } });
  const result = await assembler.assemble(input([newest]));
  assert.equal(result.status, 'ready');
  assert.deepEqual(observed, { projectId: 'project-a', branchRef: 'branch/main', limit: 100,
    relevance: { currentText: '调整遗忘曲率', newestUserText: '先讨论遗忘 再看曲率' } });
});

test('source snapshot, branch and provider-budget drift fail before retrieval', async () => {
  const calls: string[] = [];
  const assembler = new ProjectContextAssembler(fake([], calls));
  const base = input([turn('newest', '原文')]);
  for (const changed of [
    { ...base, recent: { ...base.recent, projectId: 'project-b' } },
    { ...base, recent: { ...base.recent, threadId: 'stale-thread' } },
    { ...base, branchRef: 'branch/other' },
  ]) await assert.rejects(assembler.assemble(changed), conflict);
  await assert.rejects(assembler.assemble({ ...base, budget: { ...base.budget,
    providerInstanceId: 'wrong' } }), error => error instanceof ManagementError && error.code === 'invalid_request');
  assert.deepEqual(calls, []);
});

test('SQLite reopen, edit and withdrawal propagate to later read-only contexts without provider calls', async t => {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../artifacts/W3/project-context-54/tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = join(root, 'project-memory.sqlite');
  const store = new SqliteProjectMemory(filename, { autoProcess: false });
  const created = await store.change({ operationId: 'create', type: 'create', projectId: task.projectId,
    kind: 'decision', text: '遗忘曲率设为初值', status: 'accepted', sources: [source('original')] });
  await store.close();
  const reopened = new SqliteProjectMemory(filename, { autoProcess: false });
  t.after(async () => reopened.close());
  const assembler = new ProjectContextAssembler(reopened);
  const first = await assembler.assemble(input());
  assert.equal(first.status, 'ready');
  if (first.status !== 'ready') return;
  assert.deepEqual(first.memories.map(row => row.text), ['遗忘曲率设为初值']);
  const edited = await reopened.change({ operationId: 'edit', type: 'edit', projectId: task.projectId,
    id: created.item!.id, expectedVersion: 1, text: '遗忘曲率设为新值', source: source('correction') });
  const second = await assembler.assemble(input());
  assert.equal(second.status, 'ready');
  if (second.status !== 'ready') return;
  assert.equal(second.memories[0]?.version, edited.item?.version);
  assert.equal(second.memories[0]?.text, '遗忘曲率设为新值');
  await reopened.change({ operationId: 'withdraw', type: 'withdraw', projectId: task.projectId,
    id: created.item!.id, expectedVersion: 2 });
  const third = await assembler.assemble(input());
  assert.equal(third.status, 'ready');
  if (third.status === 'ready') assert.deepEqual(third.memories, []);
});
