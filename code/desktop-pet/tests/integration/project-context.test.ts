import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import type { ProjectContextAssemblerPort, ProjectProviderInputBudget } from '../../contracts/project-memory.js';
import type { WorkbenchTaskRef } from '../../contracts/workbench.js';
import { ManagementError } from '../../contracts/management.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';
import { normalizeProjectRecentTurns, validateProjectProviderBudget } from '../../app/project-context.js';
import { ProjectContextAssembler } from '../../projects/project-context-assembler.js';
import { SqliteProjectMemory } from '../../projects/project-memory-sqlite.js';

const at = '2026-09-27T01:00:00Z';
const project: ProjectEntry = { id: 'project-A', name: 'A', abstract: '',
  detailRef: { rootPath: '/registered/project' }, version: 1, updatedAt: at };
const task: Extract<WorkbenchTaskRef, { origin: 't3' }> = { id: 'task-A', projectId: project.id,
  provider: 'codex', origin: 't3', environmentId: 'environment-A', t3ProjectId: 'native-project-A',
  threadId: 'thread-A', providerInstanceId: 'codex-A' };
const shell = { id: task.threadId, projectId: task.t3ProjectId,
  modelSelection: { instanceId: task.providerInstanceId }, branch: 'main', latestTurn: null,
  hasPendingApprovals: false, hasPendingUserInput: false };
const msg = (turnId: string | null, role: string, id: string, text: string, createdAt: string) =>
  ({ turnId, role, id, text, createdAt, streaming: false });
const detail = { turnMessageBindings: { version: 1, snapshotSequence: 31, threadId: task.threadId,
  projectId: task.t3ProjectId, providerInstanceId: task.providerInstanceId, turns: [
    { turnId: 'turn-1', userMessageId: 'u1', assistantMessageId: 'a1', state: 'completed', completedAt: at, messageIds: ['u1','a1'] },
    { turnId: 'turn-2', userMessageId: 'u2', assistantMessageId: 'a2', state: 'completed', completedAt: at, messageIds: ['u2','a2'] },
    { turnId: 'subagent-turn', userMessageId: null, assistantMessageId: 'sa', state: 'completed', completedAt: at, messageIds: ['sa'] },
  ] }, snapshotSequence: 31, page: { snapshotSequence: 31,
  hasMore: true, beforeCursor: 'older_PAGE' }, thread: { ...shell, messages: [
    msg(null, 'user', 'u1', '先完成 A', '2026-09-27T00:00:01Z'),
    msg('turn-1', 'assistant', 'a1', 'A 已完成', '2026-09-27T00:00:02Z'),
    msg('subagent-turn', 'assistant', 'sa', '内部代理记录', '2026-09-27T00:00:03Z'),
    msg(null, 'user', 'u2', '再核对 B', '2026-09-27T00:00:04Z'),
    msg('turn-2', 'assistant', 'a2', 'B 待核', '2026-09-27T00:00:05Z'),
    msg(null, 'user', 'imported', '旧导入正文', '2026-09-26T00:00:00Z'),
  ] } };
const budget: ProjectProviderInputBudget = { source: 'verified_provider_configuration',
  providerInstanceId: 'codex-A', modelId: 'configured-model', maxInputUtf8Bytes: 8000,
  fixedOverheadUtf8Bytes: 1000 };
const projects: ProjectIndexPort = {
  async get(id) { return id === project.id ? project : null; },
  async list() { return { items: [project], total: 1, offset: 0, limit: 100 }; },
  async save() { throw Error('unexpected'); }, async remove() { throw Error('unexpected'); }, async close() {},
};
const code = (expected: string) => (error: unknown) =>
  error instanceof ManagementError && error.code === expected;

test('native page yields only source-complete ordered user turns and exposes older-page boundary', () => {
  const recent = normalizeProjectRecentTurns(task, detail);
  assert.equal(recent.snapshotSequence, 31);
  assert.equal(recent.branchRef, 'main');
  assert.equal(recent.hasOlder, true);
  assert.deepEqual(recent.turns.map(turn => turn.nativeTurnId), ['turn-1', 'turn-2']);
  assert.deepEqual(recent.turns.map(turn => turn.messages.map(message => message.id)), [['u1', 'a1'], ['u2', 'a2']]);
  assert.equal(JSON.stringify(recent).includes('内部代理记录'), false);
  assert.equal(JSON.stringify(recent).includes('旧导入正文'), false);
});

test('recent context rejects streaming, identity drift and unverified budget before use', () => {
  assert.throws(() => normalizeProjectRecentTurns(task, { ...detail,
    thread: { ...detail.thread, modelSelection: { instanceId: 'other' } } }), code('unavailable'));
  assert.throws(() => normalizeProjectRecentTurns(task, { ...detail,
    page: { ...detail.page, snapshotSequence: 32 } }), code('unavailable'));
  assert.throws(() => normalizeProjectRecentTurns(task, { ...detail,
    thread: { ...detail.thread, messages: [...detail.thread.messages,
      { ...msg('turn-2', 'assistant', 'partial', '迟到正文', at), streaming: true }] } }), code('unavailable'));
  assert.throws(() => validateProjectProviderBudget({ ...budget,
    providerInstanceId: 'other' }, task.providerInstanceId), code('invalid_request'));
  assert.throws(() => validateProjectProviderBudget({ ...budget,
    fixedOverheadUtf8Bytes: 8000 }, task.providerInstanceId), code('invalid_request'));
});

test('public read and assembly seam keep exact task, current text, newest turn and byte ceiling', async t => {
  const root = mkdtempSync(join(tmpdir(), 'project-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteWorkbenchStore(join(root, 'workbench.sqlite'));
  t.after(() => store.close());
  store.bindProject(project, task.environmentId,
    { id: task.t3ProjectId, workspaceRoot: '/registered/project' }, '/registered/project');
  store.saveVerifiedTask(task, shell);
  let calls = 0;
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: task.environmentId }; },
    async shellSnapshot() { return { snapshotSequence: 31, updatedAt: at,
      projects: [{ id: task.t3ProjectId, workspaceRoot: '/registered/project' }], threads: [shell] }; },
    async threadSnapshot() { return detail; },
    async dispatch() { throw Error('a context read must not dispatch'); },
  };
  const assembler: ProjectContextAssemblerPort = { async assemble(input) {
    calls++;
    if (input.current.messageId === 'current-1') assert.equal(input.current.text, '当前完整请求');
    assert.deepEqual(input.task, task);
    assert.equal(input.recent.taskId, task.id);
    assert.deepEqual(input.recent.turns.map(turn => turn.nativeTurnId), ['turn-1', 'turn-2']);
    return { status: 'ready', projectId: input.projectId, taskId: input.taskId,
      currentMessageId: input.current.messageId, recentTurns: input.recent.turns, memories: [],
      usedUtf8Bytes: Buffer.byteLength(input.current.text) + input.recent.turns.reduce((sum, turn) =>
        sum + turn.messages.reduce((n, message) => n + Buffer.byteLength(message.text), 0), 0),
      hasOlderNativeHistory: input.recent.hasOlder, omittedOlderTurns: 0, omittedMemories: 0 };
  } };
  const service = new WorkbenchService(projects, store, native, false, undefined, assembler);
  const recent = await service.readRecentProjectTurns(project.id, task.id);
  assert.equal(recent.threadId, task.threadId);
  const ready = await service.prepareProjectContext(project.id, task.id,
    { messageId: 'current-1', text: '当前完整请求' }, budget);
  assert.equal(ready.status, 'ready');
  assert.equal(calls, 1);
  const exactCurrent = { messageId: 'exact-budget', text: '当前完整请求' };
  const exactMaximum = budget.fixedOverheadUtf8Bytes + Buffer.byteLength(JSON.stringify({
    current: exactCurrent, recentTurns: recent.turns, memories: [],
  }), 'utf8');
  const realAssembler = new ProjectContextAssembler({ async recall() { return []; } });
  const assembledService = new WorkbenchService(projects, store, native, false, undefined, realAssembler);
  const exactReady = await assembledService.prepareProjectContext(project.id, task.id,
    exactCurrent, { ...budget, maxInputUtf8Bytes: exactMaximum });
  assert.equal(exactReady.status, 'ready');
  if (exactReady.status === 'ready') assert.equal(exactReady.usedUtf8Bytes, exactMaximum);
  const memory = new SqliteProjectMemory(join(root, 'project-memory.sqlite'), { autoProcess: false });
  t.after(() => memory.close());
  await memory.change({ operationId: 'accepted-source', type: 'create', projectId: project.id,
    kind: 'constraint', text: '只核对当前项目', status: 'accepted', branchRef: 'main',
    sources: [{ userInputId: 'confirmed-user-turn', recordedAt: at }] });
  const backedService = new WorkbenchService(projects, store, native, false, memory,
    new ProjectContextAssembler(memory));
  const backedReady = await backedService.prepareProjectContext(project.id, task.id,
    { messageId: 'with-memory', text: '继续核对' }, budget);
  assert.equal(backedReady.status, 'ready');
  if (backedReady.status === 'ready') {
    assert.deepEqual(backedReady.memories.map(item => item.text), ['只核对当前项目']);
    assert.equal(backedReady.recentTurns.at(-1)?.nativeTurnId, 'turn-2');
  }
  const oversizedCurrent = await service.prepareProjectContext(project.id, task.id,
    { messageId: 'huge-current', text: '汉'.repeat(2500) }, budget);
  assert.deepEqual(oversizedCurrent, { status: 'over_budget', reason: 'current_input',
    projectId: project.id, taskId: task.id, currentMessageId: 'huge-current' });
  assert.equal(calls, 1);
  const oversizedNewest = await service.prepareProjectContext(project.id, task.id,
    { messageId: 'newest-too-large', text: '继续' }, { ...budget,
      maxInputUtf8Bytes: 1012, fixedOverheadUtf8Bytes: 1000 });
  assert.equal(oversizedNewest.status, 'over_budget');
  assert.equal(calls, 1);
  await assert.rejects(service.prepareProjectContext(project.id, task.id,
    { messageId: 'current-2', text: '继续' }, { ...budget, providerInstanceId: 'foreign' }),
    code('invalid_request'));
  const omittingNewest = new WorkbenchService(projects, store, native, false, undefined,
    { async assemble(input) { return { status: 'ready' as const, projectId: input.projectId,
      taskId: input.taskId, currentMessageId: input.current.messageId,
      recentTurns: [], memories: [], usedUtf8Bytes: 100,
      hasOlderNativeHistory: input.recent.hasOlder, omittedOlderTurns: 2, omittedMemories: 0 }; } });
  await assert.rejects(omittingNewest.prepareProjectContext(project.id, task.id,
    { messageId: 'current-3', text: '继续' }, budget), code('version_conflict'));
  let reads = 0;
  const movingNative: T3WorkbenchClient = { ...native,
    async threadSnapshot() {
      reads++;
      if (reads === 1) return detail;
      return { ...detail, snapshotSequence: 32, page: { ...detail.page, snapshotSequence: 32 },
        turnMessageBindings: { ...detail.turnMessageBindings, snapshotSequence: 32 } };
    } };
  const changingTask = new WorkbenchService(projects, store, movingNative, false, undefined, assembler);
  await assert.rejects(changingTask.prepareProjectContext(project.id, task.id,
    { messageId: 'current-4', text: '继续' }, budget), code('version_conflict'));
});
