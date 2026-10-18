import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolveDshEntryFragment, dshSessionEntryUrl, originalDshSessionEntry, validateDshEntryBinding } from './dsh-native-entry.mjs';

// The entry navigation itself is covered by dsh-session-entry.test.mjs against the client plugin that
// replaced the patched DSH bundle. What stays here is the host side: binding validation, URL shape and
// the original T3 resolver.
const sid = 't3_' + 'a'.repeat(40), other = 't3_' + 'b'.repeat(40), cwd = '/isolated project/中文';
const binding = { sessionId: sid, cwd, preset: 'desktop-pet-work-v1' };
const row = { sessionId: sid, cwd, running: false, projections: { asOfSeq: 21, values: { agentPreset: binding.preset } } };

test('bound metadata refuses missing/duplicate/wrong directory/preset/child or malformed sequence before URL delivery', () => {
  assert.deepEqual(validateDshEntryBinding(binding, { items: [row] }, 1), binding);
  for (const bad of [[], [row, row], [{ ...row, cwd: '/wrong' }], [{ ...row, origin: 'subagent' }],
    [{ ...row, parentSessionId: other }], [{ ...row, projections: { asOfSeq: -1, values: { agentPreset: binding.preset } } }],
    [{ ...row, projections: { asOfSeq: 21, values: { agentPreset: 'other' } } }]])
    assert.throws(() => validateDshEntryBinding(binding, { items: bad }, 1), /unavailable/);
  for (const capability of [0, 2, undefined]) assert.throws(() => validateDshEntryBinding(binding, { items: [row] }, capability), /unavailable/);
  for (const origin of ['https://127.0.0.1:12345', 'http://remote:12345', 'http://127.0.0.1:12345/?token=secret',
    'http://user:secret@127.0.0.1:12345', 'http://127.0.0.1:12345/#other'])
    assert.throws(() => dshSessionEntryUrl(origin, binding, 1), /unavailable/);
});

test('real original T3 binding resolver rejects changed provider/cursor/project before metadata read', async t => {
  const require = createRequire(new URL('../../../desktop-pet/package.json', import.meta.url));
  const Database = require('better-sqlite3'), db = new Database(':memory:'); t.after(() => db.close());
  const query = { environmentId: 'env', projectId: 'project', workspaceRoot: cwd, providerInstanceId: 'dsh', threadId: 'thread' };
  const native = 't3_' + createHash('sha256').update(JSON.stringify(['env', 'thread'])).digest('hex').slice(0, 40);
  db.exec('CREATE TABLE projection_threads(thread_id TEXT,project_id TEXT,deleted_at TEXT);CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT);CREATE TABLE provider_session_runtime(thread_id TEXT,provider_name TEXT,provider_instance_id TEXT,resume_cursor_json TEXT,runtime_payload_json TEXT)');
  db.prepare('INSERT INTO projection_threads VALUES(?,?,NULL)').run('thread', 'project');
  db.prepare('INSERT INTO projection_projects VALUES(?,?,NULL)').run('project', cwd);
  db.prepare('INSERT INTO provider_session_runtime VALUES(?,?,?,?,NULL)').run('thread', 'dsh', 'dsh', JSON.stringify({ sessionId: native }));
  let calls = 0;
  const context = { database: db, environmentId: 'env', origin: 'http://127.0.0.1:12345', capability: 1,
    rpc: { call: async (method, args) => { calls++; assert.equal(method, 'session/list'); assert.deepEqual(args, { _request: {} });
      return { items: [{ ...row, sessionId: native }] }; } } };
  const url = await originalDshSessionEntry(context, query);
  assert.equal(new URL(url).search, ''); assert.equal(new URL(url).hash.includes(native), true); assert.equal(calls, 1);
  for (const bad of [{ ...query, projectId: 'wrong' }, { ...query, providerInstanceId: 'codex' }, { ...query, sessionId: native }])
    await assert.rejects(originalDshSessionEntry(context, bad), /identity unavailable/);
  db.prepare('UPDATE provider_session_runtime SET resume_cursor_json=?').run(JSON.stringify({ sessionId: sid }));
  await assert.rejects(originalDshSessionEntry(context, query), /identity unavailable/); assert.equal(calls, 1);
});

test('public connection requires installed capability and original auth; one frozen endpoint/list, no credential in URL', async t => {
  const { HarnessConnection } = await import('../../../desktop-pet/dist/harness/connection.js');
  const methods = [], requests = []; let denied = false;
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    if (req.url === '/?token=fixture') { res.writeHead(denied ? 401 : 303,
      denied ? {} : { Location: './', 'Set-Cookie': 'dsh-auth-fixture=fixture.cookie' }); res.end(); return; }
    assert.equal(req.headers.cookie, 'dsh-auth-fixture=fixture.cookie');
    const parts = []; for await (const part of req) parts.push(part);
    const message = JSON.parse(Buffer.concat(parts).toString()); methods.push(message.method);
    assert.equal(message.method, 'session/list');
    res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { items: [row] } } }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port; let launches = 0;
  const launch = async () => { launches++; return origin + '/?token=fixture'; };
  await assert.rejects(new HarnessConnection(launch).workSessionUrl(binding), error => error.state === 'incompatible');
  assert.equal(launches, 0); assert.equal(requests.length, 0);
  const connection = new HarnessConnection(launch, 5000, true, 1), url = await connection.workSessionUrl(binding);
  assert.equal(launches, 1); assert.equal(new URL(url).search, ''); assert.equal(new URL(url).origin, origin);
  assert.deepEqual(methods, ['session/list']); assert.equal(url.includes('fixture'), false);
  denied = true; await assert.rejects(connection.workSessionUrl(binding), error => error.state === 'authentication_required');
  assert.deepEqual(methods, ['session/list']);
});

test('a real existing non-T3 native SID has the same exact entry validation and no replacement identity', () => {
  const id = 'session-existing-original', source = { ...binding, sessionId: id, preset: 'original-preset' };
  assert.deepEqual(validateDshEntryBinding(source, { items: [{ ...row, sessionId: id, projections: { asOfSeq: 21, values: { agentPreset: source.preset } } }] }, 1), source);
  const fragment = new URL(dshSessionEntryUrl('http://127.0.0.1:12345', source, 1)).hash;
  assert.deepEqual(resolveDshEntryFragment(fragment, { archivedSessionIds: [] }, { ids: [id], byId: { [id]: { id, cwd, parentId: null } } }), { kind: 'session', sessionId: id, cwd });
  assert.equal(resolveDshEntryFragment(fragment, { archivedSessionIds: [id] }, { ids: [id], byId: { [id]: { id, cwd } } }).kind, 'rejected');
});
