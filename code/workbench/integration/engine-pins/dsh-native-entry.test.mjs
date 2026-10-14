import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { resolveDshEntryFragment, dshSessionEntryUrl, originalDshSessionEntry, validateDshEntryBinding } from './dsh-native-entry.mjs';
import { navigationSource, patchDshNativeNavigation, prepareDshNativeNavigation } from '../dsh-patches/native-session-navigation.mjs';

const originalFile = process.env.DSH_NATIVE_CLIENT;
assert.ok(originalFile, 'Supply the actual pinned DSH native client for candidate checks');
const original = readFileSync(originalFile), patched = patchDshNativeNavigation(original);
const sid = 't3_' + 'a'.repeat(40), other = 't3_' + 'b'.repeat(40), cwd = '/isolated project/中文';
const binding = { sessionId: sid, cwd, preset: 'desktop-pet-work-v1' };
const row = { sessionId: sid, cwd, running: false, projections: { asOfSeq: 21, values: { agentPreset: binding.preset } } };
const hash = (id = sid, path = cwd) => new URL(dshSessionEntryUrl('http://127.0.0.1:12345', { ...binding, sessionId: id, cwd: path }, 1)).hash;

function store(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, set: next => { value = next; for (const fn of listeners) fn(); },
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
}

/** Execute the actual patched native class, with isolated stores, no browser or native service. */
function nativeClient(fragment, { ready = true, failOpen = false, blank = false, saved = other, reference } = {}) {
  const text = patched.toString('utf8'), start = text.indexOf('const aaaagentEntryTarget =');
  const end = text.indexOf('\n\t\t/**\n\t\t* `error`', start);
  assert.ok(start >= 0 && end > start);
  const listeners = new Map(), notices = [], opened = [], released = [], panels = [];
  const sandbox = { URLSearchParams, AbortController, AbortSignal, location: { hash: fragment }, console,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    _deepseek_ai_cordis: { Service: class { constructor(ctx) { this.ctx = ctx; } } },
    _deepseek_ai_dsh_client_store: { createSnapshotStore: () => store(saved === null ? {} : { sessionId: saved }) } };
  vm.runInNewContext(text.slice(start, end) + '\nglobalThis.NativeClass = UiWorkspaceService;', sandbox);
  const workspaces = { list: store({ phase: ready ? 'ready' : 'loading', items: [], archivedSessionIds: [] }) };
  const sessions = { list: store({ phase: ready ? 'ready' : 'loading', ids: [sid, other], byId: {
    [sid]: { id: sid, cwd, blank }, [other]: { id: other, cwd, blank: false } } }),
    retain: target => { opened.push(target); return (typeof reference === 'function' ? reference(target) : reference) ?? { sessionId: target,
      ready: failOpen ? Promise.reject(Error('isolated open failure')) : Promise.resolve({ sessionId: target,
        session: { getSnapshot: () => ({ sessionId: target, openState: 'open', openError: null, removed: false, subagent: null }) } }),
      release: () => released.push(target) }; },
    subagentAddress: () => undefined,
    create: () => { throw Error('Unexpected native session creation'); } };
  const ctx = { effect: () => {}, layout: { selectPanel: panel => panels.push(panel), beginNavigation: () => new AbortController().signal } };
  const service = new sandbox.NativeClass(ctx, {}, workspaces, sessions, {}, notice => notices.push(notice));
  return { service, sandbox, workspaces, sessions, notices, opened, released, panels, listeners };
}

test('pinned source and candidate preparation reject drift/reapplication/existing output; original unchanged', t => {
  assert.equal(createHash('sha256').update(original).digest('hex'), navigationSource.sourceSha256);
  assert.throws(() => patchDshNativeNavigation(Buffer.concat([original, Buffer.from('\n')])), /source changed/);
  assert.throws(() => patchDshNativeNavigation(patched), /source changed/);
  const temp = mkdtempSync(join(tmpdir(), 'dsh-native-entry-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const output = join(temp, 'client.js'), receipt = prepareDshNativeNavigation(originalFile, output);
  assert.equal(receipt.capabilityVersion, 1); assert.equal(receipt.currentRuntimeInstalled, false);
  assert.deepEqual(readFileSync(output), patched); assert.deepEqual(readFileSync(originalFile), original);
  assert.throws(() => prepareDshNativeNavigation(originalFile, output), /EEXIST/);
  writeFileSync(output, 'unrelated candidate'); assert.throws(() => prepareDshNativeNavigation(output, join(temp, 'other.js')), /source changed/);
});

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

test('actual patched native restore selects exact existing SID before blank/default creation, including empty storage', async () => {
  for (const saved of [other, sid, null]) {
    const f = nativeClient(hash(), { blank: true, saved });
    await f.service.restoreSelection(f.workspaces.list.getSnapshot(), f.sessions.list.getSnapshot());
    assert.deepEqual(f.opened, [sid]); assert.equal(f.service.selection.getSnapshot().sessionId, sid);
    assert.deepEqual(f.notices, []); assert.deepEqual(f.panels, [null]);
  }
});

test('actual patched native restore visibly refuses invalid/wrong/archived/child entry, no fallback or saved selection change', async () => {
  const invalid = [hash() + '&sid=' + other, hash() + '&token=secret', hash(other, '/wrong'),
    '#aaaagent-session=2&sid=' + sid + '&cwd=%2F', '#aaaagent-session', hash('t3_' + 'c'.repeat(40)),
    hash().replace('%2F', '%2f')];
  for (const fragment of invalid) {
    const f = nativeClient(fragment);
    await f.service.restoreSelection(f.workspaces.list.getSnapshot(), f.sessions.list.getSnapshot());
    assert.deepEqual(f.opened, []); assert.equal(f.service.selection.getSnapshot().sessionId, other);
    assert.equal(f.notices.length, 1); assert.equal(f.notices[0].kind, 'aaaagentEntryFailed');
  }
  for (const change of ['archived', 'child', 'duplicate']) {
    const f = nativeClient(hash());
    if (change === 'archived') f.workspaces.list.set({ ...f.workspaces.list.getSnapshot(), archivedSessionIds: [sid] });
    if (change === 'child') f.sessions.list.getSnapshot().byId[sid].parentId = other;
    if (change === 'duplicate') f.sessions.list.getSnapshot().ids.push(sid);
    await f.service.restoreSelection(f.workspaces.list.getSnapshot(), f.sessions.list.getSnapshot());
    assert.deepEqual(f.opened, []); assert.equal(f.notices.length, 1);
  }
});

test('normal saved selection restoration is preserved, and exact open failure does not create or retry', async () => {
  const normal = nativeClient(''); await normal.service.restoreSelection(normal.workspaces.list.getSnapshot(), normal.sessions.list.getSnapshot());
  assert.deepEqual(normal.opened, [other]); assert.equal(normal.notices.length, 0);
  const fail = nativeClient(hash(), { failOpen: true });
  await fail.service.restoreSelection(fail.workspaces.list.getSnapshot(), fail.sessions.list.getSnapshot());
  assert.deepEqual(fail.opened, [sid]); assert.equal(fail.notices.length, 1);
});

test('actual native remote-failure and ready code resolve an error binding; patched entry warns without fallback', async () => {
  const file = originalFile.replace('/dsh-client-ui-workspace/', '/dsh-api-session-controller/');
  const source = readFileSync(file, 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), navigationSource.sessionClientSha256);
  const openStart = source.indexOf('async doOpen(generation) {');
  const openEnd = source.indexOf('\n\t\t\t/** Apply one contiguous', openStart);
  const remoteError = { rpcError: { code: 'fixture/failed', message: 'private raw failure must not be shown' } };
  const controller = vm.runInNewContext('({' + source.slice(openStart, openEnd) + '})', {
    SessionEventStream: class { async open() { throw remoteError; } }, HISTORY_PAGE_OPTIONS: {},
    _deepseek_ai_dsh_api_gateway_client: { isRemoteFailure: error => error === remoteError } });
  const state = { openGeneration: 1, events: undefined, notifier: { markDirty: () => {} }, sessionAddress: () => ({ sessionId: sid }) };
  const opening = controller.doOpen.call(state, 1); await opening;
  assert.equal(state.openState, 'error'); assert.equal(state.openError, remoteError);
  const refStart = source.indexOf('async function waitForOpen(opening, signal) {');
  const refEnd = source.indexOf('\n\t\t/** Host catalog and local reference allocator', refStart);
  class FixturePromise extends Promise {
    static withResolvers() { let resolve, reject; const promise = new FixturePromise((ok, fail) => { resolve = ok; reject = fail; });
      return { promise, resolve, reject }; }
  }
  const Reference = vm.runInNewContext(source.slice(refStart, refEnd) + '\nClientSessionReference;', {
    AbortController, AbortSignal, Promise: FixturePromise, Symbol });
  const record = { live: true, binding: { sessionId: sid, session: { getSnapshot: () => ({ sessionId: sid,
    openState: state.openState, openError: state.openError, removed: false, subagent: null }) } } };
  const reference = new Reference(sid, record, () => {}); reference.attachOpening(opening);
  assert.equal((await reference.ready).sessionId, sid);
  const f = nativeClient(hash(), { reference });
  await f.service.restoreSelection(f.workspaces.list.getSnapshot(), f.sessions.list.getSnapshot());
  assert.deepEqual(f.opened, [sid]); assert.equal(f.notices.length, 1); assert.equal(f.notices[0].kind, 'aaaagentEntryFailed');
  assert.equal(JSON.stringify(f.notices).includes('private'), false);
});

test('native watcher waits ready lists, supports hash navigation to another existing target and removes listener', async () => {
  const f = nativeClient(hash(), { ready: false }), stop = f.service.watchNavigation();
  assert.deepEqual(f.opened, []);
  f.workspaces.list.set({ ...f.workspaces.list.getSnapshot(), phase: 'ready' });
  f.sessions.list.set({ ...f.sessions.list.getSnapshot(), phase: 'ready' });
  await Promise.resolve(); await Promise.resolve(); assert.deepEqual(f.opened, [sid]);
  f.sandbox.location.hash = hash(other); f.listeners.get('hashchange')();
  await Promise.resolve(); await Promise.resolve(); assert.deepEqual(f.opened, [sid, other]);
  f.listeners.get('hashchange')(); assert.equal(f.opened.length, 2);
  f.sandbox.location.hash = hash(other, '/wrong'); f.listeners.get('hashchange')();
  await Promise.resolve(); await Promise.resolve(); assert.equal(f.opened.length, 2); assert.equal(f.notices.length, 1);
  stop(); assert.equal(f.listeners.size, 0);
});

test('late failure of a released entry cannot replace or warn over a newer selected target', async () => {
  let reject;
  const ready = new Promise((_, fail) => { reject = fail; });
  const reference = { sessionId: sid, ready, release: () => {} };
  const f = nativeClient(hash(), { reference: target => target === sid ? reference : undefined });
  const old = f.service.restoreSelection(f.workspaces.list.getSnapshot(), f.sessions.list.getSnapshot());
  f.sandbox.location.hash = hash(other);
  await f.service.restoreSelection(f.workspaces.list.getSnapshot(), f.sessions.list.getSnapshot());
  reject(Error('released old opening')); await old;
  assert.deepEqual(f.opened, [sid, other]); assert.equal(f.service.selection.getSnapshot().sessionId, other);
  assert.equal(f.notices.length, 0);
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
