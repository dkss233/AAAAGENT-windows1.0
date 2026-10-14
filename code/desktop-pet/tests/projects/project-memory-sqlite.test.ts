import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { ProjectMemoryChange, ProjectMemorySource, ProjectTerminalEvidence } from '../../contracts/project-memory.js';
import { ManagementError } from '../../contracts/management.js';
import { SqliteProjectMemory, type ProjectMemoryProposal } from '../../projects/project-memory-sqlite.js';

const NOW = '2026-09-25T00:00:00.000Z';
const userSource = (id = 'input-1'): ProjectMemorySource => ({ userInputId: id, recordedAt: NOW });
const terminal: ProjectTerminalEvidence = {
  projectId: 'project-a', taskId: 'task-1', nativeTurnId: 'turn-1', terminalEventId: 'event-1',
  terminalPhase: 'completed', resultRef: 'artifact:result-1', occurredAt: NOW, extractionVersion: 'v1',
};
const terminalSource = (): ProjectMemorySource => ({
  taskId: terminal.taskId, nativeTurnId: terminal.nativeTurnId,
  terminalEventId: terminal.terminalEventId, artifactRef: terminal.resultRef!, recordedAt: NOW,
});
const candidate = (overrides: Partial<ProjectMemoryProposal> = {}): ProjectMemoryProposal => ({
  stableKey: 'claim-1', kind: 'fact', text: '合成建议：A 项目完成了构建',
  sources: [terminalSource()], basis: 'model_suggestion', ...overrides,
});
const digest = (filename: string) => createHash('sha256').update(readFileSync(filename)).digest('hex');
const error = (code: string) => (value: unknown) => value instanceof ManagementError && value.code === code;

function fixture(t: TestContext) {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../artifacts/W3/recall-rank-54/tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'case-')), filename = join(root, 'project-memory.sqlite');
  const stores: SqliteProjectMemory[] = [];
  const open = (options: ConstructorParameters<typeof SqliteProjectMemory>[1] = {}) => {
    const store = new SqliteProjectMemory(filename, options); stores.push(store); return store;
  };
  t.after(async () => { for (const store of stores) await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, filename, open };
}

test('separate SQLite identity, permissions, restart persistence and foreign-file refusal', async t => {
  const f = fixture(t), companion = join(f.root, 'companion.sqlite'), index = join(f.root, 'project-index.sqlite');
  for (const [filename, appId] of [[companion, 0x50455432], [index, 0x50524a31]] as const) {
    const db = new Database(filename); db.pragma(`application_id = ${appId}`);
    db.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('private synthetic data')"); db.close();
  }
  const original = [digest(companion), digest(index)];
  const store = f.open({ autoProcess: false });
  assert.equal(statSync(f.filename).mode & 0o777, 0o600);
  const created = await store.change({ operationId: 'op-1', type: 'create', projectId: 'project-a', kind: 'decision',
    text: '用户确定保留本地项目记忆', status: 'accepted', sources: [userSource()] });
  assert.equal(created.state, 'applied');
  await store.close();
  const reopened = f.open({ autoProcess: false });
  assert.deepEqual(await reopened.get('project-a', created.item!.id), created.item);
  assert.deepEqual([digest(companion), digest(index)], original);
  assert.throws(() => new SqliteProjectMemory(companion), error('invalid_request'));
  assert.throws(() => new SqliteProjectMemory(index), error('invalid_request'));
  const alias = join(f.root, 'alias.sqlite'); symlinkSync(f.filename, alias);
  assert.throws(() => new SqliteProjectMemory(alias), error('invalid_request'));
  const foreign = join(f.root, 'foreign.sqlite'), db = new Database(foreign);
  db.pragma('application_id = 1346720818'); db.exec('CREATE TABLE private_data(value TEXT)'); db.close();
  const before = digest(foreign), names = readdirSync(f.root);
  assert.throws(() => new SqliteProjectMemory(foreign), error('invalid_request'));
  assert.equal(digest(foreign), before); assert.deepEqual(readdirSync(f.root), names);
  const incomplete = join(f.root, 'incomplete.sqlite'), partial = new Database(incomplete);
  partial.pragma('application_id = 1347243313'); partial.pragma('user_version = 1');
  partial.exec('CREATE TABLE unrelated(value TEXT)'); partial.close();
  const incompleteHash = digest(incomplete);
  assert.throws(() => new SqliteProjectMemory(incomplete), error('invalid_request'));
  assert.equal(digest(incomplete), incompleteHash);
});

test('list and recall isolate project, preserve branch and condition, and exclude candidates by default', async t => {
  const store = fixture(t).open({ autoProcess: false });
  const create = async (operationId: string, projectId: string, text: string, branchRef?: string) => store.change({
    operationId, type: 'create', projectId, kind: 'constraint', text, status: 'accepted',
    sources: [userSource(operationId)], ...(branchRef ? { branchRef, condition: '只适用于当前实验分支' } : {}),
  });
  const a = await create('op-a', 'project-a', '相同项目原则');
  await create('op-b', 'project-b', '隔离知识');
  await create('op-c', 'project-a', '实验分支规则', 'branch/experiment');
  await store.change({ operationId: 'op-d', type: 'create', projectId: 'project-a', kind: 'open_question',
    text: '模型尚待确认的建议', status: 'candidate', sources: [userSource('source-d')] });
  assert.deepEqual((await store.recall({ projectId: 'project-a', limit: 10 })).map(row => row.text), ['相同项目原则']);
  const branch = await store.recall({ projectId: 'project-a', branchRef: 'branch/experiment', limit: 10 });
  assert.deepEqual(new Set(branch.map(row => row.text)), new Set(['相同项目原则', '实验分支规则']));
  assert.equal(branch.find(row => row.branchRef)?.condition, '只适用于当前实验分支');
  assert.equal((await store.list({ projectId: 'project-a', limit: 10 })).length, 3);
  assert.deepEqual((await store.recall({ projectId: 'project-b', limit: 10 })).map(row => row.text), ['隔离知识']);
  assert.equal((await store.recall({ projectId: 'project-a', includeCandidates: true, limit: 10 })).length, 2);
  assert.deepEqual(await store.recall({ projectId: 'project-a', text: "%' OR 1=1 --", limit: 10 }), []);
  assert.equal(await store.get('project-b', a.item!.id), null);
});

test('ranked recall considers the older 101st accepted row before limit and survives reopen', async t => {
  const f = fixture(t);
  let tick = 0;
  const store = f.open({ autoProcess: false, now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, tick++)).toISOString() });
  const old = await store.change({ operationId: 'old-relevant', type: 'create', projectId: 'project-a',
    kind: 'decision', text: '遗忘曲率调整依据', status: 'accepted', sources: [userSource('old-source')],
    branchRef: 'branch/main', condition: '仅当前方案' });
  for (let index = 0; index < 100; index++) await store.change({ operationId: `new-${index}`,
    type: 'create', projectId: 'project-a', kind: 'fact', text: `构建设置 ${index}`,
    status: 'accepted', sources: [userSource(`new-source-${index}`)] });
  const excluded = await store.change({ operationId: 'candidate', type: 'create', projectId: 'project-a',
    kind: 'fact', text: '遗忘曲率候选', status: 'candidate', sources: [userSource('candidate')] });
  const withdrawn = await store.change({ operationId: 'withdrawn', type: 'create', projectId: 'project-a',
    kind: 'fact', text: '遗忘曲率已撤回', status: 'accepted', sources: [userSource('withdrawn')] });
  await store.change({ operationId: 'withdraw-old', type: 'withdraw', projectId: 'project-a',
    id: withdrawn.item!.id, expectedVersion: 1 });
  const superseded = await store.change({ operationId: 'superseded', type: 'create', projectId: 'project-a',
    kind: 'fact', text: '遗忘曲率被替代', status: 'accepted', sources: [userSource('superseded')] });
  const raw = new Database(f.filename);
  raw.prepare('UPDATE project_memory_items SET superseded_by_id=? WHERE id=?')
    .run(old.item!.id, superseded.item!.id);
  raw.close();
  await store.change({ operationId: 'foreign-branch', type: 'create', projectId: 'project-a',
    kind: 'fact', text: '遗忘曲率其他分支', status: 'accepted', sources: [userSource('other-branch')],
    branchRef: 'branch/other' });
  await store.change({ operationId: 'foreign-project', type: 'create', projectId: 'project-b',
    kind: 'fact', text: '遗忘曲率其他项目', status: 'accepted', sources: [userSource('other-project')] });
  const legacy = await store.recall({ projectId: 'project-a', branchRef: 'branch/main', limit: 100 });
  assert.equal(legacy.length, 100);
  assert.ok(!legacy.some(row => row.id === old.item!.id));
  const request = { projectId: 'project-a', branchRef: 'branch/main', limit: 3,
    relevance: { currentText: '请调整遗忘曲率', newestUserText: '继续这个项目' } } as const;
  const ranked = await store.recall(request);
  assert.equal(ranked[0]?.id, old.item?.id);
  assert.equal(ranked[0]?.condition, '仅当前方案');
  assert.equal(ranked[0]?.version, 1);
  assert.deepEqual(ranked[0]?.sources, old.item?.sources);
  assert.ok(!ranked.some(row => row.id === excluded.item!.id));
  assert.ok(!ranked.some(row => row.id === withdrawn.item!.id || row.id === superseded.item!.id));
  assert.ok(ranked.every(row => row.projectId === 'project-a' &&
    (!row.branchRef || row.branchRef === 'branch/main')));
  assert.deepEqual(ranked.slice(1).map(row => row.id), legacy
    .filter(row => row.id !== superseded.item!.id).slice(0, 2).map(row => row.id));
  assert.deepEqual((await store.recall({ ...request, text: '遗忘曲率' })).map(row => row.id), [old.item!.id]);
  await store.close();
  const reopened = f.open({ autoProcess: false });
  assert.deepEqual(await reopened.recall(request), ranked);
});

test('ranked recall uses stable ID order when relevance and update time tie', async t => {
  const store = fixture(t).open({ autoProcess: false, now: () => NOW });
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const created = await store.change({ operationId: `tie-${index}`, type: 'create', projectId: 'project-a',
      kind: 'fact', text: '遗忘曲率', status: 'accepted', sources: [userSource(`tie-${index}`)] });
    ids.push(created.item!.id);
  }
  const rows = await store.recall({ projectId: 'project-a', limit: 3,
    relevance: { currentText: '遗忘曲率', newestUserText: '' } });
  assert.deepEqual(rows.map(row => row.id), ids.sort());
});

test('manual create, edit, accept and withdraw enforce provenance, version and operation replay', async t => {
  const f = fixture(t), a = f.open({ autoProcess: false }), b = f.open({ autoProcess: false });
  const input: ProjectMemoryChange = { operationId: 'create-1', type: 'create', projectId: 'project-a', kind: 'decision',
    text: '候选方案', status: 'candidate', sources: [userSource()] };
  const first = await a.change(input);
  assert.deepEqual(await b.change(input), first);
  assert.deepEqual(await b.change({ sources: [userSource()], text: '候选方案', kind: 'decision', status: 'candidate',
    projectId: 'project-a', type: 'create', operationId: 'create-1' }), first);
  await assert.rejects(a.change({ ...input, text: '重用同一编号' }), error('invalid_request'));
  assert.equal((await a.change({ ...input, operationId: 'bad-promote', status: 'accepted', sources: [terminalSource()] })).state, 'rejected');
  const accepted = await b.change({ operationId: 'accept-1', type: 'accept', projectId: 'project-a',
    id: first.item!.id, expectedVersion: 1, source: userSource('accept-input') });
  assert.equal(accepted.item?.status, 'accepted');
  const stale = await a.change({ operationId: 'edit-stale', type: 'edit', projectId: 'project-a',
    id: first.item!.id, expectedVersion: 1, text: '旧覆盖', source: userSource('edit-input') });
  assert.equal(stale.state, 'conflict'); assert.equal(stale.item?.version, 2);
  const edited = await a.change({ operationId: 'edit-fresh', type: 'edit', projectId: 'project-a',
    id: first.item!.id, expectedVersion: 2, text: '用户修订后的方案', source: userSource('edit-input') });
  assert.equal(edited.item?.text, '用户修订后的方案'); assert.equal(edited.item?.sources.length, 3);
  const withdrawn = await b.change({ operationId: 'withdraw-1', type: 'withdraw', projectId: 'project-a',
    id: first.item!.id, expectedVersion: 3 });
  assert.equal(withdrawn.item?.status, 'withdrawn');
  assert.deepEqual(await a.recall({ projectId: 'project-a', limit: 10 }), []);
  assert.equal((await a.change({ operationId: 'revive', type: 'accept', projectId: 'project-a',
    id: first.item!.id, expectedVersion: 4, source: userSource('new') })).detail, 'withdrawn_is_final');
});

test('metadata edit atomically changes kind, scope and source while preserving accepted status', async t => {
  const store = fixture(t).open({ autoProcess: false });
  const created = await store.change({ operationId: 'metadata-create', type: 'create', projectId: 'project-a',
    kind: 'fact', text: '旧正文', status: 'accepted', sources: [userSource('create-input')],
    branchRef: 'branch/old', condition: '旧条件' });
  const id = created.item!.id;
  const edited = await store.change({ operationId: 'metadata-edit', type: 'edit', projectId: 'project-a',
    id, expectedVersion: 1, text: '新正文', kind: 'constraint', branchRef: 'branch/new',
    condition: '只适用于新分支', source: userSource('edit-input') });
  assert.equal(edited.state, 'applied');
  assert.deepEqual({ kind: edited.item?.kind, text: edited.item?.text, branchRef: edited.item?.branchRef,
    condition: edited.item?.condition, status: edited.item?.status, version: edited.item?.version },
  { kind: 'constraint', text: '新正文', branchRef: 'branch/new', condition: '只适用于新分支', status: 'accepted', version: 2 });
  assert.deepEqual(edited.item?.sources, [userSource('create-input'), userSource('edit-input')]);
  assert.deepEqual(await store.recall({ projectId: 'project-a', branchRef: 'branch/old', limit: 10 }), []);
  assert.equal((await store.recall({ projectId: 'project-a', branchRef: 'branch/new', limit: 10 }))[0]?.text, '新正文');
  assert.deepEqual(await store.recall({ projectId: 'project-a', limit: 10 }), []);
});

test('omitted scope preserves values, null clears values, and replay after restart does not write twice', async t => {
  const f = fixture(t), before = f.open({ autoProcess: false });
  const created = await before.change({ operationId: 'scope-create', type: 'create', projectId: 'project-a',
    kind: 'decision', text: '原文', status: 'candidate', sources: [userSource('create')],
    branchRef: 'branch/only', condition: '仅在条件满足时' });
  const id = created.item!.id;
  const omitted = await before.change({ operationId: 'scope-keep', type: 'edit', projectId: 'project-a',
    id, expectedVersion: 1, text: '第一次修订', source: userSource('edit-1') });
  assert.equal(omitted.item?.kind, 'decision');
  assert.equal(omitted.item?.branchRef, 'branch/only');
  assert.equal(omitted.item?.condition, '仅在条件满足时');
  assert.equal(omitted.item?.status, 'candidate');
  const clear = { operationId: 'scope-clear', type: 'edit', projectId: 'project-a', id,
    expectedVersion: 2, text: '第二次修订', branchRef: null, condition: null, source: userSource('edit-2') } as const;
  const cleared = await before.change(clear);
  assert.equal(cleared.state, 'applied'); assert.equal(cleared.item?.version, 3);
  assert.equal(cleared.item?.branchRef, undefined); assert.equal(cleared.item?.condition, undefined);
  assert.equal((await before.recall({ projectId: 'project-a', includeCandidates: true, limit: 10 }))[0]?.id, id);
  await before.close();
  const reopened = f.open({ autoProcess: false });
  assert.deepEqual(await reopened.change(clear), cleared);
  assert.equal((await reopened.get('project-a', id))?.version, 3);
  assert.deepEqual((await reopened.get('project-a', id))?.sources,
    [userSource('create'), userSource('edit-1'), userSource('edit-2')]);
});

test('invalid metadata edit rolls back all fields and does not reserve the operation ID', async t => {
  const store = fixture(t).open({ autoProcess: false });
  const created = await store.change({ operationId: 'invalid-create', type: 'create', projectId: 'project-a',
    kind: 'fact', text: '保持原文', status: 'accepted', sources: [userSource('create')],
    branchRef: 'branch/stable', condition: '条件保持' });
  const original = created.item!, base = { type: 'edit', projectId: 'project-a', id: original.id,
    expectedVersion: 1, text: '不得部分写入', source: userSource('edit') } as const;
  for (const invalid of [
    { kind: 'unknown-kind' }, { branchRef: '' }, { branchRef: '字'.repeat(251) },
    { condition: '' }, { condition: '字'.repeat(501) }, { kind: null },
  ]) {
    await assert.rejects(store.change({ ...base, operationId: 'invalid-operation', ...invalid } as ProjectMemoryChange), error('invalid_request'));
    assert.deepEqual(await store.get('project-a', original.id), original);
  }
  const fixed = await store.change({ ...base, operationId: 'invalid-operation', kind: 'constraint' });
  assert.equal(fixed.state, 'applied'); assert.equal(fixed.item?.version, 2);
});

test('concurrent metadata editors conflict and withdrawal blocks later edits and extraction', async t => {
  const f = fixture(t), a = f.open({ autoProcess: false, extractor: async event => [candidate({
    stableKey: event.extractionVersion === 'v1' ? 'claim-1' : 'changed-key',
  })] }), b = f.open({ autoProcess: false });
  await a.enqueueTerminal(terminal); await a.runPending();
  const created = (await a.list({ projectId: 'project-a', limit: 10 }))[0]!;
  const accepted = await a.change({ operationId: 'concurrent-edit', type: 'edit', projectId: 'project-a',
    id: created.id, expectedVersion: 1, text: '用户修正', kind: 'decision', branchRef: 'branch/a',
    source: userSource('edit') });
  assert.equal(accepted.item?.version, 2);
  const conflict = await b.change({ operationId: 'stale-metadata-edit', type: 'edit', projectId: 'project-a',
    id: created.id, expectedVersion: 1, text: '并发旧值', kind: 'open_question', branchRef: 'branch/b',
    source: userSource('stale') });
  assert.equal(conflict.state, 'conflict'); assert.deepEqual(conflict.item, accepted.item);
  const withdrawn = await b.change({ operationId: 'concurrent-withdraw', type: 'withdraw', projectId: 'project-a',
    id: created.id, expectedVersion: 2 });
  assert.equal(withdrawn.item?.status, 'withdrawn');
  assert.equal((await a.change({ operationId: 'edit-after-withdraw', type: 'edit', projectId: 'project-a',
    id: created.id, expectedVersion: 3, text: '不能复活', branchRef: null, source: userSource('late') })).detail, 'withdrawn_is_final');
  await a.enqueueTerminal({ ...terminal, extractionVersion: 'v2' }); await a.runPending();
  assert.equal((await a.list({ projectId: 'project-a', limit: 10 })).length, 1);
  assert.deepEqual(await a.recall({ projectId: 'project-a', branchRef: 'branch/a', includeCandidates: true, limit: 10 }), []);
});

test('two provider adapters reading the same project see the same version without accessing another project', async t => {
  const f = fixture(t), codex = f.open({ autoProcess: false }), dsh = f.open({ autoProcess: false });
  const saved = await codex.change({ operationId: 'shared-1', type: 'create', projectId: 'project-a',
    kind: 'constraint', text: '本项目的合成接口约束', status: 'accepted', sources: [userSource()] });
  assert.deepEqual((await dsh.recall({ projectId: 'project-a', limit: 10 }))[0], saved.item);
  assert.deepEqual(await dsh.recall({ projectId: 'project-b', limit: 10 }), []);
  assert.equal(await dsh.get('project-b', saved.item!.id), null);
});

test('terminal enqueue is durable and returns before extraction; duplicate events identify one job', async t => {
  const f = fixture(t);
  let release!: (rows: ProjectMemoryProposal[]) => void;
  const gate = new Promise<readonly ProjectMemoryProposal[]>(resolve => { release = resolve; });
  const store = f.open({ autoProcess: false, extractor: async () => gate });
  const queued = await store.enqueueTerminal(terminal);
  assert.equal(queued.state, 'queued');
  assert.deepEqual(await store.enqueueTerminal(terminal), { jobId: queued.jobId, state: 'already_queued' });
  await assert.rejects(store.enqueueTerminal({ ...terminal, terminalPhase: 'failed' }), error('invalid_request'));
  const draining = store.runPending();
  assert.equal((await store.getJob('project-a', queued.jobId))?.state, 'running');
  const secondReader = f.open({ autoProcess: false });
  assert.equal((await secondReader.getJob('project-a', queued.jobId))?.state, 'running');
  assert.deepEqual(await store.recall({ projectId: 'project-a', limit: 10 }), []);
  release([candidate()]);
  assert.equal(await draining, 1);
  assert.equal((await store.getJob('project-a', queued.jobId))?.state, 'done');
  assert.equal((await store.getJob('project-b', queued.jobId)), null);
  assert.equal((await store.list({ projectId: 'project-a', limit: 10 }))[0]?.status, 'candidate');
  assert.equal((await store.recall({ projectId: 'project-a', limit: 10 })).length, 0);
});

test('equivalent ISO event times normalize to one durable terminal identity', async t => {
  const store = fixture(t).open({ autoProcess: false });
  const first = await store.enqueueTerminal({ ...terminal, occurredAt: '2026-09-25T08:00:00+08:00' });
  assert.equal(first.state, 'queued');
  assert.deepEqual(await store.enqueueTerminal(terminal), { jobId: first.jobId, state: 'already_queued' });
  assert.equal((await store.getJob('project-a', first.jobId))?.evidence.occurredAt, NOW);
});

test('automatic worker begins after enqueue returns and keeps the task result independent', async t => {
  const f = fixture(t);
  let started!: () => void, release!: (rows: ProjectMemoryProposal[]) => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<readonly ProjectMemoryProposal[]>(resolve => { release = resolve; });
  const store = f.open({ extractor: async () => { started(); return gate; } });
  const queued = await store.enqueueTerminal({ ...terminal, taskId: 'task/native-1' });
  assert.equal(queued.state, 'queued');
  await began;
  assert.equal((await store.getJob('project-a', queued.jobId))?.state, 'running');
  assert.deepEqual(await store.recall({ projectId: 'project-a', limit: 10 }), []);
  release([]);
  for (let i = 0; i < 100 && (await store.getJob('project-a', queued.jobId))?.state !== 'done'; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await store.getJob('project-a', queued.jobId))?.state, 'done');
});

test('failed extraction is visible and retryable without changing engineering result or leaking errors', async t => {
  const f = fixture(t); let attempts = 0;
  const store = f.open({ autoProcess: false, verifyExecution: () => true, extractor: async () => {
    attempts++;
    if (attempts === 1) throw new Error('secret token and full private transcript');
    return [candidate({ basis: 'verified_execution' })];
  } });
  const queued = await store.enqueueTerminal(terminal);
  assert.equal(await store.runPending(), 1);
  const failed = (await store.getJob('project-a', queued.jobId))!;
  assert.equal(failed.state, 'failed'); assert.equal(failed.errorCode, 'extraction_failed');
  assert.equal(failed.attempts, 1);
  assert.equal(JSON.stringify(failed).includes('secret token'), false);
  assert.deepEqual(await store.recall({ projectId: 'project-a', limit: 10 }), []);
  assert.equal((await store.retryJob('project-a', queued.jobId)).state, 'queued');
  assert.equal(await store.runPending(), 1);
  assert.equal((await store.getJob('project-a', queued.jobId))?.state, 'done');
  assert.equal((await store.recall({ projectId: 'project-a', limit: 10 }))[0]?.status, 'accepted');
});

test('later extraction version cannot revive withdrawn or overwrite edited claim', async t => {
  const f = fixture(t), store = f.open({ autoProcess: false, extractor: async evidence => [
    candidate({ stableKey: evidence.extractionVersion === 'v1' ? 'claim-1' : 'new-extractor-key' }),
  ] });
  await store.enqueueTerminal(terminal); await store.runPending();
  const original = (await store.list({ projectId: 'project-a', limit: 10 }))[0]!;
  assert.equal((await store.change({ operationId: 'withdraw', type: 'withdraw', projectId: 'project-a',
    id: original.id, expectedVersion: 1 })).state, 'applied');
  await store.enqueueTerminal({ ...terminal, extractionVersion: 'v2' }); await store.runPending();
  const after = (await store.get('project-a', original.id))!;
  assert.equal(after.status, 'withdrawn'); assert.equal(after.version, 2);
  assert.equal((await store.list({ projectId: 'project-a', limit: 10 })).length, 1);
  assert.deepEqual(await store.recall({ projectId: 'project-a', includeCandidates: true, limit: 10 }), []);
});

test('crash-like running job becomes retryable on reopen while older data and files remain intact', async t => {
  const f = fixture(t), first = f.open({ autoProcess: false });
  const queued = await first.enqueueTerminal(terminal);
  const db = new Database(f.filename);
  db.prepare("UPDATE project_memory_jobs SET state='running',attempts=1 WHERE id=?").run(queued.jobId); db.close();
  await first.close();
  const reopened = f.open({ autoProcess: false, extractor: async () => [candidate()] });
  assert.equal((await reopened.getJob('project-a', queued.jobId))?.state, 'running');
  assert.equal(await reopened.recoverInterruptedJobs(), 1);
  const interrupted = (await reopened.getJob('project-a', queued.jobId))!;
  assert.equal(interrupted.state, 'failed'); assert.equal(interrupted.errorCode, 'interrupted');
  await reopened.retryJob('project-a', queued.jobId); await reopened.runPending();
  assert.equal((await reopened.getJob('project-a', queued.jobId))?.state, 'done');
  assert.equal((await reopened.list({ projectId: 'project-a', limit: 10 })).length, 1);
});

test('queued work survives restart and completes after an extractor is attached', async t => {
  const f = fixture(t), before = f.open({ autoProcess: false });
  const queued = await before.enqueueTerminal(terminal);
  await before.close();
  const after = f.open({ autoProcess: false, extractor: async () => [candidate()] });
  assert.equal((await after.getJob('project-a', queued.jobId))?.state, 'queued');
  assert.equal(await after.runPending(), 1);
  assert.equal((await after.getJob('project-a', queued.jobId))?.state, 'done');
  assert.equal((await after.list({ projectId: 'project-a', limit: 10 })).length, 1);
});

test('worker starts only after bootstrap recovery has marked interrupted jobs', async t => {
  const f = fixture(t), first = f.open({ autoProcess: false });
  const interrupted = await first.enqueueTerminal(terminal);
  const queued = await first.enqueueTerminal({ ...terminal, terminalEventId: 'event-2' });
  const db = new Database(f.filename);
  db.prepare("UPDATE project_memory_jobs SET state='running' WHERE id=?").run(interrupted.jobId); db.close();
  await first.close();
  let processed = 0;
  const after = f.open({ autoProcess: false, extractor: async () => {
    processed++; return [candidate({ sources: [{ ...terminalSource(), terminalEventId: 'event-2' }] })];
  } });
  assert.equal(processed, 0);
  assert.equal(await after.recoverInterruptedJobs(), 1);
  after.startProcessing();
  await after.runPending();
  assert.equal((await after.getJob('project-a', interrupted.jobId))?.state, 'failed');
  assert.equal((await after.getJob('project-a', interrupted.jobId))?.errorCode, 'interrupted');
  assert.equal((await after.getJob('project-a', queued.jobId))?.state, 'done');
  assert.equal(processed, 1);
});

test('bad proposal rolls back the whole extraction and never turns an unverified suggestion into accepted fact', async t => {
  const f = fixture(t), store = f.open({ autoProcess: false, extractor: async () => [
    candidate({ stableKey: 'valid', basis: 'verified_execution' }),
    candidate({ stableKey: 'bad', sources: [userSource()] }),
  ] });
  const queued = await store.enqueueTerminal(terminal); await store.runPending();
  assert.equal((await store.getJob('project-a', queued.jobId))?.state, 'failed');
  assert.deepEqual(await store.list({ projectId: 'project-a', limit: 10 }), []);
  const other = f.open({ autoProcess: false, extractor: async () => [
    candidate({ stableKey: 'claimed-fact', basis: 'verified_execution' }),
  ] });
  const next = { ...terminal, extractionVersion: 'v2' };
  await other.enqueueTerminal(next); await other.runPending();
  assert.equal((await other.list({ projectId: 'project-a', limit: 10 }))[0]?.status, 'candidate');
});

test('extracted user decision needs a separate trusted check before promotion', async t => {
  const f = fixture(t), proposed = candidate({ stableKey: 'user-decision', basis: 'explicit_user',
    kind: 'decision', sources: [terminalSource(), userSource('confirmed-input')] });
  const unverified = f.open({ autoProcess: false, extractor: async () => [proposed] });
  await unverified.enqueueTerminal(terminal); await unverified.runPending();
  assert.equal((await unverified.list({ projectId: 'project-a', limit: 10 }))[0]?.status, 'candidate');
  const verified = f.open({ autoProcess: false, verifyUserDecision: (_event, row) => row.sources.some(ref => ref.userInputId === 'confirmed-input'),
    extractor: async () => [{ ...proposed, stableKey: 'separate-user-decision' }] });
  await verified.enqueueTerminal({ ...terminal, extractionVersion: 'v2' }); await verified.runPending();
  assert.equal((await verified.recall({ projectId: 'project-a', limit: 10 }))[0]?.status, 'accepted');
});
