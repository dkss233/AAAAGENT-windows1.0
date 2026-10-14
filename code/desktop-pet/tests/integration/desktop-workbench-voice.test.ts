import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import type { WorkbenchDesktopState, WorkbenchTaskRef } from '../../contracts/workbench.js';
import type { TurnScope } from '../../contracts/index.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';
import { DesktopWorkbench, readDesktopCoordinatorProfile } from '../../app/desktop-workbench.js';
import { parseDesktopCommand } from '../../app/backend-session.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-voice-binding-')));
  const at = '2026-10-04T00:00:00Z';
  const project: ProjectEntry = { id: 'project', version: 1, name: 'Test', abstract: '', updatedAt: at, detailRef: { rootPath: root } };
  const task: Extract<WorkbenchTaskRef, { origin: 't3' }> = { id: 'task', projectId: project.id, provider: 'codex', origin: 't3',
    environmentId: 'env', t3ProjectId: 'native-project', threadId: 'native-thread', providerInstanceId: 'codex' };
  const shell = { id: task.threadId, projectId: task.t3ProjectId, modelSelection: { instanceId: 'codex', model: 'chosen', options: [{ id: 'reasoningEffort', value: 'low' }] },
    runtimeMode: 'approval-required', interactionMode: 'default', latestTurn: null, hasPendingApprovals: false, hasPendingUserInput: false };
  const projects: ProjectIndexPort = { async get(id) { return id === project.id ? project : null; },
    async list() { return { items: [project], total: 1, offset: 0, limit: 100 }; },
    async save() { throw Error('unexpected'); }, async remove() { throw Error('unexpected'); }, async close() {} };
  let sends = 0;
  const native: T3WorkbenchClient = { async environmentDescriptor() { return { environmentId: 'env' }; },
    async shellSnapshot() { return { snapshotSequence: 1, updatedAt: at, projects: [{ id: task.t3ProjectId, workspaceRoot: root }], threads: [shell] }; },
    async threadSnapshot() { return { snapshotSequence: 1, thread: { ...shell, messages: [] } }; },
    async dispatch(command) { sends++; assert.equal(command.type, 'thread.turn.start'); throw Error('controlled lost receipt'); },
    async readReceipt() { return null; } };
  const store = new SqliteWorkbenchStore(join(root, 'workbench.sqlite'));
  store.bindProject(project, 'env', { id: task.t3ProjectId, workspaceRoot: root }, root); store.saveVerifiedTask(task, shell);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const service = new WorkbenchService(projects, store, native, true);
  const states: WorkbenchDesktopState[] = [];
  const desktop = new DesktopWorkbench(projects, service, state => states.push(state));
  const scope = (id: string): TurnScope => ({ characterId: 'companion', sessionId: 'test-session', turnId: id, generation: 1 });
  return { desktop, store, service, states, task, project, scope, native, shell, sends: () => sends };
}

test('native input command parser preserves exact binding and rejects mixed or forged envelopes', () => {
  const binding = { version: '0.1.0', projectId: 'p', taskId: 't', focusRevision: 1, draftId: 'd', draftVersion: 2, commandId: 'c' };
  assert.deepEqual(parseDesktopCommand({ type: 'start_voice', workbenchBinding: binding }), { type: 'start_voice', workbenchBinding: binding });
  assert.throws(() => parseDesktopCommand({ type: 'start_voice', workbenchBinding: { ...binding, channel: 'wechat' } }));
  assert.throws(() => parseDesktopCommand({ type: 'submit_text', text: '确认', workbenchBinding: binding, workBinding: { draftId: 'd', draftVersion: 2 } }));
});

test('host coordinator choice is exact and optional; unreadable or ambiguous profiles do not guess defaults', t => {
  const f = fixture(t), root = f.project.detailRef.rootPath;
  assert.equal(readDesktopCoordinatorProfile(root, null), undefined);
  const profile = { projectId: f.project.id, workspaceRoot: root, operationId: randomUUID(), title: 'Coordinator',
    modelSelection: { instanceId: 'codex', model: 'chosen', reasoningEffort: 'low' }, existingTaskId: f.task.id };
  mkdirSync(join(root, 'data/desktop-pet'), { recursive: true });
  const path = join(root, 'data/desktop-pet/desktop-coordinator-profiles.json');
  writeFileSync(path, JSON.stringify({ version: '0.1.0', activeProjectId: profile.projectId, profiles: [profile] }), { mode: 0o600 });
  assert.deepEqual(readDesktopCoordinatorProfile(root, null), profile);
  assert.equal(readDesktopCoordinatorProfile(root, 'different-project'), undefined);
  chmodSync(path, 0o644); assert.throws(() => readDesktopCoordinatorProfile(root, null)); chmodSync(path, 0o600);
  writeFileSync(path, JSON.stringify({ version: '0.1.0', activeProjectId: profile.projectId, profiles: [profile, profile] }));
  assert.throws(() => readDesktopCoordinatorProfile(root, null)); assert.equal(f.sends(), 0);
});

test('no selected coordinator relinks only the exact frozen native task and prepares original voice without a turn', async t => {
  const f = fixture(t);
  const profile = { projectId: f.project.id, workspaceRoot: f.project.detailRef.rootPath, operationId: randomUUID(),
    title: 'Coordinator', modelSelection: { instanceId: 'codex' as const, model: 'chosen', reasoningEffort: 'low' }, existingTaskId: f.task.id };
  const desktop = new DesktopWorkbench({ async get() { return f.project; }, async list() { return { items: [f.project], total: 1, offset: 0, limit: 100 }; },
    async save() { throw Error('unexpected'); }, async remove() { throw Error('unexpected'); }, async close() {} }, f.service, s => f.states.push(s), undefined, () => profile);
  await desktop.start();
  assert.equal(await desktop.routeInput(f.scope('create'), '原语音需求', new AbortController().signal, () => {}, desktop.focusSnapshot()), true);
  assert.equal(f.states.at(-1)!.focus.task?.id, f.task.id);
  assert.equal(f.states.at(-1)!.drafts[0]!.input.rawText, '原语音需求'); assert.equal(f.sends(), 0);
  assert.ok(f.states.at(-1)!.voiceBinding);
});

test('partial coordinator creation cold-recovers the original voice and command without a second native create', async t => {
  const f = fixture(t); let creates = 0;
  const extra: Record<string, unknown>[] = []; const receipts = new Map<string, { status: 'accepted'; aggregateKind: 'thread'; aggregateId: string; resultSequence: number }>();
  f.native.providerModels = async () => ({ providers: [{ instanceId: 'codex', driver: 'codex', enabled: true, installed: true,
    status: 'ready', authStatus: 'authenticated', checkedAt: new Date().toISOString(), models: [{ id: 'chosen', name: 'Chosen', reasoningEfforts: [{ id: 'low', name: 'Low' }] }] }] });
  f.native.shellSnapshot = async () => ({ snapshotSequence: 1, updatedAt: new Date().toISOString(),
    projects: [{ id: f.task.t3ProjectId, workspaceRoot: f.project.detailRef.rootPath }], threads: [f.shell, ...extra] });
  f.native.threadSnapshot = async id => ({ snapshotSequence: 1, thread: { ...(extra.find(t => t.id === id) ?? f.shell), messages: [] } });
  f.native.createCommand = async command => { creates++; assert.equal(command.type, 'thread.create');
    extra.push({ ...f.shell, id: command.threadId, modelSelection: command.modelSelection }); return { sequence: creates }; };
  f.native.readReceipt = async id => receipts.get(id) ?? null;
  const profile = { projectId: f.project.id, workspaceRoot: f.project.detailRef.rootPath, operationId: randomUUID(),
    title: 'Coordinator', modelSelection: { instanceId: 'codex' as const, model: 'chosen', reasoningEffort: 'low' } };
  const selected = f.desktop.focusSnapshot();
  const input = (id: string, rawText: string) => ({ inputId: id, rawText, dispatchText: rawText,
    origin: { channel: 'desktop' as const, channelSessionId: 'desktop-primary', messageId: id, turnScope: f.scope(id) }, createdAt: new Date().toISOString() });
  const first = await f.service.ensureDesktopCoordinator(profile, input('original-voice', '真实原始需求'), selected, () => {});
  assert.equal(first.state, 'unknown'); assert.equal(creates, 1); assert.equal(f.sends(), 0);
  const intent = f.store.getNativeCreate(profile.operationId)!;
  receipts.set(intent.threadCommandId, { status: 'accepted', aggregateKind: 'thread', aggregateId: intent.threadId, resultSequence: 1 });
  const recovered = await f.service.ensureDesktopCoordinator(profile, input('recovery', '核对原操作'), selected, () => {});
  assert.equal(recovered.state, 'accepted'); assert.equal(creates, 1); assert.equal(f.sends(), 0);
  if (!('draft' in recovered) || !recovered.draft) throw Error('missing recovered draft');
  assert.equal(recovered.draft.input.rawText, '真实原始需求'); assert.equal(recovered.draft.input.inputId, 'original-voice');
});

test('same presented native card keeps original ASR, ordered supplement and one command after lost send', async t => {
  const f = fixture(t); await f.desktop.start();
  await f.desktop.action({ type: 'select', projectId: f.project.id, taskId: f.task.id, expectedRevision: 0 });
  await f.desktop.routeInput(f.scope('first'), '原始要求', new AbortController().signal, () => {}, f.desktop.focusSnapshot());
  const first = f.states.at(-1)!.drafts[0]!; const binding = f.states.at(-1)!.voiceBinding!;
  f.desktop.beginInput(f.scope('supplement'), binding);
  assert.equal(await f.desktop.continueInput(f.scope('supplement'), '只修改指定文件', new AbortController().signal, () => {}), 'handled');
  const second = f.states.at(-1)!.drafts[0]!;
  assert.equal(second.id, first.id); assert.equal(second.commandId, first.commandId); assert.equal(second.version, 2);
  assert.equal(second.input.rawText, '原始要求'); assert.equal(second.input.conversation?.[0]?.text, '只修改指定文件');
  assert.equal(second.input.dispatchText, '原始要求\n后续补充（按顺序应用）：\n只修改指定文件'); assert.equal(f.sends(), 0);
  const confirmation = f.states.at(-1)!.voiceBinding!;
  f.desktop.beginInput(f.scope('confirm'), confirmation);
  await f.desktop.continueInput(f.scope('confirm'), '确认', new AbortController().signal, () => {});
  assert.equal(f.sends(), 1); assert.equal(f.states.at(-1)!.command?.state, 'unknown');
  assert.equal(f.states.at(-1)!.drafts[0]!.input.conversation?.[1]?.text, '确认');
  f.desktop.beginInput(f.scope('cold-read'), confirmation);
  await f.desktop.continueInput(f.scope('cold-read'), '确认', new AbortController().signal, () => {});
  assert.equal(f.sends(), 1); assert.equal(f.states.at(-1)!.drafts[0]!.commandId, first.commandId);
});

test('focus A away and back, stale version, negation and supplement consent cannot submit a native command', async t => {
  const f = fixture(t); await f.desktop.start();
  await f.desktop.action({ type: 'select', projectId: f.project.id, taskId: f.task.id, expectedRevision: 0 });
  await f.desktop.routeInput(f.scope('first'), '任务', new AbortController().signal, () => {}, f.desktop.focusSnapshot());
  const binding = f.states.at(-1)!.voiceBinding!;
  f.desktop.beginInput(f.scope('race'), binding);
  f.store.putDesktopFocus(f.project.id, null, 1); f.store.putDesktopFocus(f.project.id, f.task.id, 2);
  await f.desktop.continueInput(f.scope('race'), '确认', new AbortController().signal, () => {});
  assert.equal(f.sends(), 0); assert.ok(f.states.at(-1)?.error);
  const current = f.states.at(-1)!.drafts[0]!;
  await f.desktop.action({ type: 'refresh' });
  f.desktop.beginInput(f.scope('negation'), f.states.at(-1)!.voiceBinding!);
  await f.desktop.continueInput(f.scope('negation'), '不要确认', new AbortController().signal, () => {}, async () => ({ kind: 'confirm' }));
  assert.equal(f.sends(), 0);
  await f.desktop.action({ type: 'refresh' });
  f.desktop.beginInput(f.scope('new-supplement'), f.states.at(-1)!.voiceBinding!);
  await f.desktop.continueInput(f.scope('new-supplement'), '加一个约束，马上执行', new AbortController().signal, () => {},
    async () => ({ kind: 'supplement', text: 'rewritten by model', executionAuthorized: true }));
  assert.equal(f.sends(), 0); assert.equal(f.states.at(-1)!.drafts[0]!.id, current.id);
  assert.ok(f.states.at(-1)!.drafts[0]!.input.dispatchText.endsWith('加一个约束，马上执行'));
  f.desktop.beginInput(f.scope('stale'), binding);
  await f.desktop.continueInput(f.scope('stale'), '确认', new AbortController().signal, () => {});
  assert.equal(f.sends(), 0);
  f.desktop.beginInput(f.scope('unbound'));
  assert.equal(await f.desktop.continueInput(f.scope('unbound'), '确认', new AbortController().signal, () => {}), 'handled');
  assert.equal(f.sends(), 0);
});
