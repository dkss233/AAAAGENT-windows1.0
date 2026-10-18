import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { navigationSource } from '../dsh-patches/native-session-navigation.mjs';
import { expectedDshNavigationModule, verifyDshNavigationHost } from './dsh-navigation-runtime.mjs';
import { HarnessConnection } from '../../../desktop-pet/dist/harness/connection.js';
import { originalDshNavigationEntry } from '../../../desktop-pet/tools/engine-pins/dsh-native-entry.mjs';
import { manualDshHandoff, dshBrowserRequest } from '../../../desktop-pet/tools/engine-pins/dsh-native-entry.mjs';
import { dshSessionEntryUrl } from './dsh-native-entry.mjs';
import vm from 'node:vm';
import { isTrialRuntimePath } from '../../../desktop-pet/dist/app/trial-config.js';

const candidate = readFileSync(process.env.DSH_NAVIGATION_CANDIDATE);
const controller = readFileSync(process.env.DSH_SESSION_CLIENT);
const rev = '0123456789ab', sid = 't3_' + 'a'.repeat(40), cwd = '/original project';
const binding = { sessionId: sid, cwd, preset: 'desktop-pet-work-v1' };

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-navigation-serve-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [packageName, bytes] of [[navigationSource.package, candidate], ['@deepseek-ai/dsh-api-session-controller', controller]]) {
    const file = join(root, 'dsh/node_modules', packageName, 'lib/client.js'); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
  }
  const options = { failAuth: false, badIndex: false, badGraph: false, duplicateGraph: false, badModule: false, changedOwner: false }, calls = [];
  let origin;
  const server = createServer(async (req, res) => {
    calls.push({ path: req.url, method: req.method });
    if (req.url === '/?token=isolated') { res.writeHead(options.failAuth ? 401 : 303, { 'set-cookie': 'dsh=isolated', location: './' }); return res.end(); }
    if (req.headers.cookie !== 'dsh=isolated') { res.writeHead(401); return res.end(); }
    if (req.url === '/') {
      const entry = { id: navigationSource.package, rev, url: 'plugins/??' + navigationSource.package + '/client.js&rev=' + rev };
      if (options.badGraph) entry.url = 'http://remote.invalid/client.js';
      const graph = JSON.stringify({ entries: [entry] }); res.setHeader('content-type', 'text/html');
      return res.end(options.badIndex ? 'ordinary page' : '<script>globalThis["__DSH_BOOT__"] = ' + graph + '</script>' +
        (options.duplicateGraph ? '<script>globalThis["__DSH_BOOT__"] = ' + graph + '</script>' : ''));
    }
    if (req.url.startsWith('/plugins/??')) { res.setHeader('content-type', 'text/javascript'); return res.end(options.badModule ? Buffer.from('stale served factory') : expectedDshNavigationModule(candidate, rev)); }
    if (req.url === '/api/session/list') {
      let raw = ''; for await (const part of req) raw += part;
      const request = JSON.parse(raw); res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [{ ...binding,
        running: false, projections: { asOfSeq: 1, values: { agentPreset: binding.preset } } }] } } }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
  origin = 'http://127.0.0.1:' + server.address().port;
  const profile = { projectRoot: root, runtimeRoot: root, home: root + '/home', dshHome: root + '/original-dsh-home', runtime: { inventorySha256: 'a'.repeat(64) } };
  const host = { ...profile, origin, pid: 101, childPid: 102, nonce: 'isolated-owner', dataHome: profile.dshHome, inventorySha256: profile.runtime.inventorySha256 };
  let reads = 0;
  const input = () => ({ profile, readHost: () => { reads++; return { ...host, ...(options.changedOwner && reads > 1 ? { childPid: 103 } : {}) }; },
    launchUrl: origin + '/?token=isolated', expectedOrigin: origin });
  return { origin, options, calls, input: () => { reads = 0; return input(); } };
}

test('actual authenticated index graph and full module bytes establish only matching owner capability', async t => {
  const f = await fixture(t), proof = await verifyDshNavigationHost(f.input());
  // The served client is the published bundle: the entry navigation is a plugin now, not a patch.
  assert.equal(proof.capabilityVersion, 1); assert.equal(proof.clientSha256, navigationSource.sourceSha256);
  assert.equal(proof.actualServedBytesVerified, true); assert.equal(proof.authenticatedIndexVerified, true);
  assert.equal(proof.servedSha256, createHash('sha256').update(expectedDshNavigationModule(candidate, rev)).digest('hex'));
  assert.deepEqual(f.calls.map(x => x.method), ['GET', 'GET', 'GET']);
});

test('auth, graph, stale served factory and owner drift reject instead of treating installed bytes as capability', async t => {
  const f = await fixture(t);
  for (const key of ['failAuth', 'badIndex', 'badGraph', 'duplicateGraph', 'badModule', 'changedOwner']) {
    f.options[key] = true;
    await assert.rejects(verifyDshNavigationHost(f.input()), { message: 'Original DSH navigation capability unavailable' });
    f.options[key] = false;
  }
  const input = f.input(); input.expectedOrigin = 'http://127.0.0.1:1'; const count = f.calls.length;
  await assert.rejects(verifyDshNavigationHost(input)); assert.equal(f.calls.length, count);
});

test('public caller performs live proof before bound list; negative capability cannot issue session RPC', async t => {
  const f = await fixture(t), connection = new HarnessConnection(async () => f.origin + '/?token=isolated', 1000, true,
    async origin => (await verifyDshNavigationHost({ ...f.input(), expectedOrigin: origin })).capabilityVersion);
  const url = new URL(await connection.workSessionUrl(binding));
  assert.equal(url.origin, f.origin); assert.equal(url.search, ''); assert.equal(url.hash.includes(sid), true);
  assert.equal(f.calls.filter(x => x.path === '/api/session/list').length, 1);
  f.options.badModule = true;
  await assert.rejects(connection.workSessionUrl(binding));
  assert.equal(f.calls.filter(x => x.path === '/api/session/list').length, 1);
  const disabled = new HarnessConnection(async () => { throw Error('Disabled capability must not launch'); });
  await assert.rejects(disabled.workSessionUrl(binding));
});

test('original public query caller rechecks actual SQLite binding after asynchronous navigation and never writes', async t => {
  const require = createRequire(new URL('../../../desktop-pet/package.json', import.meta.url));
  const Database = require('better-sqlite3'), db = new Database(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE projection_threads(thread_id TEXT,project_id TEXT,deleted_at TEXT); CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT); CREATE TABLE provider_session_runtime(thread_id TEXT,provider_name TEXT,provider_instance_id TEXT,resume_cursor_json TEXT,runtime_payload_json TEXT)');
  const query = { environmentId: 'original-env', projectId: 'original-project', workspaceRoot: cwd, providerInstanceId: 'dsh', threadId: 'original-thread' };
  const native = 't3_' + createHash('sha256').update(JSON.stringify([query.environmentId, query.threadId])).digest('hex').slice(0, 40);
  db.prepare('INSERT INTO projection_threads VALUES(?,?,NULL)').run(query.threadId, query.projectId);
  db.prepare('INSERT INTO projection_projects VALUES(?,?,NULL)').run(query.projectId, cwd);
  db.prepare('INSERT INTO provider_session_runtime VALUES(?,?,?,?,NULL)').run(query.threadId, 'dsh', 'dsh', JSON.stringify({ sessionId: native }));
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  const result = await originalDshNavigationEntry(db, query.environmentId, query, { workSessionUrl: async target => { assert.equal(target.sessionId, native); return 'http://127.0.0.1:1/#isolated'; } });
  assert.equal(result.capabilityVersion, 1); assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  await assert.rejects(originalDshNavigationEntry(db, query.environmentId, query, { workSessionUrl: async () => {
    db.prepare('UPDATE projection_projects SET workspace_root=?').run('/changed'); return 'http://127.0.0.1:1/#isolated';
  } }), /binding|identity/);
});

test('normal runtime allowlist admits only the fixed workspace client and two patch files', () => {
  const prefix = 'artifacts/runtime/engines-codex-0.160.0-dsh-0.2.0-rc.2-darwin-arm64/dsh/node_modules/';
  assert.equal(isTrialRuntimePath(prefix + navigationSource.package + '/lib/client.js'), true);
  for (const path of ['@deepseek-ai/dsh-client-connection/lib/index.js', navigationSource.package + '/lib/index.js', navigationSource.package + '/lib/../client.js'])
    assert.equal(isTrialRuntimePath(prefix + path), false);
  assert.equal(isTrialRuntimePath('code/workbench/integration/dsh-patches/unregistered.js'), false);
});

test('manual handoff requires explicit user start and current verified owner before reading private launch', async () => {
  let reads = 0, opened = 0;
  const origin = 'http://127.0.0.1:12345', entry = { capabilityVersion: 1, binding, url: dshSessionEntryUrl(origin, binding, 1) };
  const options = { manual: true, entry, currentOrigin: origin, readLaunchUrl: async () => { reads++; return origin + '/?token=fixture-only'; },
    ownerStillCurrent: async () => true, open: async () => { opened++; } };
  for (const bad of [{ manual: false }, { manual: undefined }, { entry: { ...entry, capabilityVersion: 0 } },
    { entry: { ...entry, url: entry.url + '&unexpected=1' } }, { ownerStillCurrent: async () => false }])
    await assert.rejects(manualDshHandoff({ ...options, ...bad }), { message: 'Original DSH manual handoff unavailable' });
  assert.equal(reads, 0); assert.equal(opened, 0);
  let checks = 0;
  await assert.rejects(manualDshHandoff({ ...options, ownerStillCurrent: async () => ++checks === 1 }));
  assert.equal(reads, 1); assert.equal(opened, 0);
});

test('manual original login preserves exact fragment, excludes foreign/credential ambiguities and sanitizes failure', async () => {
  const origin = 'http://127.0.0.1:12345', entry = { capabilityVersion: 1, binding, url: dshSessionEntryUrl(origin, binding, 1) };
  let privateTarget, opens = 0;
  const options = { manual: true, entry, currentOrigin: origin, readLaunchUrl: async () => origin + '/?token=fixture-only',
    ownerStillCurrent: async () => true, open: async value => { privateTarget = new URL(value); opens++; } };
  const result = await manualDshHandoff(options);
  assert.equal(opens, 1); assert.equal(privateTarget.origin, origin); assert.equal(privateTarget.hash, new URL(entry.url).hash);
  assert.equal(privateTarget.searchParams.get('token'), 'fixture-only'); assert.equal(result.cleanUrl, entry.url);
  assert.equal(JSON.stringify(result).includes('fixture-only'), false);
  for (const value of ['http://remote.invalid/?token=fixture-only', origin + '/?token=fixture-only&token=another',
    origin + '/?token=fixture-only&other=1', origin + '/?token=fixture-only#unverified'])
    await assert.rejects(manualDshHandoff({ ...options, readLaunchUrl: async () => value }));
  assert.equal(opens, 1);
  await assert.rejects(manualDshHandoff({ ...options, open: async () => { throw Error('fixture-only private launch'); } }),
    { message: 'Original DSH manual handoff unavailable' });
});

test('manual macOS adapter puts private URL solely in stdin; fixed argv/output are safe and script handles quoted text', () => {
  const url = 'http://127.0.0.1:12345/?token=fixture-only#' + encodeURIComponent('中文 " $(never run)');
  const request = dshBrowserRequest(url);
  assert.deepEqual(request.args, ['-l', 'JavaScript']); assert.deepEqual(request.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(JSON.stringify([request.executable, request.args]).includes('fixture-only'), false);
  let opened;
  vm.runInNewContext(request.input, { ObjC: { import() {} }, $: { NSURL: { URLWithString: value => value },
    NSWorkspace: { sharedWorkspace: { openURL: value => { opened = value; return true; } } } } });
  assert.equal(opened, url);
});
