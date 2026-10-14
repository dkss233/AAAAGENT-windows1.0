import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedNativeBrowser, isolatedNativeFrameOrigin, type IsolatedWorkbenchEnvironment } from '../../../app/workbench-runtime.js';

test('isolated browser preserves exact return relation only for explicit original web navigation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aaa-isolated-browser-return-'));
  const sessionFile = join(root, 'session.json');
  const calls: unknown[] = [];
  const relation = { version: '0.1.1', origin: 'http://127.0.0.1:55737', path: '/', environmentId: 'exact-environment',
    navigationId: 'aece5ce3-b5c0-461a-9998-5a1c7b71e14b' };
  let mutate: (value: Record<string, unknown>) => Record<string, unknown> = value => value;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/api/native-mount/open-browser'); assert.equal(req.method, 'POST');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as Record<string, unknown>; calls.push(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mutate({ url: origin + '/open#' + 'a'.repeat(43),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      ...(body.originalManagementReturn ? { originalManagementReturn: relation } : {}) })));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  writeFileSync(sessionFile, JSON.stringify({ pid: process.pid, origin, token: 'a'.repeat(64) }), { mode: 0o600 });
  const environment = { environmentId: 'exact-environment', browserSessionFile: sessionFile } as IsolatedWorkbenchEnvironment;
  const browser = isolatedNativeBrowser(environment), target = { kind: 'home' as const, environmentId: 'exact-environment' };
  try {
    assert.equal(isolatedNativeFrameOrigin(environment), origin); assert.equal(calls.length, 0);
    const original = await browser.openBrowser(target, { returnToOriginalManagement: true });
    assert.deepEqual(original.originalManagementReturn, relation);
    assert.equal((await browser.openBrowser(target)).originalManagementReturn, undefined);
    assert.deepEqual(calls, [{ ...target, originalManagementReturn: true }, target]);
    for (const bad of [undefined, { ...relation, origin: 'https://evil.invalid' },
      { ...relation, origin }, { ...relation, navigationId: 'bad' }, { ...relation, path: '/other' },
      { ...relation, unexpected: true }, { ...relation, environmentId: 'foreign' }]) {
      mutate = value => ({ ...value, originalManagementReturn: bad });
      await assert.rejects(browser.openBrowser(target, { returnToOriginalManagement: true }), /Invalid original management return/);
    }
    mutate = value => ({ ...value, originalManagementReturn: relation });
    await assert.rejects(browser.openBrowser(target), /Unexpected original management return/);
    const before = calls.length;
    await assert.rejects(browser.openBrowser({ ...target, environmentId: 'foreign' }), /environment changed/);
    assert.equal(calls.length, before);
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
});
