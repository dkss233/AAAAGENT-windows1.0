import test from 'node:test';
import assert from 'node:assert/strict';
import { T3HttpClient, T3TransportError } from './t3-http-client.mjs';

const token = 's'.repeat(40);
const service = (overrides = {}) => ({ async start() { return {
  origin: 'http://127.0.0.1:43123', accessToken: token,
  expiresAt: '2100-01-01T00:00:00.000Z', ...overrides,
}; } });

test('protected local dispatch sends once and receipt readback returns only safe fields', async () => {
  const requests = [];
  const client = new T3HttpClient(service(), { transport: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/dispatch')) return Response.json({ sequence: 7 });
    return Response.json({ commandId: 'cmd-1', aggregateKind: 'thread', aggregateId: 'thread-1',
      acceptedAt: '2026-09-26T00:00:00Z', resultSequence: 7, status: 'accepted', error: 'internal detail' });
  } });
  assert.deepEqual(await client.dispatch({ type: 'thread.turn.start', commandId: 'cmd-1' }), { sequence: 7 });
  assert.deepEqual(await client.readReceipt('cmd-1'),
    { status: 'accepted', aggregateKind: 'thread', aggregateId: 'thread-1', resultSequence: 7 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'http://127.0.0.1:43123/api/orchestration/dispatch');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[1].options.method, 'GET');
});

test('provider-only supplement crosses local dispatch without changing the user message', async () => {
  let sent;
  const client = new T3HttpClient(service(), { transport: async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ sequence: 12 });
  } });
  const command = { type: 'thread.turn.start', commandId: 'same-command', threadId: 'thread-1',
    message: { messageId: 'message-1', role: 'user', text: 'Reviewed request', attachments: [] },
    providerOnlyProjectContext: { version: 1, commandId: 'same-command', messageId: 'message-1',
      threadId: 'thread-1', t3ProjectId: 'native-project', providerInstanceId: 'codex',
      modelId: 'selected-model', branchRef: 'main', snapshotSequence: 7,
      draftId: 'draft-1', draftVersion: 1, fingerprint: 'a'.repeat(64),
      context: { version: 1, records: [{ version: 1, contextId: 'memory-1',
        label: '项目记忆', kind: 'project-memory', payload: { text: 'Accepted source-backed fact' } }] } },
    createdAt: '2026-09-27T00:00:00.000Z' };
  assert.deepEqual(await client.dispatch(command), { sequence: 12 });
  assert.deepEqual(sent, command);
  assert.equal(sent.message.context, undefined);
  assert.equal(sent.message.text, 'Reviewed request');
});

test('project and thread creation use the protected dispatch once without a provider turn', async () => {
  const commands = [];
  const client = new T3HttpClient(service(), { transport: async (_url, options) => {
    commands.push(JSON.parse(options.body));
    return Response.json({ sequence: commands.length });
  } });
  assert.deepEqual(await client.createCommand({ type: 'project.create', commandId: 'project-command' }), { sequence: 1 });
  assert.deepEqual(await client.createCommand({ type: 'thread.create', commandId: 'thread-command' }), { sequence: 2 });
  assert.throws(() => client.createCommand({ type: 'thread.turn.start', commandId: 'turn' }), { code: 'invalid_command' });
  assert.deepEqual(commands.map(command => command.type), ['project.create', 'thread.create']);
});

test('network loss does not replay dispatch and raw response text is never exposed', async () => {
  let attempts = 0;
  const client = new T3HttpClient(service(), { transport: async () => {
    attempts++; throw new Error(`secret ${token}`);
  } });
  await assert.rejects(client.dispatch({ commandId: 'cmd-2' }), error =>
    error instanceof T3TransportError && error.code === 'network_unavailable' && !error.message.includes(token));
  assert.equal(attempts, 1);
});

test('receipt null, malformed data, invalid origin and expired token remain read only', async () => {
  const empty = new T3HttpClient(service(), { transport: async () => Response.json(null) });
  assert.equal(await empty.readReceipt('cmd-3'), null);
  const malformed = new T3HttpClient(service(), { transport: async () => Response.json({ commandId: 'other' }) });
  await assert.rejects(malformed.readReceipt('cmd-3'), { code: 'invalid_response' });
  let requests = 0;
  const spy = async () => { requests++; return Response.json(null); };
  await assert.rejects(new T3HttpClient(service({ origin: 'https://elsewhere.invalid' }), { transport: spy }).readReceipt('cmd-3'),
    { code: 'invalid_local_service' });
  await assert.rejects(new T3HttpClient(service({ expiresAt: '2000-01-01T00:00:00Z' }), { transport: spy }).readReceipt('cmd-3'),
    { code: 'access_expired' });
  assert.equal(requests, 0);
});

test('oversized body stops before parsing and cannot grant a false receipt', async () => {
  const client = new T3HttpClient(service(), { transport: async () => new Response('{}', {
    headers: { 'Content-Length': String(9 * 1024 * 1024) },
  }) });
  await assert.rejects(client.readReceipt('cmd-4'), { code: 'response_too_large' });
});

test('stream read errors are sanitized without retrying the request', async () => {
  let requests = 0;
  const client = new T3HttpClient(service(), { transport: async () => {
    requests++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error(`secret ${token}`)); } }));
  } });
  await assert.rejects(client.readReceipt('cmd-5'), error =>
    error instanceof T3TransportError && error.code === 'invalid_response' && !error.message.includes(token));
  assert.equal(requests, 1);
});

test('environment identity is read from the fixed native descriptor', async () => {
  const paths = [];
  const client = new T3HttpClient(service(), { transport: async url => {
    paths.push(url);
    return Response.json({ environmentId: 'native-environment', privateField: 'not-forwarded' });
  } });
  assert.deepEqual(await client.environmentDescriptor(), { environmentId: 'native-environment' });
  assert.deepEqual(paths, ['http://127.0.0.1:43123/.well-known/t3/environment']);
  await assert.rejects(new T3HttpClient(service(), { transport: async () => Response.json({ environmentId: '' }) })
    .environmentDescriptor(), { code: 'invalid_response' });
});

test('thread history cursor is bounded and sent only on the protected read', async () => {
  const paths = [];
  const client = new T3HttpClient(service(), { transport: async (url, options) => {
    paths.push({ url, method: options.method });
    return Response.json({ snapshotSequence: 8, thread: { id: 'native-thread' } });
  } });
  await client.threadSnapshot('native-thread', 50, 'YWJjLWRlZg');
  assert.equal(paths.length, 1);
  assert.equal(paths[0].url,
    'http://127.0.0.1:43123/api/orchestration/threads/native-thread?turnLimit=50&beforeCursor=YWJjLWRlZg');
  assert.equal(paths[0].method, 'GET');
  assert.throws(() => client.threadSnapshot('native-thread', 50, 'bad&cursor'), { code: 'invalid_cursor' });
  assert.throws(() => client.threadSnapshot('native-thread', 50, 'a'.repeat(4097)), { code: 'invalid_cursor' });
  assert.equal(paths.length, 1);
});

test('provider model read exposes only safe account-backed catalogue fields', async () => {
  const client = new T3HttpClient(service(), { transport: async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/orchestration/provider-models');
    assert.equal(options.method, 'GET');
    return Response.json({ providers: [{ instanceId: 'codex', driver: 'codex', enabled: true,
      installed: true, status: 'ready', authStatus: 'authenticated', checkedAt: '2026-09-27T00:00:00Z',
      models: [{ slug: 'listed', name: 'Listed model', privateField: 'omit' }],
      email: 'must-not-pass-through' }] });
  } });
  assert.deepEqual(await client.providerModels(), { providers: [{ instanceId: 'codex', driver: 'codex',
    enabled: true, installed: true, status: 'ready', authStatus: 'authenticated',
    checkedAt: '2026-09-27T00:00:00Z', models: [{ id: 'listed', name: 'Listed model' }] }] });
  await assert.rejects(new T3HttpClient(service(), { transport: async () => Response.json({ providers: [{
    instanceId: 'codex', models: 'malformed',
  }] }) }).providerModels(), { code: 'invalid_response' });
});

test('native model refresh can complete beyond the ten-second provider check without replay', async () => {
  let calls = 0;
  const client = new T3HttpClient(service(), { transport: async (_url, options) => {
    calls++;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 10100);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
    });
    return Response.json({ providers: [{ instanceId: 'codex', driver: 'codex', enabled: true,
      installed: true, status: 'ready', authStatus: 'authenticated', checkedAt: new Date().toISOString(),
      models: [{ slug: 'listed', name: 'Listed model' }] }] });
  } });
  assert.equal((await client.providerModels()).providers[0].models[0].id, 'listed');
  assert.equal(calls, 1);
});

test('DSH model catalogue refreshes the exact instance and retains only verified reasoning choices', async () => {
  let response = { providers: [{ instanceId: 'dsh', driver: 'dsh', enabled: true, installed: true,
    status: 'ready', authStatus: 'authenticated', checkedAt: new Date().toISOString(),
    models: [{ slug: 'deepseek-official/deepseek-flash', name: 'Native Flash', secret: 'not forwarded',
      capabilities: { optionDescriptors: [{ id: 'reasoningEffort', type: 'select', currentValue: 'high',
        options: [{ id: 'high', label: 'High' }, { id: 'off', label: 'Off' }] }] } }] }] };
  const client = new T3HttpClient(service(), { transport: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:43123/api/orchestration/provider-models?instanceId=dsh');
    assert.equal(options.method, 'GET'); return Response.json(response);
  } });
  const result = await client.providerModels('dsh');
  assert.deepEqual(result.providers[0].models, [{ id: 'deepseek-official/deepseek-flash', name: 'Native Flash',
    reasoningEfforts: [{ id: 'high', name: 'High' }, { id: 'off', name: 'Off' }], defaultReasoningEffort: 'high' }]);
  response.providers[0].models[0].capabilities.optionDescriptors[0].currentValue = 'unlisted';
  await assert.rejects(client.providerModels('dsh'), /invalid_response/);
  await assert.rejects(client.providerModels('other'), /invalid_identifier/);
});
