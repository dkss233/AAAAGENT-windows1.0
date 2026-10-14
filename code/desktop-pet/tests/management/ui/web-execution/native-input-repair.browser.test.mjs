import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { READ_RPC_METHODS, rejectRpc } from '../../../../workbench/native-mount/policy.mjs';

for (const key of ['PLAYWRIGHT_MODULE', 'NATIVE_INPUT_PROJECT_ROOT', 'NATIVE_INPUT_EVIDENCE'])
  assert.ok(process.env[key], key + ' must name an explicit existing input');
const root = resolve(process.env.NATIVE_INPUT_PROJECT_ROOT);
const output = resolve(process.env.NATIVE_INPUT_EVIDENCE);
assert.ok(output.includes('/artifacts/integration/native-input-repair-01/'));
const target = { environmentId: 'a1179513-828e-4091-a9c5-d214be6b1954',
  threadId: 'import:codex:01a0f724-4285-7752-9dfd-7bd082b0908d',
  nativeSessionId: '01a0f724-4285-7752-9dfd-7bd082b0908d' };
const playwright = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)));
const browserType = process.env.NATIVE_INPUT_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserType));
const cleanupOnly = process.env.NATIVE_INPUT_CHECK === 'cleanup';
const descriptor = JSON.parse(await readFile(join(root,
  'artifacts/W0-I/model-evaluation/trial/user-trial/management-session.json'), 'utf8'));
process.kill(descriptor.pid, 0);
const manager = new URL(descriptor.url);
assert.match(manager.hash, /^#token=[a-f0-9]{64}$/);
const opened = await fetch(manager.origin + '/api/workbench/native-open', {
  method: 'POST', headers: { Authorization: 'Bearer ' + manager.hash.slice(7),
    Origin: manager.origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ target: 'home' }), redirect: 'error', signal: AbortSignal.timeout(15000),
});
assert.equal(opened.status, 200);
const entry = await opened.json();
assert.equal(entry.status, 'ready');
const origin = new URL(entry.url).origin;
const record = { version: 1, at: new Date().toISOString(), target,
  level: 'Original installed HTTP/WS and renderer; isolated browser; input only; zero sends/models/devices',
  blockedWrites: [], excludedPassiveRpc: [], rpcTags: [], checks: [], status: 'failed' };
record.browser = browserType;
const browser = await playwright[browserType].launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
if (browserType === 'chromium') await context.grantPermissions(['local-network-access'], { origin });
await context.addInitScript(() => {
  window.__nativeInputDeviceCalls = 0;
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => {
    window.__nativeInputDeviceCalls++;
    return Promise.reject(Error('Devices excluded from input regression'));
  };
});
const navigationPosts = new Set(['/launch', '/api/native-mount/session', '/api/auth/websocket-ticket']);
await context.route('**/*', route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin || request.method() !== 'GET' && !navigationPosts.has(url.pathname)) {
    record.blockedWrites.push({ transport: 'HTTP', method: request.method(), path: url.pathname });
    return route.abort();
  }
  return route.continue();
});
const passive = new Set(['subscribeProjectClones', 'subscribeTerminalMetadata', 'subscribeVcsStatus',
  'subscribeDeviceState', 'vcs.listRefs', 'projects.readFile', 'server.discoverSourceControl',
  'vcs.refreshStatus', 'server.reportClientActivity']);
await context.routeWebSocket(/\/ws(?:\?|$)/, socket => {
  const server = socket.connectToServer();
  socket.onMessage(message => {
    let batch; try { batch = [JSON.parse(String(message))].flat(); } catch { return; }
    for (const request of batch) {
      if (request?._tag !== 'Request') continue;
      record.rpcTags.push(request.tag);
      if (!READ_RPC_METHODS.has(request.tag) && !['server.refreshProviders', 'assets.createUrl'].includes(request.tag)) {
        (passive.has(request.tag) ? record.excludedPassiveRpc : record.blockedWrites).push({ transport: 'WS', tag: request.tag });
        socket.send(JSON.stringify(rejectRpc(request.id))); return;
      }
    }
    server.send(message);
  });
  server.onMessage(message => socket.send(message));
});
const page = await context.newPage(); page.setDefaultTimeout(20000);
await mkdir(output, { recursive: true, mode: 0o700 });
try {
  await test('the exact imported original App conversation accepts editing without issuing a turn', async () => {
    try { await page.goto(entry.url, { waitUntil: 'domcontentloaded' }); }
    catch { throw Error('Original local navigation failed; private URL omitted'); }
    await page.waitForFunction(() => !!document.querySelector('.native-workbench-frame'));
    const deadline = Date.now() + 15000;
    let mount;
    while (!mount && Date.now() < deadline) {
      mount = page.frames().find(frame => frame.url().startsWith(origin + '/native/'));
      if (!mount) await page.waitForTimeout(50);
    }
    assert.ok(mount, 'Original native mount must exist');
    await mount.goto(origin + `/native/${target.environmentId}/${target.threadId}`, { waitUntil: 'domcontentloaded' });
    const editor = mount.locator('[data-testid="composer-editor"]').first();
    await editor.waitFor();
    await mount.getByText('已连接', { exact: true }).first().waitFor();
    if (cleanupOnly) {
      const deleted = ['45ab27fe-a76d-4493-aa33-d2c4b074994d', 'b9282d3c-ca63-4682-9737-7fcd7dc92af2',
        '8ca0d37e-7faa-4e52-8f2d-3b61d5531ffe', 'b5971167-01b3-4d0a-9409-1040cd1b0b42'];
      const links = await mount.locator('a[href]').evaluateAll(elements => elements.map(element => element.getAttribute('href')));
      assert.ok(deleted.every(id => !links.some(href => href?.includes(id))));
      record.deletedTargetsVisible = 0;
      record.checks.push('Original native renderer excludes four deleted test targets and opens retained original conversation');
    }
    const response = await context.request.get(origin + '/api/native-mount/targets/' + encodeURIComponent(target.threadId) + '/capabilities');
    assert.equal(response.status(), 200);
    const capability = await response.json();
    record.capability = capability;
    record.editor = await editor.evaluate(element => ({ tag: element.tagName,
      contentEditable: element.getAttribute('contenteditable'), ariaDisabled: element.getAttribute('aria-disabled'),
      disabled: element.disabled ?? null, readonly: element.readOnly ?? null }));
    record.editable = await editor.isEditable();
    record.originalAppBrowseBanner = await mount.getByText('原 App 会话当前仅支持浏览；草稿保留，未发送', { exact: false }).count() > 0;
    record.devices = await page.evaluate(() => window.__nativeInputDeviceCalls) + await mount.evaluate(() => window.__nativeInputDeviceCalls);
    await mount.locator('form').filter({ has: editor }).first().screenshot({ path: join(output, 'composer.png') }).catch(() => {});
    assert.equal(record.editable, true, 'An imported App conversation must allow local draft editing');
    await editor.click();
    await editor.pressSequentially('draft input regression');
    assert.match(await editor.innerText(), /draft input regression/);
    await editor.fill('本地输入回归检查（不发送）');
    assert.match(await editor.innerText(), /本地输入回归检查/);
    await editor.fill('已修改的本地草稿（不发送）');
    assert.match(await editor.innerText(), /已修改的本地草稿/);
    await editor.fill('');
    assert.equal(record.devices, 0);
    assert.deepEqual(record.blockedWrites, []);
    record.checks.push('Original imported thread permits typing and replacing a local draft', 'Zero execution/model/device calls');
    const send = mount.locator('button[type=submit][data-aaa-native-command="thread.turn.start"]:visible').first();
    await editor.fill('本地续聊就绪检查（不发送）');
    record.sendDisabled = await send.isDisabled();
    await editor.fill('');
    if (!cleanupOnly) assert.equal(record.sendDisabled, false, 'The exact original idle conversation must permit continuation');
    else record.checks.push('Cleanup verification only; original shared continuation remains unresolved');
    record.status = 'passed';
  });
} finally {
  await writeFile(join(output, 'observations.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  await context.close(); await browser.close();
}
