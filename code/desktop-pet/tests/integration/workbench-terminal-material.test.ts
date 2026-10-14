import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import { PROJECT_TERMINAL_EXTRACTION_VERSION } from '../../contracts/project-memory.js';
import { ManagementError } from '../../contracts/management.js';
import type { WorkbenchTaskRef } from '../../contracts/workbench.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';
import { SqliteProjectMemory } from '../../projects/project-memory-sqlite.js';
import { t3TerminalMaterial } from '../../app/terminal-material.js';
import { normalizeProjectRecentTurns } from '../../app/project-context.js';
import { createProjectTerminalExtractor } from '../../projects/project-terminal-extractor.js';
import { t3ShellToTaskEvent } from '../../workbench/t3-read.js';
import type { ProjectTerminalEvidence } from '../../contracts/project-memory.js';

const at = '2026-09-27T00:00:00.000Z';
const project: ProjectEntry = { id: 'local', name: 'Local', abstract: '',
  detailRef: { rootPath: '/registered/project' }, version: 1, updatedAt: at };
const task: Extract<WorkbenchTaskRef, { origin: 't3' }> = {
  id: 'task-1', projectId: project.id, provider: 'codex', origin: 't3',
  environmentId: 'environment-1', t3ProjectId: 'native-project', threadId: 'native-thread',
  providerInstanceId: 'codex',
};
const turn = { turnId: 'turn-1', state: 'completed' as const, completedAt: at,
  assistantMessageId: 'answer-1' };
const shell = { id: task.threadId, projectId: task.t3ProjectId,
  modelSelection: { instanceId: task.providerInstanceId }, branch: null, latestTurn: turn,
  hasPendingApprovals: false, hasPendingUserInput: false };
const projects: ProjectIndexPort = {
  async get(id) { return id === project.id ? project : null; },
  async list() { throw Error('unexpected'); }, async save() { throw Error('unexpected'); },
  async remove() { throw Error('unexpected'); }, async close() {},
};
const message = (id: string, role: string, text: string, streaming = false) =>
  ({ id, role, text, turnId: role === 'user' ? null : turn.turnId, streaming, createdAt: at, updatedAt: at });
const bindings = (nativeTurn = turn) => ({ version: 1, snapshotSequence: 8, threadId: task.threadId,
  projectId: task.t3ProjectId, providerInstanceId: task.providerInstanceId, turns: [{ ...nativeTurn,
    userMessageId: nativeTurn.turnId === turn.turnId ? 'question-1' : 'question-2',
    messageIds: nativeTurn.turnId === turn.turnId ? ['question-1', 'answer-1'] : ['question-2', 'answer-2'] }] });
const detail = () => structuredClone({ turnMessageBindings: bindings(), snapshotSequence: 8, page: {
  snapshotSequence: 8, hasMore: true, beforeCursor: 'older-page' },
thread: { ...shell, messages: [message('question-1', 'user', '请实现 A'),
  message('hidden-1', 'reasoning', 'private thought'),
  message('system-1', 'system', 'private instruction'),
  message('answer-1', 'assistant', '已写出 A；执行结果仍须独立核实')] } });
const error = (code: string) => (value: unknown) => value instanceof ManagementError && value.code === code;

test('persisted exact terminal event delivers once after restart and resolves bounded native text', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wb-terminal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workbenchFile = join(root, 'workbench.sqlite');
  const first = new SqliteWorkbenchStore(workbenchFile);
  first.bindProject(project, task.environmentId,
    { id: task.t3ProjectId, workspaceRoot: '/registered/project' }, '/registered/project');
  first.saveVerifiedTask(task, shell);
  const event = { eventId: 'terminal-event-1', taskId: task.id, sequence: 8,
    phase: 'completed' as const, observedAt: '2026-09-27T08:00:00.169+08:00', nativeTurnId: turn.turnId,
    resultRef: `t3:${task.environmentId}:${task.threadId}:message:${turn.assistantMessageId}`,
    evidence: 'native_read' as const };
  first.recordEvent(event); // Simulates a crash before cross-database enqueue.
  first.close();
  const store = new SqliteWorkbenchStore(workbenchFile);
  t.after(() => store.close());
  const memory = new SqliteProjectMemory(join(root, 'project-memory.sqlite'), { autoProcess: false });
  t.after(async () => memory.close());
  let nativeDetail: unknown = detail();
  let olderPage: unknown = null;
  let nativeEnvironment = task.environmentId;
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: nativeEnvironment }; },
    async shellSnapshot() { return { snapshotSequence: 8, updatedAt: at,
      projects: [{ id: task.t3ProjectId, workspaceRoot: '/registered/project' }], threads: [shell] }; },
    async threadSnapshot(_threadId, _limit, cursor) { return cursor ? olderPage : nativeDetail; },
    async dispatch() { throw Error('dispatch must stay off'); },
    async readReceipt() { return null; },
  };
  const service = new WorkbenchService(projects, store, native, false, memory);
  const [evidence] = store.pendingTerminalEvidence(PROJECT_TERMINAL_EXTRACTION_VERSION);
  assert.ok(evidence);
  assert.equal(evidence.resultRef, event.resultRef);
  assert.equal(await service.recoverTerminalDelivery(), 1);
  assert.equal(await service.recoverTerminalDelivery(), 0);
  assert.deepEqual(store.pendingTerminalEvidence(PROJECT_TERMINAL_EXTRACTION_VERSION), []);
  assert.equal((await memory.listJobs(project.id)).length, 1);
  assert.equal((await memory.listJobs(project.id))[0]?.state, 'queued');
  const queuedEvidence = (await memory.listJobs(project.id))[0]!.evidence;
  assert.equal(queuedEvidence.occurredAt, '2026-09-27T00:00:00.169Z');
  await assert.rejects(service.readTerminalMaterial({ ...queuedEvidence, occurredAt: at }), error('unavailable'));
  const material = await service.readTerminalMaterial(queuedEvidence);
  assert.deepEqual(material.userMessages, [{ id: 'question-1', text: '请实现 A' }]);
  assert.deepEqual(material.assistantMessage,
    { id: 'answer-1', text: '已写出 A；执行结果仍须独立核实' });
  assert.equal(material.source, 't3_thread_detail');
  assert.equal(JSON.stringify(material).includes('private thought'), false);
  assert.equal(JSON.stringify(material).includes('private instruction'), false);
  assert.equal('basis' in material, false);
  const nextTurn = { turnId: 'turn-2', state: 'completed' as const, completedAt: at, assistantMessageId: 'answer-2' };
  nativeDetail = { ...detail(), turnMessageBindings: bindings(nextTurn), thread: { ...detail().thread, latestTurn: nextTurn,
    messages: [{ ...message('question-2', 'user', '接着做 B'), turnId: nextTurn.turnId },
      { ...message('answer-2', 'assistant', 'B 已给出'), turnId: nextTurn.turnId }] } };
  olderPage = { turnMessageBindings: bindings(), snapshotSequence: 8, page: { snapshotSequence: 8, hasMore: false, beforeCursor: null },
    thread: { ...detail().thread, latestTurn: nextTurn, messages: detail().thread.messages } };
  const olderMaterial = await service.readTerminalMaterial(queuedEvidence);
  assert.deepEqual(olderMaterial.userMessages, material.userMessages);
  assert.deepEqual(olderMaterial.assistantMessage, material.assistantMessage);
  olderPage = { ...olderPage as object, thread: { ...detail().thread, latestTurn: nextTurn,
    messages: [message('question-1', 'user', '请实现 A'),
      message('answer-1', 'assistant', '未结束正文', true)] } };
  await assert.rejects(service.readTerminalMaterial(evidence), error('unavailable'));
  olderPage = { turnMessageBindings: bindings(), snapshotSequence: 8, page: { snapshotSequence: 8, hasMore: false, beforeCursor: null },
    thread: { ...detail().thread, latestTurn: nextTurn, messages: detail().thread.messages } };
  olderPage = { ...olderPage as object, snapshotSequence: 9,
    page: { snapshotSequence: 9, hasMore: false, beforeCursor: null } };
  await assert.rejects(service.readTerminalMaterial(evidence), error('unavailable'));
  olderPage = { turnMessageBindings: bindings(), snapshotSequence: 8, page: { snapshotSequence: 8, hasMore: true,
    beforeCursor: 'older-page' }, thread: { ...detail().thread, latestTurn: nextTurn, messages: [] } };
  await assert.rejects(service.readTerminalMaterial(evidence), error('unavailable'));
  nativeDetail = detail();
  nativeDetail = { ...detail(), page: undefined };
  await assert.rejects(service.readTerminalMaterial(evidence), error('unavailable'));
  nativeDetail = { ...detail(), thread: { ...detail().thread,
    messages: [message('question-1', 'user', '请实现 A'), message('answer-1', 'assistant', 'partial', true)] } };
  await assert.rejects(service.readTerminalMaterial(evidence), error('unavailable'));
  nativeDetail = { ...detail(), thread: { ...detail().thread,
    latestTurn: { ...turn, turnId: 'newer-turn' } } };
  assert.deepEqual((await service.readTerminalMaterial(evidence)).userMessages, material.userMessages);
  nativeDetail = { ...detail(), thread: { ...detail().thread,
    latestTurn: { ...turn, assistantMessageId: 'other-answer' } } };
  await assert.rejects(service.readTerminalMaterial(evidence), error('unavailable'));
  nativeDetail = { ...detail(), thread: { ...detail().thread,
    messages: [message('answer-1', 'assistant', '没有用户原话')] } };
  await assert.rejects(service.readTerminalMaterial(evidence), error('unavailable'));
  nativeDetail = detail(); nativeEnvironment = 'another-environment';
  await assert.rejects(service.readTerminalMaterial(evidence), error('version_conflict'));
  await assert.rejects(service.readTerminalMaterial({ ...evidence, projectId: 'other' }), error('unavailable'));
  assert.equal((await memory.listJobs(project.id)).length, 1);
});

test('older native turn reaches the project memory worker as a sourced candidate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wb-terminal-worker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteWorkbenchStore(join(root, 'workbench.sqlite'));
  t.after(() => store.close());
  store.bindProject(project, task.environmentId,
    { id: task.t3ProjectId, workspaceRoot: '/registered/project' }, '/registered/project');
  store.saveVerifiedTask(task, shell);
  const event = { eventId: 'terminal-worker-event', taskId: task.id, sequence: 8,
    phase: 'completed' as const, observedAt: at, nativeTurnId: turn.turnId,
    resultRef: `t3:${task.environmentId}:${task.threadId}:message:${turn.assistantMessageId}`,
    evidence: 'native_read' as const };
  store.recordEvent(event);
  const nextTurn = { turnId: 'turn-2', state: 'completed' as const, completedAt: at, assistantMessageId: 'answer-2' };
  const current = { ...detail(), turnMessageBindings: bindings(nextTurn), thread: { ...detail().thread, latestTurn: nextTurn,
    messages: [{ ...message('question-2', 'user', '接着做 B'), turnId: nextTurn.turnId },
      { ...message('answer-2', 'assistant', 'B 已给出'), turnId: nextTurn.turnId }] } };
  const older = { turnMessageBindings: bindings(), snapshotSequence: 8, page: { snapshotSequence: 8, hasMore: false, beforeCursor: null },
    thread: { ...detail().thread, latestTurn: nextTurn, messages: detail().thread.messages } };
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId: task.environmentId }; },
    async shellSnapshot() { return { snapshotSequence: 8, updatedAt: at,
      projects: [{ id: task.t3ProjectId, workspaceRoot: '/registered/project' }], threads: [shell] }; },
    async threadSnapshot(_threadId, _limit, cursor) { return cursor ? older : current; },
    async dispatch() { throw Error('dispatch must stay off'); },
    async readReceipt() { return null; },
  };
  let service!: WorkbenchService;
  const memory = new SqliteProjectMemory(join(root, 'project-memory.sqlite'), { autoProcess: false,
    extractor: createProjectTerminalExtractor({ readTerminalMaterial: evidence => service.readTerminalMaterial(evidence) },
      async () => ({ outcome: 'proposals', claims: [{ stableKey: 'candidate-a', kind: 'open_question',
        text: '需要复核 A', basis: 'model_suggestion', sourceMessageIds: ['answer-1'] }] })) });
  t.after(async () => memory.close());
  service = new WorkbenchService(projects, store, native, false, memory);
  assert.equal(await service.recoverTerminalDelivery(), 1);
  assert.equal(await memory.runPending(), 1);
  const [item] = await memory.list({ projectId: project.id, limit: 10 });
  assert.equal(item?.status, 'candidate');
  assert.equal(item?.sources[0]?.artifactRef, event.resultRef);
  assert.deepEqual(await memory.recall({ projectId: project.id, limit: 10 }), []);
});

const frozenEvidence = { projectId: task.projectId, taskId: task.id, nativeTurnId: turn.turnId,
  terminalEventId: 'frozen-terminal', terminalPhase: 'completed' as const,
  resultRef: `t3:${task.environmentId}:${task.threadId}:message:answer-1`,
  occurredAt: at, extractionVersion: PROJECT_TERMINAL_EXTRACTION_VERSION };

test('native read fingerprint binds completion time independently of durable observation time', () => {
  const page = detail();
  const observedAt = '2026-09-27T00:00:00.169Z';
  const event = t3ShellToTaskEvent(task, shell, 8, observedAt);
  const evidence = { ...frozenEvidence, terminalEventId: event.eventId, occurredAt: observedAt };
  assert.equal(t3TerminalMaterial(task, evidence, page).material?.userMessages[0]?.id, 'question-1');
  // Both native copies agree, but their changed completion time no longer matches the original event.
  page.thread.latestTurn.completedAt = observedAt;
  page.turnMessageBindings.turns[0]!.completedAt = observedAt;
  assert.throws(() => t3TerminalMaterial(task, evidence, page), error('unavailable'));
});

const realEvidenceDirectory = process.env.T3_REAL_MATERIAL_EVIDENCE;
test('stored actual Codex and DSH HTTP plus original durable jobs resolve without rewriting evidence',
  { skip: !realEvidenceDirectory }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'wb-real-material-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const originalDatabase = join(realEvidenceDirectory!, 'protected-snapshot/data/desktop-pet/workbench.sqlite');
  const copy = join(root, 'workbench.sqlite');
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(originalDatabase + suffix)) copyFileSync(originalDatabase + suffix, copy + suffix);
  }
  const store = new SqliteWorkbenchStore(copy);
  t.after(() => store.close());
  const preflight = JSON.parse(readFileSync(join(realEvidenceDirectory!, 'preflight.json'), 'utf8')) as {
    jobs: { evidence_json: string }[] };
  for (const provider of ['codex', 'dsh']) {
    const rawFile = join(realEvidenceDirectory!, `raw-${provider}.json`);
    const originalBytes = readFileSync(rawFile);
    const raw = JSON.parse(originalBytes.toString()) as { task: Extract<WorkbenchTaskRef, { origin: 't3' }>;
      native: ReturnType<typeof detail> };
    const ref = raw.task;
    const evidence = preflight.jobs.map(job => JSON.parse(job.evidence_json) as ProjectTerminalEvidence)
      .find(job => job.taskId === ref.id)!;
    assert.ok(evidence);
    const binding = store.getProjectBinding(ref.projectId, ref.environmentId, ref.t3ProjectId)!;
    let page = structuredClone(raw.native);
    const native: T3WorkbenchClient = {
      async environmentDescriptor() { return { environmentId: ref.environmentId }; },
      async shellSnapshot() { return { snapshotSequence: page.snapshotSequence, updatedAt: evidence.occurredAt,
        projects: [{ id: ref.t3ProjectId, workspaceRoot: binding.workspaceRoot }], threads: [page.thread] }; },
      async threadSnapshot() { return page; },
      async dispatch() { throw Error('Stored read regression must never dispatch'); },
    };
    const service = new WorkbenchService(projects, store, native, false);
    const material = await service.readTerminalMaterial(evidence);
    const recent = await service.readRecentProjectTurns(ref.projectId, ref.id);
    const user = page.thread.messages.find(m => m.id === material.userMessages[0]?.id)!;
    assert.equal(user.turnId, null);
    assert.equal(material.userMessages[0]?.text, user.text);
    assert.equal(recent.turns.length, 1);
    assert.equal(recent.turns[0]?.messages[0]?.id, user.id);
    assert.equal(material.evidence.occurredAt, evidence.occurredAt);
    assert.equal(store.hasTerminalEvidence(evidence), true);
    const driftedObservation = new Date(Date.parse(evidence.occurredAt) + 1).toISOString();
    await assert.rejects(service.readTerminalMaterial({ ...evidence, occurredAt: driftedObservation }), error('unavailable'));
    page.thread.latestTurn.completedAt = driftedObservation;
    page.turnMessageBindings.turns[0]!.completedAt = driftedObservation;
    await assert.rejects(service.readTerminalMaterial(evidence), error('unavailable'));
    page = structuredClone(raw.native);
    page.turnMessageBindings.snapshotSequence++;
    await assert.rejects(service.readTerminalMaterial(evidence), error('unavailable'));
    assert.deepEqual(readFileSync(rawFile), originalBytes);
  }
});

test('Codex and DSH real projection shape preserves null user turnId and complete source', () => {
  for (const provider of ['codex', 'dsh'] as const) {
    const ref = { ...task, provider, providerInstanceId: provider };
    const page = detail(); page.thread.modelSelection.instanceId = provider;
    page.turnMessageBindings.providerInstanceId = provider;
    const original = JSON.stringify(page);
    const material = t3TerminalMaterial(ref, frozenEvidence, page).material!;
    assert.deepEqual(material.userMessages, [{ id: 'question-1', text: '请实现 A' }]);
    assert.equal(material.assistantMessage?.id, 'answer-1');
    assert.equal(normalizeProjectRecentTurns(ref, page).turns[0]?.messages[0]?.id, 'question-1');
    assert.equal(JSON.stringify(page), original);
    assert.equal(page.thread.messages[0]?.turnId, null);
  }
});

test('missing, conflicting, incomplete and foreign native bindings cannot enter either reader', async t => {
  const mutations: [string, (page: any) => void][] = [
    ['old server', p => delete p.turnMessageBindings],
    ['unknown version', p => p.turnMessageBindings.version = 2],
    ['other snapshot', p => p.turnMessageBindings.snapshotSequence++],
    ['other thread', p => p.turnMessageBindings.threadId = 'foreign'],
    ['other project', p => p.turnMessageBindings.projectId = 'foreign'],
    ['other provider', p => p.turnMessageBindings.providerInstanceId = 'foreign'],
    ['missing user', p => p.turnMessageBindings.turns[0].userMessageId = 'absent'],
    ['wrong assistant', p => p.turnMessageBindings.turns[0].assistantMessageId = 'question-1'],
    ['duplicate turn', p => p.turnMessageBindings.turns.push(p.turnMessageBindings.turns[0])],
    ['duplicate ownership', p => p.turnMessageBindings.turns[0].messageIds.push('question-1')],
    ['missing body across page', p => p.thread.messages = p.thread.messages.filter((m: any) => m.id !== 'question-1')],
    ['missing final source', p => p.turnMessageBindings.turns[0].messageIds = ['question-1']],
    ['cross turn user', p => p.thread.messages[0].turnId = 'different-turn'],
    ['cross turn assistant', p => p.thread.messages.at(-1).turnId = 'different-turn'],
    ['missing turn metadata', p => p.turnMessageBindings.turns = []],
    ['unlisted steering message', p => p.thread.messages.push({ ...message('steered','user','extra'), turnId: turn.turnId })],
    ['streaming user', p => p.thread.messages[0].streaming = true],
    ['missing terminal time', p => p.turnMessageBindings.turns[0].completedAt = null],
    ['latest state conflicts with binding', p => p.thread.latestTurn.state = 'running'],
    ['latest assistant conflicts with binding', p => p.thread.latestTurn.assistantMessageId = 'foreign'],
    ['too many messages', p => p.thread.messages = Array.from({length:2001}, (_,i) => message('stray-'+i,'user','text'))],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    const page = structuredClone(detail()); mutate(page);
    assert.throws(() => t3TerminalMaterial(task, frozenEvidence, page), error('unavailable'));
    assert.throws(() => normalizeProjectRecentTurns(task, page), error('unavailable'));
  });
});

test('exact failed/cancelled turns retain original input and exclude partial assistant from extraction', () => {
  for (const [state, phase] of [['error', 'failed'], ['interrupted', 'cancelled']] as const) {
    const page: any = detail(); page.thread.latestTurn.state = state;
    page.turnMessageBindings.turns[0].state = state;
    const { resultRef: _resultRef, ...original } = frozenEvidence;
    const evidence = { ...original, terminalPhase: phase };
    const material = t3TerminalMaterial(task, evidence, page).material!;
    assert.equal(material.userMessages[0]?.id, 'question-1');
    assert.equal(material.assistantMessage, undefined);
    assert.throws(() => t3TerminalMaterial(task, frozenEvidence, page), error('unavailable'));
  }
});

test('stray null-turn messages remain unassigned even at the same time and nearest position', () => {
  const page = detail(); page.thread.messages.unshift(message('stray', 'user', 'cannot borrow this'));
  const material = t3TerminalMaterial(task, frozenEvidence, page).material!;
  assert.deepEqual(material.userMessages.map(m => m.id), ['question-1']);
  assert.deepEqual(normalizeProjectRecentTurns(task, page).turns[0]?.messages.map(m => m.id), ['question-1','answer-1']);
  const missing = structuredClone(page); missing.thread.messages = missing.thread.messages.filter(m => m.id !== 'question-1');
  assert.throws(() => t3TerminalMaterial(task, frozenEvidence, missing), error('unavailable'));
});

test('old turn completion time must match the frozen native read-event fingerprint', () => {
  const evidence = { ...frozenEvidence, terminalEventId: t3ShellToTaskEvent(task, shell, 8, at).eventId };
  const page: any = detail(); page.thread.latestTurn = { ...turn, turnId: 'newer-turn' };
  page.turnMessageBindings.turns[0].completedAt = '2026-09-28T00:00:00.000Z';
  assert.throws(() => t3TerminalMaterial(task, evidence, page), error('unavailable'));
});
