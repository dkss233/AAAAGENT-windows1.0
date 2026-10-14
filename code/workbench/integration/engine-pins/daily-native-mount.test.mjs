import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { startDailyNativeMount, verifyDailyNativeRenderer } from './daily-native-mount.mjs';
const require = createRequire(import.meta.url);
const ws = require(new URL('../../../../artifacts/runtime/engine-pin-54/t3-runtime/apps/server/node_modules/ws/index.js', import.meta.url).pathname);

async function fixture(t) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'aaa-daily-mount-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeFiles = {};
  const html = '<html><head><script type="module" src="/native/assets/entry.js"></script></head><body>accepted native</body></html>';
  for (const [path, body] of [
    ['code/desktop-pet/t3-native/apps/web/dist/index.html', html],
    ['code/desktop-pet/t3-native/apps/web/dist/aaa-native-read-build.json', JSON.stringify({version:1,mode:'native-read',base:'/native/',buildEnvironment:{VITE_AAA_NATIVE_READ:'1'},indexSha256:createHash('sha256').update(html).digest('hex')})],
    ['code/desktop-pet/t3-native/apps/web/dist/assets/entry.js', '/* controlled entry */'],
    ['code/desktop-pet/management/ui/index.html', '<html><head></head><body>management</body></html>'],
  ]) {
    const file = resolve(root, path); await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, body);
    runtimeFiles[path] = createHash('sha256').update(body).digest('hex');
  }
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/auth/session' ?
      { authenticated: true, expiresAt: new Date(Date.now() + 600000).toISOString() } : { environmentId: 'env' }));
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(done => upstream.close(done)); });
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  let starts = 0, stopped = 0, identity = 'env';
  const service = { async start() { starts++; return { origin, accessToken: 'n'.repeat(64) }; }, async stop() { stopped++; } };
  const client = { async environmentDescriptor() { return { environmentId: identity }; } };
  return { root, runtimeFiles, origin, service, client,
    starts: () => starts, stopped: () => stopped, changeIdentity() { identity = 'changed'; } };
}

test('daily mount uses the existing native host and preserves original management return without dispatch', async t => {
  const f = await fixture(t);
  const mount = await startDailyNativeMount({ projectRoot: f.root, runtimeFiles: f.runtimeFiles,
    runtimeSourceDir: f.root, nodeExecutable: process.execPath, managementOrigin: f.origin,
    managementToken: 'm'.repeat(64), service: f.service, client: f.client,
    webSocket: { WebSocket: ws, WebSocketServer: ws.WebSocketServer } });
  t.after(mount.close);
  assert.equal(f.starts(), 1);
  const entry = await mount.openBrowser({ kind: 'home', environmentId: 'env' }, { returnToOriginalManagement: true });
  assert.equal(new URL(entry.url).origin, mount.origin);
  assert.equal(entry.originalManagementReturn.origin, f.origin);
  assert.equal(entry.originalManagementReturn.environmentId, 'env');
  const request = () => fetch(mount.origin + '/launch', { method: 'POST',
    headers: { Origin: mount.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: new URL(entry.url).hash.slice(1) }) });
  const response = await request(); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.originalManagementReturn.navigationId, entry.originalManagementReturn.navigationId);
  assert.equal((await request()).status, 401);
  f.changeIdentity();
  await assert.rejects(mount.openBrowser({ kind: 'home', environmentId: 'env' }));
  assert.equal(f.stopped(), 0);
  assert.deepEqual(mount.audit().rpcAllowed, {});
});

test('daily renderer refuses added, changed or missing installed resources', async t => {
  const f = await fixture(t);
  await verifyDailyNativeRenderer(f.root, f.runtimeFiles);
  const index = resolve(f.root, 'code/desktop-pet/t3-native/apps/web/dist/index.html');
  await writeFile(index, 'changed'); await assert.rejects(verifyDailyNativeRenderer(f.root, f.runtimeFiles));
  await writeFile(index, '<html><head><script type="module" src="/native/assets/entry.js"></script></head><body>accepted native</body></html>');
  const extra = resolve(index, '../extra.js'); await writeFile(extra, 'extra');
  await assert.rejects(verifyDailyNativeRenderer(f.root, f.runtimeFiles));
  await rm(extra);
  await rm(index); await assert.rejects(verifyDailyNativeRenderer(f.root, f.runtimeFiles));
});

test('a fully pinned root-path build is refused before starting any native service', async t => {
  const f = await fixture(t), path = 'code/desktop-pet/t3-native/apps/web/dist/index.html';
  const wrong = '<html><script type="module" src="/assets/full-entry.js"></script></html>';
  await writeFile(resolve(f.root, path), wrong);
  f.runtimeFiles[path] = createHash('sha256').update(wrong).digest('hex');
  await assert.rejects(verifyDailyNativeRenderer(f.root, f.runtimeFiles), /under \/native\//);
  assert.equal(f.starts(), 0);
});
