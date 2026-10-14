import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startNativeReadMount } from '../../../workbench/native-mount/server.mjs';
const ws = await import(pathToFileURL(process.env.NATIVE_MOUNT_WS_MODULE).href);
test('navigation tickets recheck original identity, pair once and never expose credentials or dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aaa-board-nav-')); await writeFile(join(directory, 'index.html'), '<p>controlled</p>');
  const calls = []; let identityCurrent = true;
  const upstream = createServer((req, res) => { calls.push([req.method, req.url]); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/auth/session' ? { authenticated: true } : {})); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  const mount = await startNativeReadMount({ managementOrigin: origin, managementToken: 'm'.repeat(64), nativeOrigin: origin,
    nativeToken: 'n'.repeat(64), uiRoot: directory, nativeDist: directory,
    webSocket: { WebSocket: ws.default, WebSocketServer: ws.default.WebSocketServer },
    nativeBrowserTarget: async target => { assert.equal(target.threadId, 'original-c'); assert(identityCurrent); return '/environment/original-c'; } });
  const headers = { Authorization: 'Bearer ' + mount.token, Origin: mount.origin, 'Content-Type': 'application/json' };
  const issue = h => fetch(mount.origin + '/api/native-mount/open-browser', { method: 'POST', headers: h, body: '{"threadId":"original-c"}' });
  const launch = ticket => fetch(mount.origin + '/launch', { method: 'POST', headers: { Origin: mount.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  try {
    assert.equal((await issue({ ...headers, Authorization: '' })).status, 401);
    assert.equal((await issue({ ...headers, Origin: 'http://127.0.0.1:1' })).status, 403);
    const entry = await (await issue(headers)).json(); const ticket = new URL(entry.url).hash.slice(1);
    assert(!JSON.stringify(entry).includes('n'.repeat(64)) && !JSON.stringify(entry).includes(mount.token));
    const paired = await launch(ticket); assert.equal(paired.status, 200); assert(paired.headers.get('set-cookie')?.includes('HttpOnly'));
    assert.equal((await paired.json()).url, mount.origin + '/native/environment/original-c');
    assert.equal((await launch(ticket)).status, 401);
    const second = await (await issue(headers)).json(); identityCurrent = false;
    const changed = await launch(new URL(second.url).hash.slice(1)); assert.equal(changed.status, 503); assert.equal(changed.headers.get('set-cookie'), null);
    assert(calls.every(([method]) => method === 'GET'));
  } finally { await mount.close(); await new Promise(done => upstream.close(done)); await rm(directory, { recursive: true, force: true }); }
});
