import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, stat, utimes } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { READ_RPC_METHODS, rejectRpc } from '../../../../workbench/native-mount/policy.mjs';

for (const name of ['PLAYWRIGHT_MODULE', 'NATIVE_SYNC_PROJECT_ROOT', 'NATIVE_SYNC_EVIDENCE'])
  assert.ok(process.env[name], name + ' must identify an explicit existing input');
const root = resolve(process.env.NATIVE_SYNC_PROJECT_ROOT), output = resolve(process.env.NATIVE_SYNC_EVIDENCE);
assert.ok(output.includes('/artifacts/integration/native-history-realtime-01/'));
const renderer = process.env.NATIVE_SYNC_RENDERER ? resolve(process.env.NATIVE_SYNC_RENDERER) : null;
if (renderer) assert.ok(renderer.includes('/artifacts/runtime/') && renderer.endsWith('/apps/web/dist'));
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = text => String(text).replace(/(?:https?|wss?):\/\/\S+/g, '[URL omitted]')
  .replace(/[a-f0-9]{64}/g, '[digest omitted]').slice(0, 2000);
async function checkOriginalRenderer() {
const descriptor = JSON.parse(await readFile(join(root, 'artifacts/W0-I/model-evaluation/trial/user-trial/management-session.json'), 'utf8'));
const metadata = JSON.parse(await readFile(join(root, 'docs/agent/blackboard/OWNERSHIP.json'), 'utf8')).external_user_flow_20261004.metadata;
const manager = new URL(descriptor.url); assert.match(manager.hash, /^#token=[a-f0-9]{64}$/); process.kill(descriptor.pid, 0);
const headers = { Authorization: 'Bearer ' + manager.hash.slice(7), Origin: manager.origin, 'Content-Type': 'application/json' };
async function original(path, body) {
  const response = await fetch(manager.origin + path, { method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, 'Original local operation must remain available: ' + path);
  return response.json();
}
const snapshot = await original('/api/snapshot');
assert.equal(snapshot.runtime.pid, descriptor.pid); assert.equal(snapshot.runtime.instanceId, descriptor.instanceId);
// Reuse the original precreated C; this navigation creates no thread, SID, turn or prompt.
const entry = await original('/api/workbench/native-open', { target: 'task', projectId: metadata.localProjectId, taskId: metadata.taskIds.C });
assert.equal(entry.status, 'ready'); const destination = new URL(entry.url); assert.equal(destination.pathname, '/open');
const record = { version: 1, at: new Date().toISOString(), installedSource: descriptor.sourceRevision,
  level: 'compiled renderer over original installed HTTP/WS; isolated headless context; static replacement only; no model/device/final acceptance',
  target: { environmentId: metadata.environmentId, projectId: metadata.projectId, threadId: metadata.threads.C },
  renderer: renderer ? { directory: renderer, receipt: JSON.parse(await readFile(join(renderer, 'aaa-native-read-build.json'), 'utf8')), assets: [] } : null,
  requests: [], rpcTags: [], rpcExits: [], blockedWrites: [], excludedPassiveRpc: [], errors: [], console: [], httpFailures: [], descriptors: [], checks: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
// A fresh headless Chromium otherwise blocks loopback WS before it reaches the
// original mount. Grant only this test context's exact original local origin.
await context.grantPermissions(['local-network-access'], { origin: destination.origin });
record.headlessPermission = { name: 'local-network-access', scope: 'exact original loopback origin; isolated test context only' };
await context.addInitScript(() => {
  window.__nativeSyncDeviceCalls = 0;
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => {
    window.__nativeSyncDeviceCalls++; return Promise.reject(Error('Devices disabled in this internal check'));
  };
});
const navigationPosts = new Set(['/launch', '/api/native-mount/session', '/api/auth/websocket-ticket']);
const passive = new Set(['subscribeProjectClones', 'subscribeTerminalMetadata', 'subscribeVcsStatus',
  'subscribeDeviceState', 'vcs.listRefs', 'projects.readFile', 'server.discoverSourceControl', 'vcs.refreshStatus', 'server.reportClientActivity']);
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  record.requests.push({ method: request.method(), path: url.pathname });
  if (url.origin !== destination.origin || request.method() !== 'GET' && !navigationPosts.has(url.pathname)) {
    record.blockedWrites.push({ transport: 'HTTP', method: request.method(), path: url.pathname }); return route.abort();
  }
  if (renderer && request.method() === 'GET' && url.pathname.startsWith('/native/')) {
    const relative = decodeURIComponent(url.pathname.slice('/native/'.length));
    let file = resolve(renderer, relative); assert.ok(file === renderer || file.startsWith(renderer + '/'));
    let present = false; try { present = (await stat(file)).isFile(); } catch { /* Upstream SPA fallback. */ }
    if (!present && !relative.split('/').at(-1).includes('.')) file = join(renderer, 'index.html');
    if (present || file === join(renderer, 'index.html')) {
      const bytes = await readFile(file), extension = file.split('.').at(-1);
      const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json',
        svg: 'image/svg+xml', png: 'image/png', wasm: 'application/wasm', woff2: 'font/woff2' };
      record.renderer.assets.push({ path: file.slice(renderer.length + 1), sha256: sha(bytes) });
      return route.fulfill({ status: 200, contentType: types[extension] ?? 'application/octet-stream', body: bytes });
    }
  }
  return route.continue();
});
const requests = new Map();
await context.routeWebSocket(/\/ws(?:\?|$)/, socket => {
  const server = socket.connectToServer();
  socket.onMessage(message => {
    let batch; try { batch = [JSON.parse(String(message))].flat(); } catch { record.blockedWrites.push({ transport: 'invalid-WS' }); return; }
    for (const frame of batch) {
      if (frame?._tag !== 'Request') continue;
      requests.set(String(frame.id), frame.tag); record.rpcTags.push(frame.tag);
      if (!READ_RPC_METHODS.has(frame.tag) && !['server.refreshProviders', 'assets.createUrl'].includes(frame.tag)) {
        (passive.has(frame.tag) ? record.excludedPassiveRpc : record.blockedWrites).push({ transport: 'WS', tag: frame.tag });
        socket.send(JSON.stringify(rejectRpc(frame.id))); return;
      }
    }
    server.send(message);
  });
  server.onMessage(message => {
    try {
      for (const frame of [JSON.parse(String(message))].flat()) if (frame?._tag === 'Exit')
        record.rpcExits.push({ tag: requests.get(String(frame.requestId)), status: frame.exit?._tag,
          ...(frame.exit?._tag === 'Failure' ? { cause: safe(JSON.stringify(frame.exit.cause)) } : {}) });
    } catch { /* Diagnostic recording never changes the forwarded original frame. */ }
    socket.send(message);
  });
});
const page = await context.newPage(); page.setDefaultTimeout(20000);
page.on('pageerror', error => record.errors.push({ name: error.name, message: safe(error.message) }));
page.on('console', message => { if (['error', 'warning'].includes(message.type())) record.console.push(safe(message.text())); });
const pending = new Set();
page.on('response', response => {
  const path = new URL(response.url()).pathname;
  if (response.status() >= 400) record.httpFailures.push({ path, status: response.status() });
  if (path !== '/.well-known/t3/environment' && path !== '/api/auth/session') return;
  const work = response.json().then(value => record.descriptors.push({ path, status: response.status(), keys: Object.keys(value),
    environmentId: value.environmentId, serverVersion: value.serverVersion, protocol: value.orchestrationProtocolVersion,
    ...(path === '/api/auth/session' ? { authenticated: value.authenticated, mode: value.mode } : {}) })).catch(() => {});
  pending.add(work); void work.finally(() => pending.delete(work));
});
await mkdir(output, { recursive: true, mode: 0o700 });
try {
  await test('fresh original C renderer connects and preserves the original SID gate without an execution request', async () => {
    try { await page.goto(entry.url, { waitUntil: 'domcontentloaded' }); } catch { throw Error('Original one-use navigation failed; private URL omitted'); }
    const pathname = `/native/${metadata.environmentId}/${metadata.threads.C}`;
    const native = () => page.frames().find(frame => new URL(frame.url() === 'about:blank' ? 'http://invalid/' : frame.url()).pathname === pathname);
    await page.waitForFunction(() => !!document.querySelector('.native-workbench-frame'));
    const deadline = Date.now() + 15000; while (!native() && Date.now() < deadline) await page.waitForTimeout(50);
    assert.ok(native(), 'Exact original C frame must mount');
    const frame = native();
    await frame.locator('[data-testid="composer-editor"]').first().waitFor();
    const send = frame.locator('button[type=submit][data-aaa-native-command="thread.turn.start"]:visible').first();
    await send.waitFor(); assert.equal(await send.isDisabled(), true);
    await frame.getByText('当前对话编辑能力不可用；草稿保留，未发送', { exact: false }).first().waitFor();
    await frame.getByText('已连接', { exact: true }).first().waitFor();
    for (const tag of ['subscribeServerConfig', 'subscribeServerLifecycle', 'orchestration.subscribeShell', 'orchestration.subscribeThread'])
      assert.ok(record.rpcTags.includes(tag), 'The original subscription must reach the service: ' + tag);
    const response = await context.request.get(destination.origin + '/api/orchestration/threads/' + metadata.threads.C);
    assert.equal(response.status(), 200); const raw = await response.json(), thread = raw.thread ?? raw;
    assert.equal(thread.id, metadata.threads.C); assert.equal(thread.messages.length, 0); assert.equal(thread.latestTurn, null); assert.equal(thread.session, null);
    record.original = { messages: thread.messages.length, latestTurn: thread.latestTurn, session: thread.session };
    record.devices = await page.evaluate(() => window.__nativeSyncDeviceCalls) + await frame.evaluate(() => window.__nativeSyncDeviceCalls);
    assert.equal(record.devices, 0); assert.deepEqual(record.blockedWrites, []); assert.deepEqual(record.errors, []);
    await page.screenshot({ path: join(output, 'original-C.png') });
    record.checks.push('fresh context connected through the original HTTP/WS', 'original C has no SID/messages/turns and its send gate remains blocked', 'zero execution/device calls');
    record.status = 'passed';
  });
} finally {
  record.frames = await Promise.all(page.frames().map(async frame => ({ path: new URL(frame.url() === 'about:blank' ? 'http://invalid/' : frame.url()).pathname,
    visibleText: safe(await frame.locator('body').innerText().catch(() => '')) })));
  if (record.status !== 'passed') await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  await Promise.allSettled(pending);
  await writeFile(join(output, 'observations.json'), JSON.stringify(record, null, 2) + '\n');
  await context.close(); await browser.close();
}
}

async function checkCandidateRuntime() {
  for (const name of ['NATIVE_SYNC_RUNTIME', 'NATIVE_SYNC_NODE', 'NATIVE_SYNC_DEPENDENCY_SOURCE', 'NATIVE_SYNC_READONLY_THREAD'])
    assert.ok(process.env[name], name + ' must identify an explicit existing input');
  assert.ok(renderer, 'Exact compiled candidate renderer required');
  const { default: Database } = await import('better-sqlite3');
  const { startBrowserFixture } = await import('../../../workbench/native-mount/browser-fixture.mjs');
  const actualHome = join(root, 'data/desktop-pet/t3-home'), sourceHome = join(output, 'source/t3-home');
  const environment = await readFile(join(actualHome, 'userdata/environment-id'), 'utf8');
  const actual = new Database(join(actualHome, 'userdata/state.sqlite'), { readonly: true, fileMustExist: true });
  const threadId = process.env.NATIVE_SYNC_READONLY_THREAD;
  const readOriginal = () => ({
    thread: actual.prepare('SELECT * FROM projection_threads WHERE thread_id=?').get(threadId),
    messages: actual.prepare('SELECT * FROM projection_thread_messages WHERE thread_id=? ORDER BY message_id').all(threadId),
    turns: actual.prepare('SELECT * FROM projection_turns WHERE thread_id=? ORDER BY row_id').all(threadId),
    binding: actual.prepare('SELECT * FROM provider_session_runtime WHERE thread_id=?').get(threadId),
  });
  const before = readOriginal(); assert.ok(before.thread); assert.equal(before.binding.provider_name, 'dsh');
  assert.ok(before.messages.length > 0); const nativeSessionId = JSON.parse(before.binding.resume_cursor_json).sessionId;
  assert.ok(nativeSessionId); const answer = before.messages.findLast(row => row.role === 'assistant' && row.text.trim().length > 0);
  assert.ok(answer, 'Original existing assistant message required; no fixture conversation is seeded');
  await mkdir(join(sourceHome, 'userdata'), { recursive: true, mode: 0o700 });
  await actual.backup(join(sourceHome, 'userdata/state.sqlite'));
  await writeFile(join(sourceHome, 'userdata/environment-id'), environment, { mode: 0o600 });
  const sqliteSha256 = sha(await readFile(join(sourceHome, 'userdata/state.sqlite')));
  await mkdir(join(output, 'fixture'), { recursive: true, mode: 0o700 });
  const marker = join(output, 'unexpected-cli-invocation'), deny = join(output, 'fixture/deny-codex');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(deny, '#!/bin/sh\nprintf invoked >> ' + quote(marker) + '\nexit 82\n', { mode: 0o700 });
  const record = { version: 1, at: new Date().toISOString(), level: 'complete compiled candidate over an isolated backup of the actual original DSH conversation; all providers disabled; no seeded messages/model/device/final acceptance',
    inputs: { runtime: resolve(process.env.NATIVE_SYNC_RUNTIME), renderer, originalSqliteSha256: sqliteSha256,
      testSha256: sha(await readFile(new URL(import.meta.url))) },
    original: { environmentId: environment.trim(), threadId, nativeSessionId, messages: before.messages.length,
      protectedThreadSha256: sha(JSON.stringify(before)), assistantTextSha256: sha(answer.text) }, requests: [], rpcTags: [], blockedWrites: [], errors: [], checks: [] };
  let fixture, browser, page;
  try {
    await test('complete compiled runtime displays the actual original DSH history and keeps its native binding unchanged', async () => {
      fixture = await startBrowserFixture({ runtimeSourceDir: resolve(process.env.NATIVE_SYNC_RUNTIME),
        dependencySourceDir: resolve(process.env.NATIVE_SYNC_DEPENDENCY_SOURCE), nodeExecutable: resolve(process.env.NATIVE_SYNC_NODE),
        directory: join(output, 'fixture'), rendererDist: renderer, fakeCodexExecutable: deny, providers: [],
        readOnlySnapshot: { sourceHome, sqliteSha256 } });
      assert.equal(fixture.environmentId, environment.trim());
      const configuration = JSON.parse(await readFile(join(output, 'fixture/fixture-configuration.json'), 'utf8'));
      assert.deepEqual(configuration.enabledProviders, []); assert.equal(configuration.readOnlySnapshot.originalUnchanged, true);
      const issued = await fixture.issueSession(); assert.equal(issued.session.mode, 'native-read');
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      await context.grantPermissions(['local-network-access'], { origin: fixture.origin });
      const split = issued.cookie.indexOf('=');
      await context.addCookies([{ name: issued.cookie.slice(0, split), value: issued.cookie.slice(split + 1), url: fixture.origin, httpOnly: true, sameSite: 'Strict' }]);
      const authPosts = new Set(['/api/auth/websocket-ticket']);
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url()); record.requests.push({ method: request.method(), path: url.pathname });
        if (url.origin !== fixture.origin || request.method() !== 'GET' && !authPosts.has(url.pathname)) {
          record.blockedWrites.push({ method: request.method(), path: url.pathname }); return route.abort();
        }
        return route.continue();
      });
      page = await context.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', error => record.errors.push(safe(error.message)));
      page.on('websocket', socket => socket.on('framesent', frame => {
        try { for (const request of [JSON.parse(String(frame.payload))].flat()) if (request._tag === 'Request') {
          record.rpcTags.push(request.tag); if (request.tag === 'orchestration.dispatchCommand') record.blockedWrites.push({ tag: request.tag, type: request.payload?.type });
        } } catch { /* Non-request socket controls do not mutate history. */ }
      }));
      await page.goto(fixture.origin + '/native/' + fixture.environmentId + '/' + threadId);
      const originalVisibleAnswer = answer.text.replaceAll('`', '').trim().replace(/\s+/g, ' ');
      await page.waitForFunction(expected => document.body.innerText.replace(/\s+/g, ' ').includes(expected), originalVisibleAnswer, { timeout: 20000 });
      await page.getByText('已连接', { exact: true }).first().waitFor();
      await page.screenshot({ path: join(output, 'original-DSH-history.png') });
      const binding = fixture.database.prepare('SELECT resume_cursor_json,runtime_payload_json FROM provider_session_runtime WHERE thread_id=?').get(threadId);
      assert.equal(binding.resume_cursor_json, before.binding.resume_cursor_json);
      assert.equal(binding.runtime_payload_json, before.binding.runtime_payload_json);
      const messages = fixture.database.prepare('SELECT * FROM projection_thread_messages WHERE thread_id=? ORDER BY message_id').all(threadId);
      assert.deepEqual(messages, before.messages);
      assert.deepEqual(record.blockedWrites, []); assert.deepEqual(record.errors, []);
      record.checks.push('complete candidate server and renderer connected', 'actual original DSH reply displayed with the original SID and durable messages', 'disabled providers and native-read entry; no execution or model calls');
      record.status = 'passed';
    });
  } finally {
    if (page) record.visibleText = safe(await page.locator('body').innerText().catch(() => ''));
    if (page && record.status !== 'passed') await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    await browser?.close(); await fixture?.close();
    record.originalUnchanged = sha(JSON.stringify(readOriginal())) === record.original.protectedThreadSha256;
    actual.close();
    let invoked = false; try { await stat(marker); invoked = true; } catch { /* Expected: deny CLI was never invoked. */ }
    record.unexpectedCLI = invoked; await writeFile(join(output, 'observations.json'), JSON.stringify(record, null, 2) + '\n');
    assert.equal(record.originalUnchanged, true); assert.equal(invoked, false);
  }
}

async function checkSelectedImport() {
  for (const name of ['NATIVE_SYNC_RUNTIME', 'NATIVE_SYNC_NODE', 'NATIVE_SYNC_DEPENDENCY_SOURCE'])
    assert.ok(process.env[name], name + ' must identify an explicit existing input');
  assert.ok(renderer, 'Exact compiled picker required');
  const { startBrowserFixture } = await import('../../../workbench/native-mount/browser-fixture.mjs');
  const directory = join(output, 'fixture'), cli = join(directory, 'deny-model-cli');
  const marker = join(directory, 'denied-provider-probe');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(cli, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.160.0-fixture\\n"; exit 0; fi\nprintf "%s\\n" "$*" >> ' + quote(marker) + '\nexit 82\n', { mode: 0o700 });
  const record = { version: 1, at: new Date().toISOString(),
    level: 'controlled two-project older Codex history through original compiled server, picker and authenticated mount; isolated homes; no real model/device/final acceptance',
    inputs: { runtime: resolve(process.env.NATIVE_SYNC_RUNTIME), renderer, testSha256: sha(await readFile(new URL(import.meta.url))) },
    requests: [], errors: [], checks: [] };
  let fixture, browser, page;
  try {
    await test('compiled picker begins empty and imports only the explicitly selected older project through the authenticated native bridge', async () => {
      fixture = await startBrowserFixture({ runtimeSourceDir: resolve(process.env.NATIVE_SYNC_RUNTIME),
        dependencySourceDir: resolve(process.env.NATIVE_SYNC_DEPENDENCY_SOURCE), nodeExecutable: resolve(process.env.NATIVE_SYNC_NODE),
        directory, rendererDist: renderer, fakeCodexExecutable: cli, providers: [] });
      const selected = join(directory, 'selected-older-project'), excluded = join(directory, 'unselected-older-project');
      const sourceFiles = [];
      for (const [index, cwd] of [selected, excluded].entries()) {
        await mkdir(cwd, { mode: 0o700 });
        const file = join(fixture.codexHome, 'sessions/2025/01/01', 'rollout-old-' + index + '.jsonl');
        await mkdir(join(fixture.codexHome, 'sessions/2025/01/01'), { recursive: true, mode: 0o700 });
        const records = [
          { timestamp: '2025-01-01T00:00:00Z', type: 'session_meta', payload: { id: 'older-native-' + index, cwd } },
          { timestamp: '2025-01-01T00:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'Older controlled original prompt ' + index } },
          { timestamp: '2025-01-01T00:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: 'Older controlled original reply ' + index }] } },
        ];
        await writeFile(file, records.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
        await utimes(file, new Date('2025-01-01'), new Date('2025-01-01'));
        sourceFiles.push({ file, sha256: sha(await readFile(file)) });
      }
      const issued = await fixture.issueSession(); assert.equal(issued.session.mode, 'native-operate');
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      await context.grantPermissions(['local-network-access'], { origin: fixture.origin });
      await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
      const split = issued.cookie.indexOf('=');
      await context.addCookies([{ name: issued.cookie.slice(0, split), value: issued.cookie.slice(split + 1), url: fixture.origin, httpOnly: true, sameSite: 'Strict' }]);
      await context.addInitScript(() => {
        window.__nativeSyncDeviceCalls = 0;
        if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => {
          window.__nativeSyncDeviceCalls++; return Promise.reject(Error('Controlled check has no device access'));
        };
      });
      page = await context.newPage(); page.setDefaultTimeout(20000);
      page.on('pageerror', error => record.errors.push(safe(error.message)));
      page.on('websocket', socket => socket.on('framesent', frame => {
        try { for (const request of [JSON.parse(String(frame.payload))].flat()) if (request._tag === 'Request')
          record.requests.push({ tag: request.tag, ...(request.tag === 'orchestration.dispatchCommand' || request.tag === 'agentSessions.import'
            ? { payload: request.payload } : {}) });
        } catch { /* Socket controls carry no selected operation. */ }
      }));
      await page.goto(fixture.origin + '/native/welcome');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByText('0 of 2 selected', { exact: true }).waitFor();
      assert.equal(record.requests.filter(row => row.tag === 'agentSessions.import' || row.tag === 'orchestration.dispatchCommand').length, 0);
      assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0);
      await page.getByRole('button', { name: /Other folders/ }).click();
      await page.locator('label').filter({ hasText: selected }).getByRole('checkbox').click();
      await page.getByText('1 of 2 selected', { exact: true }).waitFor();
      await page.screenshot({ path: join(output, 'selected-picker.png') });
      await page.getByRole('button', { name: 'Import 1 project', exact: true }).click();
      await page.getByText('Settled (1)', { exact: true }).click();
      await page.getByText('Older controlled original prompt 0', { exact: true }).first().click();
      await page.getByText('Older controlled original reply 0', { exact: true }).first().waitFor();
      const projects = fixture.database.prepare('SELECT project_id,workspace_root FROM projection_projects WHERE deleted_at IS NULL').all();
      assert.equal(projects.filter(row => row.workspace_root === selected).length, 1);
      assert.equal(projects.filter(row => row.workspace_root === excluded).length, 0);
      const imports = record.requests.filter(row => row.tag === 'agentSessions.import');
      assert.equal(imports.length, 1); assert.equal(imports[0].payload.expectedWorkspaceRoot, selected);
      assert.ok(fixture.database.prepare("SELECT 1 FROM projection_thread_messages WHERE role='user' AND text=?").get('Older controlled original prompt 0'));
      assert.equal(fixture.database.prepare("SELECT 1 FROM projection_thread_messages WHERE text=?").get('Older controlled original prompt 1'), undefined);
      for (const source of sourceFiles) assert.equal(sha(await readFile(source.file)), source.sha256);
      assert.equal(record.requests.some(row => row.payload?.type === 'thread.turn.start'), false);
      assert.equal(await page.evaluate(() => window.__nativeSyncDeviceCalls), 0);
      assert.deepEqual(record.errors, []);
      record.checks.push('two older original-format projects discovered; initial selection empty; no automatic imports',
        'one explicit selection created the exact project and imported its original history through the real RPC bridge',
        'unselected project excluded; source files unchanged; no model turns/devices');
      await page.getByRole('button', { name: 'AAAAGENT 菜单', exact: true }).click();
      await page.getByRole('menuitem', { name: '选择历史项目', exact: true }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByText('0 of 2 selected', { exact: true }).waitFor();
      assert.equal(record.requests.filter(row => row.tag === 'agentSessions.import').length, 1);
      record.checks.push('existing workspace menu reopens authenticated selection; existing projects remain available; no automatic reimport');
      record.status = 'passed';
    });
  } finally {
    if (page) record.visibleText = safe(await page.locator('body').innerText().catch(() => ''));
    if (page && record.status !== 'passed') await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    await browser?.close(); await fixture?.close();
    try { record.deniedTestProviderProbes = (await readFile(marker, 'utf8')).trim().split('\n'); }
    catch { record.deniedTestProviderProbes = []; }
    record.realModelTurns = 0; await writeFile(join(output, 'observations.json'), JSON.stringify(record, null, 2) + '\n');
  }
}

if (process.env.NATIVE_SYNC_SELECTION === '1') await checkSelectedImport();
else if (process.env.NATIVE_SYNC_RUNTIME) await checkCandidateRuntime(); else await checkOriginalRenderer();
