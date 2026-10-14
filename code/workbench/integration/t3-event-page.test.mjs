import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { T3HttpClient } from './t3-http-client.mjs';
import { T3LocalService } from './t3-local-service.mjs';

const connection = { origin: 'http://127.0.0.1:43123', accessToken: 's'.repeat(40),
  expiresAt: '2100-01-01T00:00:00.000Z' };
const service = { async start() { return connection; } };
const event = (sequence, eventId) => ({ sequence, eventId, type: 'thread.activity-appended',
  occurredAt: '2026-09-27T00:00:00.000Z', turnId: 'turn-1', activityId: 'activity-1',
  activityKind: 'tool.completed', activityTone: 'tool', payload: { rawToolBody: 'private' } });

test('bounded read uses authenticated GET and strips raw event payloads', async () => {
  const requests = [];
  const client = new T3HttpClient(service, { transport: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ threadId: 'thread-1', afterSequence: 5, headSequence: 9,
      nextSequence: 7, hasMore: true, resetRequired: false, events: [event(6, 'e-6'), event(7, 'e-7')],
      privateResponse: 'private' });
  } });
  const page = await client.threadEventPage('thread-1', 5, 2);
  assert.deepEqual(page, { threadId: 'thread-1', afterSequence: 5, headSequence: 9,
    nextSequence: 7, hasMore: true, resetRequired: false,
    events: [6, 7].map(sequence => {
      const { payload, ...meta } = event(sequence, `e-${sequence}`); return meta;
    }) });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url,
    'http://127.0.0.1:43123/api/orchestration/threads/thread-1/events?afterSequence=5&limit=2');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${connection.accessToken}`);
  assert.equal(requests[0].options.body, undefined);
});

test('empty page advances to head; overflow explicitly requires reset', async () => {
  const responses = [
    { threadId: 'thread-1', afterSequence: 7, headSequence: 11,
      nextSequence: 11, hasMore: false, resetRequired: false, events: [] },
    { threadId: 'thread-1', afterSequence: 2, headSequence: 1015,
      nextSequence: 1015, hasMore: false, resetRequired: true, resetReason: 'gap_too_large', events: [] },
  ];
  const client = new T3HttpClient(service, { transport: async () => Response.json(responses.shift()) });
  assert.equal((await client.threadEventPage('thread-1', 7)).nextSequence, 11);
  assert.deepEqual(await client.threadEventPage('thread-1', 2), {
    threadId: 'thread-1', afterSequence: 2, headSequence: 1015,
    nextSequence: 1015, hasMore: false, resetRequired: true, resetReason: 'gap_too_large', events: [],
  });
});

test('bad cursors, repeated/out-of-order events and false completion fail closed', async () => {
  let reads = 0;
  const make = response => new T3HttpClient(service, { transport: async () => {
    reads++; return Response.json(response);
  } });
  const base = { threadId: 'thread-1', afterSequence: 5, headSequence: 9,
    nextSequence: 9, hasMore: false, resetRequired: false, events: [event(6, 'e-6')] };
  await assert.rejects(make(base).threadEventPage('thread-1', -1), { code: 'invalid_cursor' });
  await assert.rejects(make(base).threadEventPage('thread-1', 5, 101), { code: 'invalid_cursor' });
  assert.equal(reads, 0);
  for (const response of [
    { ...base, threadId: 'another-thread' },
    { ...base, events: [event(6, 'e-6'), event(6, 'e-6')] },
    { ...base, events: [event(7, 'e-7'), event(6, 'e-6')] },
    { ...base, nextSequence: 6 },
    { ...base, hasMore: true, nextSequence: 6 },
    { ...base, resetRequired: true, resetReason: 'gap_too_large' },
  ]) await assert.rejects(make(response).threadEventPage('thread-1', 5), { code: 'invalid_response' });
});

if (process.env.T3_EVENT_SOURCE && process.env.T3_EVENT_NODE && process.env.T3_EVENT_EVIDENCE) {
  test('fixed T3 process serves authenticated metadata-only event pages without a model turn', async () => {
    const sourceDir = resolve(process.env.T3_EVENT_SOURCE);
    const nodeExecutable = resolve(process.env.T3_EVENT_NODE);
    const evidenceDir = resolve(process.env.T3_EVENT_EVIDENCE);
    mkdirSync(evidenceDir, { recursive: true });
    const runDir = mkdtempSync(join(evidenceDir, 'http-run-'));
    const old = Object.fromEntries(['HOME', 'CODEX_HOME', 'PATH', 'T3_P1_FIXTURE', 'T3_P1_CAPTURE']
      .map(key => [key, process.env[key]]));
    const projectRoot = join(runDir, 'project');
    const codexHome = join(runDir, 'home/.codex');
    const t3Home = join(runDir, 't3-home');
    const fakeBin = join(runDir, 'bin');
    for (const path of [projectRoot, codexHome, join(t3Home, 'userdata'), fakeBin])
      mkdirSync(path, { recursive: true, mode: 0o700 });
    const wrapper = join(fakeBin, 'codex');
    const fakePeer = resolve('code/workbench/integration/candidates/no-model-pipeline-54/fake-codex-app-server.mjs');
    writeFileSync(wrapper, `#!/bin/sh\nexec "${nodeExecutable}" "${fakePeer}" "$@"\n`, { mode: 0o700 });
    chmodSync(wrapper, 0o700);
    writeFileSync(join(t3Home, 'userdata/settings.json'), JSON.stringify({
      projectSettingsFolded: true,
      providers: { codex: { enabled: true, binaryPath: wrapper, homePath: codexHome },
        claudeAgent: { enabled: false }, cursor: { enabled: false }, grok: { enabled: false },
        opencode: { enabled: false }, antigravity: { enabled: false } },
    }), { mode: 0o600 });
    Object.assign(process.env, { HOME: dirname(codexHome), CODEX_HOME: codexHome,
      PATH: `${fakeBin}:${dirname(nodeExecutable)}:/usr/bin:/bin`,
      T3_P1_FIXTURE: join(sourceDir, 'apps/server/src/provider/testFixtures/codexMultiAgentWire.json'),
      T3_P1_CAPTURE: join(runDir, 'fake-provider-requests.jsonl') });
    const native = new T3LocalService({ sourceDir, nodeExecutable, baseDir: t3Home,
      logFile: join(runDir, 't3.log') });
    let passed = false;
    let store;
    try {
      const client = new T3HttpClient(native);
      const connection = await native.start();
      assert.equal((await fetch(connection.origin + '/api/orchestration/threads/no-thread/events?afterSequence=0&limit=5')).status, 401);
      const projectId = `project-${randomUUID()}`, threadId = `thread-${randomUUID()}`;
      await client.createCommand({ type: 'project.create', commandId: `command-${randomUUID()}`,
        projectId, title: 'Event page smoke', workspaceRoot: projectRoot, createdAt: new Date().toISOString() });
      await client.createCommand({ type: 'thread.create', commandId: `command-${randomUUID()}`,
        threadId, projectId, title: 'No model turn',
        modelSelection: { instanceId: 'codex', model: 'synthetic-only' },
        runtimeMode: 'approval-required', interactionMode: 'default', branch: null,
        worktreePath: null, createdAt: new Date().toISOString() });
      const first = await client.threadEventPage(threadId, 0, 5);
      assert.equal(first.threadId, threadId);
      assert.ok(first.events.some(item => item.type === 'thread.created'));
      assert.ok(first.events.every(item => Object.keys(item).every(key =>
        ['eventId', 'sequence', 'occurredAt', 'type', 'turnId', 'activityId', 'activityKind',
          'activityTone', 'sessionStatus'].includes(key))));
      const empty = await client.threadEventPage(threadId, first.nextSequence, 5);
      assert.equal(empty.events.length, 0);
      assert.equal(empty.nextSequence, empty.headSequence);
      const ahead = await client.threadEventPage(threadId, empty.headSequence + 1, 5);
      assert.equal(ahead.resetRequired, true);
      assert.equal(ahead.resetReason, 'cursor_ahead');
      await assert.rejects(client.threadEventPage('no-thread', 0, 5), { code: 'http_error', status: 404 });
      const [{ SqliteWorkbenchStore }, { WorkbenchService }] = await Promise.all([
        import(resolve('code/desktop-pet/dist/app/workbench-store.js')),
        import(resolve('code/desktop-pet/dist/app/workbench-service.js')),
      ]);
      store = new SqliteWorkbenchStore(join(runDir, 'workbench.sqlite'));
      const project = { id: `logical-${randomUUID()}`, name: 'Event read smoke', abstract: '',
        detailRef: { rootPath: projectRoot }, version: 1, updatedAt: new Date().toISOString() };
      const projects = { async get(id) { return id === project.id ? project : null; } };
      const service = new WorkbenchService(projects, store, client);
      const environment = await client.environmentDescriptor();
      store.bindProject(project, environment.environmentId, { id: projectId, workspaceRoot: projectRoot }, projectRoot);
      const task = await service.bindTask(project.id, projectId, threadId, 'codex');
      const publicPage = await service.readTaskEventPage(task.id, 0, 5);
      assert.equal(publicPage.status, 'supported');
      assert.deepEqual(publicPage.events, first.events);
      assert.equal(publicPage.task.id, task.id);
      const capturePath = join(runDir, 'fake-provider-requests.jsonl');
      const captured = existsSync(capturePath) ? readFileSync(capturePath, 'utf8').trim().split('\n')
        .filter(Boolean).map(line => JSON.parse(line)) : [];
      const turnDispatches = captured.filter(item => item.method === 'turn/start').length;
      assert.equal(turnDispatches, 0);
      writeFileSync(join(evidenceDir, 'http-result.json'), JSON.stringify({
        status: 'passed', source: 'fixed_T3_local_process_and_AAA_public_port', provider: 'synthetic_only',
        turnDispatches, modelRequests: 0, unauthorizedStatus: 401,
        firstEventCount: first.events.length, firstHead: first.headSequence,
        emptyHead: empty.headSequence, aheadReset: ahead.resetReason, missingThreadStatus: 404,
        publicTaskIdentity: 'matched', publicBodyFields: 0,
      }, null, 2) + '\n');
      passed = true;
    } finally {
      store?.close();
      await native.stop();
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      if (passed) rmSync(runDir, { recursive: true, force: true });
    }
  });
}
