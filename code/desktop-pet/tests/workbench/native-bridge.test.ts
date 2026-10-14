import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { WorkbenchCommand, WorkbenchTaskEvent, WorkbenchTaskRef } from '../../contracts/workbench.js';
import { TaskReferenceIndex, legacyForwardReference, nativeTaskKey } from '../../workbench/identity.js';
import { applyTaskEvent, projectTerminalEvidence } from '../../workbench/events.js';
import { t3ShellToTaskEvent } from '../../workbench/t3-read.js';
import { SqliteCommandLedger } from '../../workbench/sqlite-ledger.js';
import { WorkbenchTurnGateway, type PreparedT3Turn } from '../../workbench/commands.js';
import { dispatchDshPrompt, readDshPromptEvent, type DshSessionRpc } from '../../workbench/dsh-native.js';
import { DshTransportError, HttpDshSessionRpc } from '../../workbench/dsh-transport.js';

const now = '2026-09-25T00:00:00.000Z';
const t3Task: WorkbenchTaskRef & { origin: 't3' } = {
  id: 'task-1', projectId: 'project-1', provider: 'codex', origin: 't3',
  environmentId: 'env-1', t3ProjectId: 'native-project-1', threadId: 'thread-1', providerInstanceId: 'codex',
};

test('native identity rejects an unrelated task even when title and directory would match', () => {
  const index = new TaskReferenceIndex();
  index.add(t3Task);
  const old: WorkbenchTaskRef = { id: 'old-1', projectId: 'project-1', provider: 'codex',
    origin: 'legacy_codex_app', hostId: 'host-1', nativeSessionId: 'thread-1' };
  index.add(old);
  assert.notEqual(nativeTaskKey(t3Task), nativeTaskKey(old));
  assert.equal(index.getByNative(t3Task), t3Task);
  assert.equal(index.getByNative(old)?.id, 'old-1');
  assert.throws(() => index.add({ ...old, id: 'task-1' }), /task_id_rebound/);
  assert.throws(() => index.add({ ...t3Task, projectId: 'other-project' }), /task_id_rebound/);
  assert.throws(() => index.add({ ...t3Task, t3ProjectId: 'other-native-project' }), /task_id_rebound/);
  assert.throws(() => index.add({ ...t3Task, id: 'other-task', t3ProjectId: 'other-native-project' }), /native_identity_rebound/);
  assert.equal(index.getByNative({ ...t3Task, projectId: 'other-project' }), null);
  assert.equal(index.getByNative({ ...t3Task, t3ProjectId: 'other-native-project' }), null);
  assert.notEqual(nativeTaskKey(t3Task), nativeTaskKey({ ...t3Task, t3ProjectId: 'other-native-project' }));
});

test('a T3 environment and thread have one local task owner across provider instance drift', () => {
  const index = new TaskReferenceIndex();
  index.add(t3Task);
  assert.throws(() => index.add({ ...t3Task, id: 'other-task', providerInstanceId: 'other-instance' }), /native_identity_rebound/);
  assert.throws(() => index.add({ ...t3Task, id: 'another-task', provider: 'dsh', providerInstanceId: 'dsh-instance' }), /native_identity_rebound/);
  assert.throws(() => index.add({ ...t3Task, provider: 'dsh', providerInstanceId: 'dsh-instance' }), /task_id_rebound/);
  assert.equal(index.getByNative(t3Task), t3Task);
  assert.equal(index.getByNative({ ...t3Task, provider: 'dsh', providerInstanceId: 'dsh-instance' }), null);
  const otherThread = { ...t3Task, id: 'other-thread-task', threadId: 'thread-2', provider: 'dsh' as const, providerInstanceId: 'dsh-instance' };
  const otherEnvironment = { ...t3Task, id: 'other-environment-task', environmentId: 'env-2', provider: 'dsh' as const, providerInstanceId: 'dsh-instance' };
  index.add(otherThread);
  index.add(otherEnvironment);
  assert.equal(index.getByNative(otherThread), otherThread);
  assert.equal(index.getByNative(otherEnvironment), otherEnvironment);
});

test('an old T3 reference without a trusted native project binding remains pending', async () => {
  const { t3ProjectId: _unverified, ...oldFields } = t3Task;
  const old = { ...oldFields, id: 'old-unmapped', threadId: 'old-thread' } as WorkbenchTaskRef;
  const index = new TaskReferenceIndex();
  index.add(old);
  assert.equal(index.get(old.id), old);
  assert.equal(index.getByNative(old), null);
  assert.equal(index.getByNative({ ...t3Task, id: old.id, threadId: 'old-thread' }), null);
  assert.throws(() => index.add({ ...t3Task, id: old.id, threadId: 'old-thread' }), /task_id_rebound/);
  assert.throws(() => index.add({ ...old, provider: 'dsh', providerInstanceId: 'dsh-instance' } as WorkbenchTaskRef), /task_id_rebound/);
  assert.throws(() => index.add({ ...t3Task, id: 'other-task', threadId: 'old-thread',
    provider: 'dsh', providerInstanceId: 'dsh-instance' }), /native_identity_rebound/);
  assert.throws(() => nativeTaskKey(old), /t3_project_binding_unverified/);
  let sends = 0;
  const db = new Database(':memory:');
  try {
    const gateway = new WorkbenchTurnGateway(new SqliteCommandLedger(db), {
      dispatch: async () => { sends++; return { sequence: 1 }; },
    });
    await assert.rejects(gateway.submit({
      commandId: 'old-command', type: 'continue', taskId: old.id,
      input: { inputId: 'old-input', origin: { channel: 'web', channelSessionId: 'web-1', messageId: 'old-message' },
        rawText: 'original', dispatchText: 'reviewed', createdAt: now },
    }, { task: old as WorkbenchTaskRef & { origin: 't3' }, command: {
      type: 'thread.turn.start', commandId: 'old-command', threadId: 'old-thread',
      message: { messageId: 'old-input', role: 'user', text: 'reviewed', attachments: [] }, createdAt: now,
    } }), /t3_project_binding_unverified/);
    assert.equal(sends, 0);
  } finally { db.close(); }
  assert.throws(() => t3ShellToTaskEvent(old, {
    id: 'old-thread', projectId: 'native-project-1', modelSelection: { instanceId: 'codex' },
    latestTurn: null, hasPendingApprovals: false, hasPendingUserInput: false,
  }, 1, now), /t3_project_binding_unverified/);
});

test('legacy receipt mapping requires explicit native profile and project', () => {
  const base = { id: 'old-receipt', version: 1, phase: 'accepted' as const, text: 'synthetic',
    executor: 'harness' as const, harnessSessionId: 'native-session', createdAt: now,
    project: { id: 'project-1', name: 'Same title', version: 1, detailRef: { rootPath: '/same/path' } } };
  assert.equal(legacyForwardReference(base), null);
  assert.equal(legacyForwardReference(base, 'local-host')?.origin, 'legacy_dsh');
  const { project: _project, ...withoutProject } = base;
  assert.equal(legacyForwardReference(withoutProject, 'local-host'), null);
});

test('lost dispatch response cannot cause a second send and command ID cannot change text', async () => {
  const db = new Database(':memory:');
  try {
    let sends = 0;
    let receipt: 'accepted' | null = null;
    const ledger = new SqliteCommandLedger(db);
    const gateway = new WorkbenchTurnGateway(ledger, {
      dispatch: async () => { sends++; throw new Error('socket dropped after server accepted'); },
      readReceipt: async () => receipt && { status: receipt, aggregateKind: 'thread', aggregateId: 'thread-1', resultSequence: 12 },
    });
    const command: WorkbenchCommand = { commandId: 'command-1', type: 'continue', taskId: 'task-1',
      input: { inputId: 'input-1', origin: { channel: 'desktop', channelSessionId: 'desk-1', messageId: 'msg-1' },
        rawText: '原话', dispatchText: 'checked task text', createdAt: now } };
    const prepared: PreparedT3Turn = { task: t3Task, command: { type: 'thread.turn.start', commandId: 'command-1', threadId: 'thread-1',
      message: { messageId: 'input-1', role: 'user', text: 'checked task text', attachments: [] }, createdAt: now } };
    assert.equal((await gateway.submit(command, prepared)).state, 'unknown');
    assert.equal((await gateway.submit(command, prepared)).state, 'unknown');
    assert.equal(sends, 1);
    assert.equal(new SqliteCommandLedger(db).get('command-1')?.state, 'unknown');
    receipt = 'accepted';
    assert.equal((await gateway.submit(command, prepared)).state, 'accepted');
    assert.equal(sends, 1);
    const changed = { ...command, input: { ...command.input, dispatchText: 'different text' } };
    const changedPrepared = { ...prepared, command: { ...prepared.command, message: { ...prepared.command.message, text: 'different text' } } };
    assert.equal((await gateway.submit(changed, changedPrepared)).state, 'conflict');
    assert.equal(sends, 1);
  } finally { db.close(); }
});

test('a lost response remains unknown after reopening the command ledger', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'n1-workbench-'));
  const path = join(directory, 'commands.sqlite');
  const command: WorkbenchCommand = { commandId: 'restart-command', type: 'continue', taskId: t3Task.id,
    input: { inputId: 'restart-input', origin: { channel: 'web', channelSessionId: 'web-1', messageId: 'msg-1' },
      rawText: 'original', dispatchText: 'reviewed', createdAt: now } };
  const prepared: PreparedT3Turn = { task: t3Task, command: { type: 'thread.turn.start',
    commandId: command.commandId, threadId: t3Task.threadId,
    message: { messageId: command.input.inputId, role: 'user', text: command.input.dispatchText, attachments: [] },
    createdAt: now } };
  try {
    const firstDb = new Database(path);
    try {
      const first = new WorkbenchTurnGateway(new SqliteCommandLedger(firstDb), {
        dispatch: async () => { throw new Error('response lost'); },
      });
      assert.equal((await first.submit(command, prepared)).state, 'unknown');
    } finally { firstDb.close(); }

    const reopenedDb = new Database(path);
    try {
      let sends = 0;
      const reopened = new WorkbenchTurnGateway(new SqliteCommandLedger(reopenedDb), {
        dispatch: async () => { sends++; return { sequence: 1 }; },
      });
      assert.equal((await reopened.submit(command, prepared)).state, 'unknown');
      assert.equal(sends, 0);
    } finally { reopenedDb.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unverified approval, question and exact-turn stop never reach the native transport', async () => {
  const db = new Database(':memory:');
  try {
    const gateway = new WorkbenchTurnGateway(new SqliteCommandLedger(db), {
      dispatch: async () => { throw new Error('must not be called'); },
    });
    const results = await Promise.all([
      gateway.submit({ commandId: 'approve-1', type: 'decide_approval', taskId: 'task-1', interactionId: 'interaction-1', expectedVersion: 1, choiceId: 'allow' }),
      gateway.submit({ commandId: 'answer-1', type: 'answer_question', taskId: 'task-1', interactionId: 'interaction-1', expectedVersion: 1, answers: [] }),
      gateway.submit({ commandId: 'stop-1', type: 'stop_turn', taskId: 'task-1', nativeTurnId: 'turn-1' }),
    ]);
    assert.deepEqual(results.map(result => result.state), ['unsupported', 'unsupported', 'unsupported']);
  } finally { db.close(); }
});

test('old turn terminal and duplicate events cannot settle a newer turn', () => {
  const event = (sequence: number, phase: WorkbenchTaskEvent['phase'], turn: string): WorkbenchTaskEvent => ({
    eventId: `event-${sequence}`, taskId: 'task-1', sequence, phase, observedAt: now,
    nativeTurnId: turn, nativeEventId: `native-${sequence}`, evidence: 't3_event',
  });
  let state = applyTaskEvent(null, event(1, 'running', 'turn-1'));
  state = applyTaskEvent(state, event(2, 'running', 'turn-2'));
  state = applyTaskEvent(state, event(3, 'completed', 'turn-1'));
  assert.equal(state.phase, 'running');
  state = applyTaskEvent(state, event(4, 'completed', 'turn-2'));
  assert.equal(state.phase, 'completed');
  const evidence = projectTerminalEvidence('project-1', state, 'fixture-1');
  assert.equal(evidence?.nativeTurnId, 'turn-2');
  assert.equal(applyTaskEvent(state, event(2, 'failed', 'turn-2')), state);
  assert.equal(applyTaskEvent(state, { eventId: 'late-accepted', taskId: 'task-1', sequence: 5,
    phase: 'accepted', observedAt: now, evidence: 't3_event' }), state);
});

test('T3 cold read requires matching native identity and completedAt before completion', () => {
  const shell = { id: 'thread-1', projectId: 'native-project-1', modelSelection: { instanceId: 'codex' },
    latestTurn: { turnId: 'turn-1', state: 'completed' as const, completedAt: null, assistantMessageId: 'message-1' },
    hasPendingApprovals: false, hasPendingUserInput: false };
  assert.equal(t3ShellToTaskEvent(t3Task, shell, 3, now).phase, 'unknown');
  const completed = t3ShellToTaskEvent(t3Task, { ...shell, latestTurn: { ...shell.latestTurn, completedAt: now } }, 4, now);
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.nativeTurnId, 'turn-1');
  assert.throws(() => t3ShellToTaskEvent(t3Task, { ...shell, modelSelection: { instanceId: 'other' } }, 5, now), /identity/);
  const sameTitleAndPath = { ...shell, projectId: 'other-native-project', title: 'Same title', rootPath: '/same/path' };
  assert.throws(() => t3ShellToTaskEvent(t3Task, sameTitleAndPath, 5, now), /identity/);
});

test('DSH cold read binds request ID to exact turn/end and rejects broken history', async () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 7 } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user', rpcId: 'request-1' } } },
    { seq: 3, type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: 'private output' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } },
  ];
  const rpc = (list: readonly typeof events[number][]): DshSessionRpc => ({ call: async (method) => {
    if (method === 'session/list') return { items: [{ sessionId: 'session-1', running: false, projections: { asOfSeq: 4, values: {} } }] };
    if (method === 'session/page') return { records: list.map(event => ({ type: 'event', event })), hasMore: false };
    throw new Error('read only fixture');
  } });
  const completed = await readDshPromptEvent(rpc(events), 'task-1', 'session-1', 'request-1', now);
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.nativeTurnId, '7');
  assert.ok(!JSON.stringify(completed).includes('private output'));
  const broken = await readDshPromptEvent(rpc([events[0]!, events[2]!, events[3]!]), 'task-1', 'session-1', 'request-1', now);
  assert.equal(broken.phase, 'unknown');
  const foreignFirst = await readDshPromptEvent(rpc([
    events[0]!, { seq: 2, type: 'user/message', data: { source: { kind: 'user', rpcId: 'other-request' } } },
    { ...events[1]!, seq: 3 }, { ...events[3]!, seq: 4 },
  ]), 'task-1', 'session-1', 'request-1', now);
  assert.equal(foreignFirst.phase, 'unknown');
});

test('DSH prompt uses the supplied durable ID and rejects a missing ID', async () => {
  const calls: unknown[] = [];
  const rpc: DshSessionRpc = { call: async (method, args) => { calls.push({ method, args }); return { accepted: true }; } };
  await dispatchDshPrompt(rpc, 'session-1', 'source-command-1', 'synthetic text');
  assert.deepEqual(calls, [{ method: 'session/prompt', args: { request: {
    sessionId: 'session-1', requestId: 'source-command-1', mode: 'queue', content: [{ type: 'text', text: 'synthetic text' }],
  } } }]);
  await assert.rejects(dispatchDshPrompt(rpc, 'session-1', '', 'synthetic text'), /invalid_dsh_prompt/);
  assert.equal(calls.length, 1);
});

test('DSH HTTP transport exchanges only a loopback launcher credential and redacts failures', async () => {
  const calls: string[] = [];
  const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    if (calls.length === 0) {
      calls.push('launcher');
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'sid=fixture-cookie; Path=/' } });
    }
    calls.push('rpc');
    assert.equal(String(input), 'http://127.0.0.1:12345/api/session/list');
    const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string };
    assert.equal(request.method, 'session/list');
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const rpc = new HttpDshSessionRpc(async () => 'http://127.0.0.1:12345/?token=fixture-secret', fakeFetch);
  assert.deepEqual(await rpc.call('session/list', { _request: {} }), { items: [] });
  assert.deepEqual(calls, ['launcher', 'rpc']);
  const hostile = new HttpDshSessionRpc(async () => 'https://example.com/?token=fixture-secret', fakeFetch);
  await assert.rejects(hostile.call('session/list', {}), (error: unknown) =>
    error instanceof DshTransportError && error.code === 'authentication_required' && !error.message.includes('fixture-secret'));
  assert.equal(calls.length, 2);
});
