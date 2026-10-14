import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import type { DesktopCoordinatorProfile, DesktopIndependentGroupPort, WorkbenchDesktopState, WorkbenchTaskRef } from '../../contracts/workbench.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';
import { DesktopWorkbench, readDesktopCoordinatorProfile, writeDesktopIndependentGroupStatus } from '../../app/desktop-workbench.js';
import { reloadingWorkbenchTurnAuthorization } from '../../app/workbench-runtime.js';

const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ?
  Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-independent-group-')));
  const at = new Date().toISOString();
  const project: ProjectEntry = { id: 'local-project', version: 1, name: 'Test', abstract: '', updatedAt: at, detailRef: { rootPath: root } };
  const projects: ProjectIndexPort = { async get(id) { return id === project.id ? project : null; },
    async list() { return { items: [project], total: 1, offset: 0, limit: 100 }; },
    async save() { throw Error('unexpected'); }, async remove() { throw Error('unexpected'); }, async close() {} };
  const refs = ['C', 'A', 'B'].map(actor => ({ id: 'local-' + actor, projectId: project.id, provider: 'codex' as const,
    origin: 't3' as const, environmentId: 'env', t3ProjectId: 'original-project', threadId: 'original-' + actor,
    providerInstanceId: 'codex' as const }));
  const threads: any[] = refs.map((ref, i) => ({ id: ref.threadId, projectId: ref.t3ProjectId,
    branch: i ? 'branch-' + ['C', 'A', 'B'][i] : 'integration', worktreePath: i ? join(root, ['C', 'A', 'B'][i]!) : null,
    modelSelection: { instanceId: 'codex', model: i ? 'sol' : 'astra', options: [{ id: 'reasoningEffort', value: i ? 'medium' : 'low' }] },
    runtimeMode: i ? 'auto-accept-edits' : 'approval-required', interactionMode: 'default', latestTurn: null, session: null }));
  for (const name of ['A', 'B']) mkdirSync(join(root, name));
  let turns = 0, registers = 0;
  const native: T3WorkbenchClient = { async environmentDescriptor() { return { environmentId: 'env' }; },
    async shellSnapshot() { return { snapshotSequence: 1, updatedAt: at,
      projects: [{ id: 'original-project', workspaceRoot: root }], threads }; },
    async threadSnapshot(id) { return { snapshotSequence: 1, thread: { ...threads.find(t => t.id === id), messages: [] } }; },
    async dispatch() { turns++; throw Error('no provider execution allowed'); } };
  const store = new SqliteWorkbenchStore(join(root, 'workbench.sqlite'));
  store.bindProject(project, 'env', { id: 'original-project', workspaceRoot: root }, root);
  refs.forEach((ref, i) => store.saveVerifiedTask(ref, threads[i]));
  let registration: any = null;
  const port: DesktopIndependentGroupPort = { available: () => true,
    async register(input: any) {
      registers++;
      registration = { boardId: 'original-board', registrationDigest: digest(input),
        coordinatorClientPath: join(root, 'actual-client.mjs'), participants: input.participants.map((p: any) => {
          const thread = threads.find(t => t.id === p.threadId);
          return { ...p, contextFile: join(root, 'private-actor-' + p.actorId + '.json'),
            original: { projectRoot: root, workspaceRoot: thread.worktreePath ?? root, branch: thread.branch,
              modelSelection: structuredClone(thread.modelSelection), runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode, nativeSessionId: null } };
        }) };
      return registration;
    },
    async readRegistration() { return registration; } };
  const service = new WorkbenchService(projects, store, native, true,
    undefined, undefined, undefined, undefined, undefined, undefined, port);
  const profile: DesktopCoordinatorProfile = { projectId: project.id, workspaceRoot: root, operationId: randomUUID(),
    title: 'Coordinator', modelSelection: { instanceId: 'codex', model: 'astra', reasoningEffort: 'low' },
    existingTaskId: refs[0]!.id, independentGroup: { operationId: randomUUID(), coordinatorBranch: 'integration',
      coordinatorExecution: null, dispatchAuthorization: null, members: refs.slice(1).map((ref, i) => ({
        actorId: (i ? 'B' : 'A') as 'A' | 'B', taskId: ref.id, title: i ? 'Executor B' : 'Executor A',
        workspaceRoot: threads[i + 1].worktreePath, branch: threads[i + 1].branch, model: 'sol',
        reasoningEffort: 'medium', writablePaths: [i ? 'code/app/src/app.js' : 'code/app/src/index.html'] })) } };
  const states: WorkbenchDesktopState[] = [];
  const desktop = new DesktopWorkbench(projects, service, s => states.push(s), undefined, () => profile);
  t.after(async () => { await desktop.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const configured = () => {
    Object.assign(profile.independentGroup!, { coordinatorExecution: { model: 'sol', reasoningEffort: 'medium', runtimeMode: 'approval-required' },
      dispatchAuthorization: { authorizationId: 'explicit-test-grant', maxDispatches: 2, expiresAt: '2035-01-01T00:00:00Z' } });
  };
  const switchC = () => { threads[0].modelSelection = structuredClone(threads[1].modelSelection); };
  return { root, projects, project, refs, threads, store, service, profile, port, native, desktop, states, configured, switchC,
    counts: () => ({ turns, registers }), registration: () => registration };
}

test('pending coordinator choice records metadata only and preserves absent native SIDs', async t => {
  const f = fixture(t);
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'metadata_ready');
  assert.deepEqual(f.counts(), { turns: 0, registers: 0 });
  assert.equal(f.registration(), null);
});

function firstConfirmedFixture(t: { after(fn: () => void | Promise<void>): void }) {
  const f = fixture(t);
  Object.assign(f.profile, { confirmedFirstTurn: { authorizationId: randomUUID(), authType: 'chatgpt', maxTurns: 1, automaticRetries: 0 } });
  const authorization = reloadingWorkbenchTurnAuthorization(f.root);
  const service = new WorkbenchService(f.projects, f.store, f.native, true, undefined, undefined, undefined, undefined,
    undefined, authorization, f.port, () => f.profile);
  f.store.putDesktopFocus(f.project.id, 'local-C', 0);
  const prepare = async () => service.prepareDesktopContinuation(f.project.id, 'local-C', 1,
    { inputId: 'actual-user-input', origin: { channel: 'desktop', channelSessionId: 'desktop-primary', messageId: 'actual-user-input' },
      rawText: '本人需求', dispatchText: '本人核对的完整正文', createdAt: new Date().toISOString() });
  return { ...f, service, authorization, prepare };
}

test('production reloading port remains closed until exact host first profile and an actual desktop confirmation', async t => {
  const f = firstConfirmedFixture(t);
  const dispatch = f.native.dispatch;
  f.native.dispatch = async command => { assert.deepEqual(command.modelSelection,
    { instanceId: 'codex', model: 'astra', options: [{ id: 'reasoningEffort', value: 'low' }] });
    return dispatch(command); };
  assert.equal(f.authorization.available(), false);
  assert.equal((await f.service.status()).dispatchEnabled, false);
  assert.equal((await f.service.status(true)).dispatchEnabled, true);
  const draft = await f.prepare(); assert.equal(f.store.hasDesktopFirstTurnAdmission(f.profile.operationId), false);
  assert.deepEqual(f.counts(), { turns: 0, registers: 0 });
  const confirmingAt = Date.now();
  assert.equal((await f.service.confirmDesktopContinuation(draft.id, draft.version))?.state, 'unknown');
  assert.equal(f.store.hasDesktopFirstTurnAdmission(f.profile.operationId), true);
  const first = f.store.desktopFirstTurnConfirmation(f.profile.operationId)!;
  assert.ok(Date.parse(first.confirmedAt) >= confirmingAt && Date.parse(first.confirmedAt) <= Date.now());
  assert.equal((await f.service.confirmDesktopContinuation(draft.id, draft.version))?.state, 'unknown');
  assert.deepEqual(f.counts(), { turns: 1, registers: 0 });
  assert.equal((await f.service.status(true)).dispatchEnabled, false);
});

test('generic web confirmation cannot consume first desktop permission or execute an original command', async t => {
  const f = firstConfirmedFixture(t), draft = await f.prepare();
  await assert.rejects(f.service.confirmContinuation(draft.id, draft.version, 'desktop', 'desktop-primary'));
  assert.equal(f.store.hasDesktopFirstTurnAdmission(f.profile.operationId), false);
  assert.deepEqual(f.counts(), { turns: 0, registers: 0 });
});

test('first-turn admission rejects changed coordinator model, prior real turn and changed focus before claim', async t => {
  for (const fault of ['model', 'prior-turn', 'focus']) {
    const f = firstConfirmedFixture(t), draft = await f.prepare();
    if (fault === 'model') f.threads[0].modelSelection.model = 'sol';
    if (fault === 'prior-turn') f.threads[0].latestTurn = { turnId: 'real-old', state: 'completed' };
    if (fault === 'focus') f.store.putDesktopFocus(f.project.id, 'local-A', 1);
    await assert.rejects(f.service.confirmDesktopContinuation(draft.id, draft.version));
    assert.equal(f.store.hasDesktopFirstTurnAdmission(f.profile.operationId), false);
    assert.deepEqual(f.counts(), { turns: 0, registers: 0 });
  }
});

test('profile mutation after exact first claim cannot authorize forwarding or a second draft', async t => {
  const f = firstConfirmedFixture(t), draft = await f.prepare();
  const shell = f.native.shellSnapshot;
  f.native.shellSnapshot = async () => { const s = await shell.call(f.native);
    if (f.store.getContinuation(draft.id, 'desktop', 'desktop-primary').state === 'claimed') {
    Object.assign(f.profile.confirmedFirstTurn!, { authorizationId: randomUUID() });
  } return s; };
  const result = await f.service.confirmDesktopContinuation(draft.id, draft.version);
  assert.equal(result.state, 'unknown'); assert.equal(f.counts().turns, 0);
  assert.equal(f.store.hasDesktopFirstTurnAdmission(f.profile.operationId), true);
});

test('original coordinator model and idle state gate one registration; refresh never sends a turn', async t => {
  const f = fixture(t); f.configured();
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'waiting_coordinator_mode');
  f.switchC(); f.threads[0].session = { status: 'running', activeTurnId: 'real-turn' };
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'waiting_coordinator_idle');
  f.threads[0].session = null;
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'registered');
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'registered');
  assert.deepEqual(f.counts(), { turns: 0, registers: 1 });
  assert.ok(f.registration().participants.every((p: any) => p.original.nativeSessionId === null));
});

test('executor workspace, model, provider, branch and permission drift prevent original registration', async t => {
  for (const [key, value] of Object.entries({ worktreePath: '/wrong', branch: 'wrong',
    runtimeMode: 'full-access', interactionMode: 'plan', modelSelection: { instanceId: 'dsh', model: 'sol', options: [] } })) {
    const f = fixture(t); f.configured(); f.switchC(); f.threads[1][key] = value;
    await assert.rejects(f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'));
    assert.deepEqual(f.counts(), { turns: 0, registers: 0 });
  }
});

test('focus/config change during original metadata read prevents claim and board mutation', async t => {
  const f = fixture(t); f.configured(); f.switchC(); let valid = true;
  const shell = f.native.shellSnapshot; f.native.shellSnapshot = async () => { const v = await shell.call(f.native); valid = false; return v; };
  await assert.rejects(f.service.ensureDesktopIndependentGroup(f.profile, 'local-C', () => { if (!valid) throw Error('changed focus'); }));
  assert.deepEqual(f.counts(), { turns: 0, registers: 0 });
});

test('lost registration response recovers only from the same original board, without a second registration', async t => {
  const f = fixture(t); f.configured(); f.switchC(); const register = f.port.register;
  f.port.register = async input => { await register(input); throw Error('response lost'); };
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'registered');
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'registered');
  assert.deepEqual(f.counts(), { turns: 0, registers: 1 });
});

test('unknown read and process restart retain registration claim; changed grant cannot replay', async t => {
  const f = fixture(t); f.configured(); f.switchC(); const read = f.port.readRegistration;
  f.port.readRegistration = async () => { throw Error('original board unavailable'); };
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'unknown');
  const reopened = new SqliteWorkbenchStore(join(f.root, 'workbench.sqlite'));
  t.after(() => reopened.close());
  const service = new WorkbenchService({ async get() { return f.project; }, async list() { throw Error(); },
    async save() { throw Error(); }, async remove() { throw Error(); }, async close() {} }, reopened, f.native, true,
    undefined, undefined, undefined, undefined, undefined, undefined, f.port);
  assert.equal((await service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'unknown');
  f.port.readRegistration = read;
  assert.equal((await service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'registered');
  Object.assign(f.profile.independentGroup!, { dispatchAuthorization: { ...f.profile.independentGroup!.dispatchAuthorization!, maxDispatches: 3 } });
  await assert.rejects(service.ensureDesktopIndependentGroup(f.profile, 'local-C'));
  assert.deepEqual(f.counts(), { turns: 0, registers: 1 });
});

test('mismatched registered original branch and command digest remain unknown', async t => {
  const f = fixture(t); f.configured(); f.switchC(); const read = f.port.readRegistration;
  f.port.readRegistration = async scope => { const r = await read(scope) as any; return { ...r,
    participants: r.participants.map((p: any) => p.actorId === 'A' ? { ...p, original: { ...p.original, branch: 'raced' } } : p) }; };
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'unknown');
  assert.deepEqual(f.counts(), { turns: 0, registers: 1 });
});

test('project discovery file is private, scoped and contains actual references after registration', async t => {
  const f = fixture(t);
  const pending = (await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))!;
  const file = writeDesktopIndependentGroupStatus(f.profile, 'local-C', pending);
  const raw = readFileSync(file, 'utf8'); assert.equal(lstatSync(file).mode & 0o077, 0);
  assert.ok(!raw.includes('coordinatorContextFile')); assert.ok(!raw.includes('capability'));
  f.configured(); f.switchC();
  const registered = (await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))!;
  assert.equal(writeDesktopIndependentGroupStatus(f.profile, 'local-C', registered), file);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).coordinatorContextFile, registered.coordinatorContextFile);
  Object.assign(f.profile.independentGroup!.members[0]!, { branch: 'different' });
  assert.throws(() => writeDesktopIndependentGroupStatus(f.profile, 'local-C', registered));
});

test('discovery writer rejects result directory symlink instead of writing outside the project', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'outside'));
  symlinkSync(join(f.root, 'outside'), join(f.root, 'artifacts'));
  assert.throws(() => writeDesktopIndependentGroupStatus(f.profile, 'local-C',
    { operationId: f.profile.independentGroup!.operationId, stage: 'metadata_ready' }));
});

test('selected coordinator group is never projected onto a later executor focus', async t => {
  const f = fixture(t); f.store.putDesktopFocus(f.project.id, 'local-C', 0);
  await f.desktop.start(); await f.desktop.refreshIndependentGroup();
  assert.equal(f.states.at(-1)?.independentGroup?.stage, 'metadata_ready');
  f.store.putDesktopFocus(f.project.id, 'local-A', 1);
  await f.desktop.action({ type: 'refresh' }); assert.equal(f.states.at(-1)?.independentGroup, undefined);
  await f.desktop.refreshIndependentGroup(); assert.equal(f.states.at(-1)?.independentGroup, undefined);
  assert.deepEqual(f.counts(), { turns: 0, registers: 0 });
});

test('strict private profile requires explicit nullable decisions and rejects full access or escaping write paths', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'data/desktop-pet'), { recursive: true });
  const file = join(f.root, 'data/desktop-pet/desktop-coordinator-profiles.json');
  const save = () => writeFileSync(file, JSON.stringify({ version: '0.1.0', activeProjectId: f.profile.projectId, profiles: [f.profile] }), { mode: 0o600 });
  save(); assert.deepEqual(readDesktopCoordinatorProfile(f.root, null), f.profile);
  f.configured(); (f.profile.independentGroup!.coordinatorExecution as any).runtimeMode = 'full-access';
  save(); assert.throws(() => readDesktopCoordinatorProfile(f.root, null));
  f.configured(); Object.assign(f.profile.independentGroup!.members[0]!, { writablePaths: ['../outside'] });
  save(); assert.throws(() => readDesktopCoordinatorProfile(f.root, null));
});

test('explicit board duration starts from the original actual first confirmation record and never renews on reread', async t => {
  const f = fixture(t); f.configured(); f.switchC();
  Object.assign(f.profile.independentGroup!, { dispatchAuthorization: { authorizationId: 'explicit-human-proposal-test-only',
    maxDispatches: 3, validityFromFirstConfirmationMs: 3600000 } });
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'waiting_first_confirmation');
  assert.deepEqual(f.counts(), { turns: 0, registers: 0 });
  const policy = { kind: 'confirmed-first-desktop-codex', profile: structuredClone(f.profile) };
  f.store.claimDesktopFirstTurnAdmission(f.profile.operationId, 'controlled-first-confirmation', policy);
  const receipt = f.store.desktopFirstTurnConfirmation(f.profile.operationId)!;
  f.store.claimDesktopFirstTurnAdmission(f.profile.operationId, 'controlled-first-confirmation', policy);
  assert.equal(f.store.desktopFirstTurnConfirmation(f.profile.operationId)!.confirmedAt, receipt.confirmedAt);
  let grantedExpiry: string | undefined; const register = f.port.register;
  f.port.register = async input => { grantedExpiry = (input as any).dispatchAuthorization.expiresAt; return register(input); };
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'registered');
  assert.equal(Date.parse(grantedExpiry!), Date.parse(receipt.confirmedAt) + 3600000);
  assert.equal((await f.service.ensureDesktopIndependentGroup(f.profile, 'local-C'))?.stage, 'registered');
  assert.deepEqual(f.counts(), { turns: 0, registers: 1 });
});
