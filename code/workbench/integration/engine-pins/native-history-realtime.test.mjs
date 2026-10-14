import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const source = resolve(process.env.NATIVE_REALTIME_SOURCE ?? 'artifacts/runtime/native-history-realtime-57-edit');
const moduleAt = path => import(pathToFileURL(join(source, 'apps/server/src', path)));
const { NativeRealtimeQueue } = await moduleAt('orchestration/NativeRealtimeQueue.ts');
const { CodexNativeNotifications } = await moduleAt('provider/Layers/CodexNativeNotifications.ts');
const { DshNativeNotifications, DshFollowCursor } = await moduleAt('provider/Layers/DshNativeNotifications.ts');
const { discoverDshHistory } = await moduleAt('provider/Layers/DshHistoryDiscovery.ts');
const { HttpDshSessionRpc } = await moduleAt('provider/Layers/DshHostProtocol.ts');
const require = createRequire(join(source, 'apps/server/package.json'));
const { WebSocketServer } = require('@effect/platform-node/NodeSocket').NodeWS;
const pause = ms => new Promise(done => setTimeout(done, ms));
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'aaa-native-realtime-')));
async function until(check, timeout = 2500) { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() > deadline) throw Error('Expected native notification not delivered'); await pause(10); } }

test('dirty identities coalesce, survive an in-flight read, and stop on cancellation', async () => {
  const queue = new NativeRealtimeQueue();
  queue.mark('original-a'); queue.mark('original-a'); assert.equal(await queue.take(), 'original-a');
  queue.mark('original-a'); queue.mark('original-b'); assert.equal(await queue.take(), 'original-a'); assert.equal(await queue.take(), 'original-b');
  let settled = false; const abort = new AbortController(); const idle = queue.take(abort.signal).then(value => { settled = true; return value; });
  await pause(120); assert.equal(settled, false); abort.abort(); assert.equal(await idle, undefined); queue.close();
});

test('Codex watches only the indexed native SID and workspace; unrelated WAL changes do not re-read history', async () => {
  const home = scratch(), first = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  mkdirSync(join(home, 'sessions/2026/10/05'), { recursive: true });
  const file = join(home, 'sessions/2026/10/05', `rollout-${first}.jsonl`), unrelated = join(home, 'sessions/2026/10/05', `rollout-${other}.jsonl`);
  writeFileSync(file, '{"original":1}\n'); writeFileSync(unrelated, '{"other":1}\n');
  const db = new DatabaseSync(join(home, 'state_5.sqlite')); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,rollout_path TEXT,archived INTEGER,title TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(first, '/fixture/original', file, 0, 'original');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?)').run(other, '/fixture/other', unrelated, 0, 'other');
  const watch = new CodexNativeNotifications(home); let changes = 0;
  const close = watch.watch({ threadId: first, cwd: '/fixture/original' }, () => changes++);
  try {
    appendFileSync(unrelated, '{"other":2}\n'); db.prepare('UPDATE threads SET title=? WHERE id=?').run('other edited', other);
    await pause(160); assert.equal(changes, 0);
    appendFileSync(file, '{"original":2}\n'); await until(() => changes === 1);
    db.prepare('UPDATE threads SET title=? WHERE id=?').run('metadata only', first); await pause(160); assert.equal(changes, 1);
    db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(first); await until(() => changes === 2);
    await pause(160); assert.equal(changes, 2); close(); appendFileSync(file, '{"after-close":3}\n'); await pause(160); assert.equal(changes, 2);
  } finally { close(); watch.close(); db.close(); rmSync(home, { recursive: true, force: true }); }
});

test('DSH follow validates exact opening identity and contiguous durable seq without inventing request cursors', () => {
  const cursor = new DshFollowCursor('native-old-sid', '/fixture/original');
  const snapshot = value => ({ type: 'snapshot', header: { id: 'native-old-sid', cwd: '/fixture/original' }, cursor: value, records: [] });
  assert.equal(cursor.accept(snapshot(10)), true);
  assert.equal(cursor.accept({ type: 'event', event: { seq: 11 } }), true);
  assert.equal(cursor.accept({ type: 'event', event: { seq: 11 } }), false);
  assert.throws(() => cursor.accept({ type: 'event', event: { seq: 13 } }), /gap/);
  cursor.reconnect(); assert.equal(cursor.accept(snapshot(11)), false);
  assert.equal(cursor.accept({ type: 'event', event: { seq: 12 } }), true);
  cursor.reconnect(); assert.throws(() => cursor.accept(snapshot(9)), /scope/);
  assert.throws(() => new DshFollowCursor('original', '/fixture').accept({ ...snapshot(10), header: { id: 'different', cwd: '/fixture' } }), /scope/);
});

test('cold DSH history uses control plus file notifications, never follow, with no periodic traffic', async () => {
  const home = scratch(); mkdirSync(join(home, 'sessions/2026/native-old-sid'), { recursive: true });
  const file = join(home, 'sessions/2026/native-old-sid/session.v3.jsonl.zstd'); writeFileSync(file, 'original');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(done => server.once('listening', done));
  const requests = []; const sockets = new Set(); let control, changes = 0;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('message', bytes => {
    const request = JSON.parse(bytes.toString()); requests.push(request);
    if (request.type === 'open' && request.endpoint === 'session/control') { control = { socket, streamId: request.streamId }; socket.send(JSON.stringify({ type: 'item', streamId: request.streamId, value: { type: 'baseline', value: { projections: {} } } })); }
  }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let authenticationAttempts = 0;
  const watcher = new DshNativeNotifications(async () => { authenticationAttempts++; if (authenticationAttempts === 2) throw Error('controlled reconnect outage'); return { origin, cookie: 'fixture=local' }; }, home);
  const close = await watcher.watch('native-old-sid', '/fixture/original', () => changes++);
  try {
    assert.equal(requests.length, 1); assert.equal(requests[0].endpoint, 'session/control');
    await pause(6200); assert.equal(requests.length, 1); assert.equal(changes, 1);
    appendFileSync(file, 'new original event'); await until(() => changes === 2);
    const frame = { type: 'item', streamId: control.streamId, value: { type: 'projection', sessionId: 'native-old-sid', key: 'permissions', value: 'unchanged-source', seq: 12 } };
    control.socket.send(JSON.stringify(frame)); await until(() => changes === 3); control.socket.send(JSON.stringify(frame)); await pause(160); assert.equal(changes, 3);
    assert.equal(requests.some(r => r.endpoint === 'session/follow'), false);
    const old = control.socket; old.close(); await until(() => requests.filter(r => r.endpoint === 'session/control').length === 2, 4000); await until(() => changes >= 5);
    assert.equal(authenticationAttempts, 3);
    assert.equal(requests.some(r => ['session/create', 'session/prompt', '$events/result'].includes(r.endpoint)), false);
  } finally { close(); watcher.close(); for (const socket of sockets) socket.terminate(); await new Promise(done => server.close(done)); rmSync(home, { recursive: true, force: true }); }
});

test('an owned live DSH follower is revoked when its turn listener closes; readonly history remains', async () => {
  const home = scratch(); mkdirSync(join(home, 'sessions'), { recursive: true });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(done => server.once('listening', done));
  const requests = [], sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('message', bytes => { const request = JSON.parse(bytes.toString()); requests.push(request); if (request.type !== 'open') return;
    const value = request.endpoint === 'session/control' ? { type: 'baseline', value: { projections: {} } } : { type: 'snapshot', header: { id: 'owned', cwd: '/fixture' }, cursor: 2, records: [] };
    socket.send(JSON.stringify({ type: 'item', streamId: request.streamId, value }));
  }); });
  const watcher = new DshNativeNotifications(async () => ({ origin: `http://127.0.0.1:${server.address().port}`, cookie: 'fixture=local' }), home);
  const readonly = await watcher.watch('owned', '/fixture', () => {}), owned = await watcher.watch('owned', '/fixture', () => {}, true);
  try {
    await until(() => requests.some(r => r.endpoint === 'session/follow'));
    const follow = requests.find(r => r.endpoint === 'session/follow'); assert.deepEqual(follow.payload.args.request, { address: { kind: 'session', sessionId: 'owned' }, maxMessages: 1 });
    owned(); await until(() => requests.some(r => r.type === 'cancel' && r.streamId === follow.streamId));
    assert.equal(requests.filter(r => r.endpoint === 'session/control').length, 1);
  } finally { owned(); readonly(); watcher.close(); for (const socket of sockets) socket.terminate(); await new Promise(done => server.close(done)); rmSync(home, { recursive: true, force: true }); }
});

test('DSH discovery keeps the original legal SID, preset, real file identity and native timestamps without activation', async () => {
  const home = scratch(), id = 'session-original-existing'; mkdirSync(join(home, 'sessions/workspace', id), { recursive: true });
  writeFileSync(join(home, 'sessions/workspace', id, 'session.v4.jsonl.zstd'), 'original-native-file');
  const calls = [], row = { sessionId: id, cwd: '/fixture/original', updatedAt: 1700000001000, agentAvailable: false, running: false,
    projections: { values: { agentPreset: 'original-preset', title: 'Original title', modelSelection: { next: { provider: 'original/provider', model: 'flash' } } } } };
  const rpc = { async call(method, args) { calls.push({ method, args }); if (method === 'session/list') return { items: [row, { ...row, sessionId: 'child', parentSessionId: id }] };
    assert.equal(method, 'session/page'); assert.equal(args.request.address.sessionId, id); assert.equal(args.request.throughSeq, 0);
    return { records: [{ type: 'event', event: { seq: 0, time: 1700000000000 } }] }; } };
  try {
    const sources = await discoverDshHistory(rpc, home); assert.equal(sources.length, 1); const source = sources[0];
    assert.equal(source.sessionId, id); assert.equal(source.preset, 'original-preset'); assert.equal(source.model, 'original%2Fprovider/flash');
    assert.equal(source.createdAt, '2023-11-14T22:13:20.000Z'); assert.equal(source.updatedAt, '2023-11-14T22:13:21.000Z');
    assert.equal(source.filePath, join(home, 'sessions/workspace', id, 'session.v4.jsonl.zstd'));
    assert.deepEqual(calls.map(c => c.method), ['session/list', 'session/page']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a genuine cold legacy DSH summary is hydrated through exact-SID projections without follow or promotion', async () => {
  const home = scratch(), id = 'legacy-original'; mkdirSync(join(home, 'sessions/workspace', id), { recursive: true });
  writeFileSync(join(home, 'sessions/workspace', id, 'session.v3.jsonl.zstd'), 'original-legacy-bytes');
  const calls = [], rpc = { async call(method, args) { calls.push({ method, args });
    if (method === 'session/list') return { items: [{ sessionId: id, cwd: '/fixture/legacy', updatedAt: 1700000001000, agentAvailable: false, running: false }] };
    if (method === 'session/projections') { assert.deepEqual(args, { request: { sessionId: id } }); return { asOfSeq: 4, values: { agentPreset: 'original-preset' } }; }
    assert.equal(method, 'session/page'); return { records: [{ type: 'event', event: { seq: 0, time: 1700000000000 } }] };
  } };
  try { const sources = await discoverDshHistory(rpc, home); assert.equal(sources.length, 1); assert.equal(sources[0].sessionId, id);
    assert.deepEqual(calls.map(call => call.method), ['session/list', 'session/projections', 'session/page']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('DSH incremental reads use one compact opening index and exact-SID projections; original status events update it', async () => {
  const calls = [], sockets = new Set(); let eventStream;
  const row = { sessionId: 'original', cwd: '/fixture', agentAvailable: false, running: false, projections: { asOfSeq: 1, values: { agentPreset: 'original-preset' } } };
  const server = createServer(async (request, response) => {
    if (request.url.startsWith('/?token=')) { response.writeHead(303, { location: './', 'set-cookie': 'fixture=local' }); response.end(); return; }
    let bytes = ''; for await (const chunk of request) bytes += chunk; const input = JSON.parse(bytes); calls.push(input);
    const value = input.method === 'session/list' ? { items: [row] } : { asOfSeq: 2, values: { agentPreset: 'original-preset' } };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value } }));
  });
  const ws = new WebSocketServer({ server, path: '/api/remote.mux' });
  ws.on('connection', socket => { sockets.add(socket); socket.on('message', bytes => { const frame = JSON.parse(bytes.toString()); assert.equal(frame.endpoint, '$events'); eventStream = { socket, streamId: frame.streamId };
    socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'original-client' } })); }); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`, rpc = new HttpDshSessionRpc(async () => origin + '/?token=isolated');
  try {
    assert.equal((await rpc.nativeSummary('original')).running, false); assert.equal((await rpc.nativeSummary('original')).running, false);
    assert.deepEqual(calls.map(c => c.method), ['session/list', 'session/projections', 'session/projections']);
    eventStream.socket.send(JSON.stringify({ type: 'item', streamId: eventStream.streamId, value: { type: 'emit', event: 'api-session/status', args: ['original', true] } }));
    await pause(30); assert.equal((await rpc.nativeSummary('original')).running, true);
    assert.equal(calls.filter(c => c.method === 'session/list').length, 1);
    assert.ok(calls.filter(c => c.method === 'session/projections').every(c => c.payload.args.request.sessionId === 'original'));
  } finally { rpc.close(); for (const socket of sockets) socket.terminate(); await new Promise(done => ws.close(done)); await new Promise(done => server.close(done)); }
});

if (process.env.ACTUAL_NATIVE_PROJECT_ROOT) test('actual original native subscriptions remain readonly and do not promote cold DSH sessions', async () => {
  const root = resolve(process.env.ACTUAL_NATIVE_PROJECT_ROOT), evidence = resolve(process.env.ACTUAL_NATIVE_EVIDENCE ?? '');
  assert.ok(evidence.includes('/artifacts/integration/native-history-realtime-01/'));
  const { readEngineProfile } = await import(pathToFileURL(join(root, 'code/workbench/integration/engine-pins/profile.mjs')));
  const { readDshHost } = await import(pathToFileURL(join(root, 'code/workbench/integration/engine-pins/dsh-service.mjs')));
  const { createDshHistoryRpc } = await import(pathToFileURL(join(root, 'code/workbench/integration/engine-pins/dsh-native-history.mjs')));
  const profile = readEngineProfile(root), host = readDshHost(root, profile), rpc = await createDshHistoryRpc(root);
  const list = async () => (await rpc.call('session/list', { _request: {} })).items;
  const before = await list(); assert.equal(before.length, 4); assert.ok(before.every(row => row.agentAvailable === false && row.running === false));
  const db = new DatabaseSync(join(root, 'data/desktop-pet/t3-home/userdata/state.sqlite'), { readOnly: true });
  const binding = threadId => {
    const row = db.prepare('SELECT r.resume_cursor_json,r.runtime_payload_json,p.workspace_root FROM provider_session_runtime r JOIN projection_threads t ON t.thread_id=r.thread_id JOIN projection_projects p ON p.project_id=t.project_id WHERE r.thread_id=?').get(threadId);
    assert.ok(row); return { cursor: JSON.parse(row.resume_cursor_json), cwd: row.workspace_root };
  };
  const dsh = binding('21ce4e9b-f465-4632-8aa2-c2502c6ccc6f'), codex = binding('fb4e6739-b2bd-4c9d-800d-fc9fa57b6872');
  assert.equal(before.filter(row => row.sessionId === dsh.cursor.sessionId && row.cwd === dsh.cwd).length, 1);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const histories = {};
  for (const row of before) for (const folder of readdirSync(join(profile.dshHome, 'sessions'), { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
    for (const name of ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']) {
      const file = join(profile.dshHome, 'sessions', folder.name, row.sessionId, name);
      if (existsSync(file)) { assert.equal(realpathSync(file), file); histories[file] = digest(readFileSync(file)); }
    }
  }
  const frames = [], record = { version: 1, at: new Date().toISOString(), source, installedEngineInventory: profile.runtime.inventorySha256,
    level: 'actual original configured homes and DSH control baseline; no prompts/follow/model/device/final acceptance',
    before: before.map(row => ({ sessionId: row.sessionId, agentAvailable: row.agentAvailable, running: row.running })), frames, checks: [] };
  const authenticate = async () => {
    assert.equal(readDshHost(root, profile).childPid, host.childPid);
    const entries = [...readFileSync(profile.dshWebLog, 'utf8').matchAll(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/g)];
    const url = new URL(entries.at(-1)?.[1] ?? 'about:blank');
    assert.equal(url.origin, host.origin); assert.equal(url.pathname, '/'); assert.ok(url.searchParams.get('token'));
    assert.equal([...url.searchParams.keys()].join(','), 'token');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const cookie = response.headers.get('set-cookie')?.split(';')[0]; await response.body?.cancel();
    assert.equal(response.status, 303); assert.ok(['/', './'].includes(response.headers.get('location')));
    if (!cookie || !/^[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(cookie)) throw Error('Original DSH cookie unavailable; private value omitted');
    return { origin: host.origin, cookie };
  };
  const watcher = new DshNativeNotifications(authenticate, profile.dshHome), codexWatcher = new CodexNativeNotifications(profile.codexHome);
  const send = watcher.send.bind(watcher); watcher.send = frame => { frames.push({ type: frame.type, endpoint: frame.endpoint }); send(frame); };
  let notifications = 0, codexNotifications = 0, closeDsh, closeCodex;
  try {
    closeCodex = codexWatcher.watch({ threadId: codex.cursor.threadId, cwd: codex.cwd }, () => codexNotifications++);
    closeDsh = await watcher.watch(dsh.cursor.sessionId, dsh.cwd, () => notifications++);
    await until(() => notifications > 0);
    const count = frames.length; await pause(800); assert.equal(frames.length, count); assert.equal(codexNotifications, 0);
    assert.deepEqual(frames.filter(frame => frame.type === 'open').map(frame => frame.endpoint), ['session/control']);
    record.checks.push('genuine fixed DSH control baseline received; no session/follow or idle requests', 'original cold Codex exact-SID file/index subscription attached; unrelated activity caused no history notification');
  } finally {
    closeDsh?.(); closeCodex?.(); watcher.close(); codexWatcher.close(); db.close();
    const after = await list(); record.after = after.map(row => ({ sessionId: row.sessionId, agentAvailable: row.agentAvailable, running: row.running }));
    record.originalRowsUnchanged = digest(JSON.stringify(before)) === digest(JSON.stringify(after));
    record.originalHistoryFilesUnchanged = Object.entries(histories).every(([file, hash]) => digest(readFileSync(file)) === hash);
    record.coldAgentsStarted = after.filter(row => row.agentAvailable).length; record.followCalls = frames.filter(frame => frame.endpoint === 'session/follow').length;
    record.notifications = { dsh: notifications, codex: codexNotifications }; record.modelRequests = 0; record.devices = 0;
    mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, 'original-notifications.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    assert.equal(record.originalRowsUnchanged, true); assert.equal(record.originalHistoryFilesUnchanged, true); assert.equal(record.coldAgentsStarted, 0); assert.equal(record.followCalls, 0);
  }
});
