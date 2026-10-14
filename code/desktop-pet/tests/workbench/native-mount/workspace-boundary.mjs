import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { READ_RPC_METHODS } from '../../../workbench/native-mount/policy.mjs';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const runtime = resolve(root, 'artifacts/runtime/workspace-ui-integration-54');
const evidence = resolve(root, 'artifacts/W0-I/workspace-ui-integration-54/boundary');
await mkdir(evidence, { recursive: true });
const session = JSON.parse(await readFile(resolve(runtime, 'candidate-session.json'), 'utf8'));
assert.equal(session.origin, 'http://127.0.0.1:59914');
const promotion = JSON.parse(await readFile(resolve(evidence, '../asset-promotion-744.json'), 'utf8'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(12000);
const attempts = [], exits = [], errors = [], unexpected = [], http = [], loadedAssets = [];
const sockets = new Map();
let stage = 'entry', failure, observations = {};
const hash = value => createHash('sha256').update(value).digest('hex');
page.on('pageerror', error => errors.push({ name: error.name }));
page.on('request', request => {
  const url = new URL(request.url());
  if (url.pathname.startsWith('/api/')) http.push({ method: request.method(), path: url.pathname });
});
page.on('response', response => {
  const path = new URL(response.url()).pathname;
  if (path.startsWith('/native/assets/')) loadedAssets.push(path.slice('/native/'.length));
});
page.on('websocket', ws => {
  const url = new URL(ws.url());
  assert.equal(url.host, '127.0.0.1:59914');
  const id = sockets.size;
  const sent = new Map(); sockets.set(id, sent);
  ws.on('framesent', ({ payload }) => {
    try {
      for (const item of [JSON.parse(String(payload))].flat()) {
        if (item?._tag !== 'Request') continue;
        sent.set(String(item.id), item.tag);
        attempts.push({ socket: id, requestId: String(item.id), tag: item.tag });
      }
    } catch { /* No raw envelopes or payloads enter evidence. */ }
  });
  ws.on('framereceived', ({ payload }) => {
    try {
      for (const item of [JSON.parse(String(payload))].flat()) {
        if (item?._tag !== 'Exit') continue;
        const tag = sent.get(String(item.requestId));
        if (!tag) continue;
        const cause = item.exit?.cause;
        const authorizationRejected = Array.isArray(cause) && cause.some(c =>
          c?._tag === 'Fail' && c.error?._tag === 'EnvironmentAuthorizationError' &&
          c.error?.requiredScope === 'orchestration:operate');
        exits.push({ socket: id, requestId: String(item.requestId), tag,
          outcome: item.exit?._tag, authorizationRejected });
      }
    } catch { /* Only classified outcomes are retained. */ }
  });
});
await page.route('**/*', route => {
  if (new URL(route.request().url()).origin === session.origin) return route.continue();
  unexpected.push({ origin: new URL(route.request().url()).origin });
  return route.abort();
});
await context.addInitScript(() => {
  window.__integrationDeviceAttempts = 0;
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => {
    window.__integrationDeviceAttempts++; throw Error('Device operation outside this review');
  };
});
try {
  try { await page.goto(session.url, { waitUntil: 'domcontentloaded' }); }
  catch { throw Error('Candidate entry unavailable; private URL omitted'); }
  await page.getByRole('button', { name: '进入工程工作台', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.native-workbench-state')?.hidden === true);
  const frame = page.frames().find(f => f !== page.mainFrame());
  await frame.locator('.aaa-flow-node').first().waitFor();
  stage = 'original-data';
  const shell = await (await context.request.get(session.origin + '/api/orchestration/shell')).json();
  const descriptor = await (await context.request.get(session.origin + '/.well-known/t3/environment')).json();
  const environmentId = descriptor.environmentId;
  const histories = [];
  for (const sample of [
    { project: '5659cde4-4f61-4748-807f-cef35b1aecf5', thread: '55321ff5-339c-4654-b094-8eed93833125', provider: 'codex' },
    { project: '84775d4b-a2b1-46ba-8e46-5fb62775df4b', thread: '847088d1-ddb9-4fee-b38b-04588cf8a1ad', provider: 'dsh' },
  ]) {
    const identity = shell.threads.find(t => t.id === sample.thread);
    assert.equal(identity.projectId, sample.project);
    assert.equal(identity.modelSelection.instanceId, sample.provider);
    await frame.getByLabel('选择项目').selectOption(JSON.stringify([environmentId, sample.project]));
    await frame.locator(`[data-thread-id="${sample.thread}"]`).getByRole('button', { name: `展开对话 ${sample.thread}`, exact: true }).click();
    await frame.locator('[contenteditable=true]').first().waitFor();
    const raw = await (await context.request.get(session.origin + '/api/orchestration/threads/' + sample.thread)).json();
    const thread = raw.thread ?? raw;
    assert.equal(thread.id, sample.thread);
    const message = thread.messages.find(m => m.role === 'user' && m.text?.trim());
    assert.ok(message);
    await frame.getByText(message.text.trim(), { exact: false }).first().waitFor();
    histories.push({ thread: sample.thread, project: sample.project, provider: sample.provider,
      messagesSha256: hash(JSON.stringify(thread.messages)), originalRoute: new URL(frame.url()).pathname });
    // Existing original client subscriptions settle; no commands are injected or replayed.
    await page.waitForTimeout(1000);
    await frame.locator('.aaa-home-link').click();
    await frame.locator('.aaa-flow-node').first().waitFor();
  }
  stage = 'outcomes';
  const tags = [...new Set(attempts.map(x => x.tag))].sort();
  const rejected = attempts.filter(x => !READ_RPC_METHODS.has(x.tag));
  const unresolved = rejected.filter(a => !exits.some(x => x.socket === a.socket && x.requestId === a.requestId && x.authorizationRejected));
  assert.deepEqual(unresolved, []);
  const audit = JSON.parse(await readFile(resolve(runtime, 'runtime-audit.json'), 'utf8'));
  assert.ok(Object.keys(audit.rpcAllowed).every(tag => READ_RPC_METHODS.has(tag)));
  for (const tag of ['assets.createUrl', 'server.refreshProviders', 'server.reportClientActivity', 'subscribeDeviceState']) {
    assert.ok(attempts.some(x => x.tag === tag), 'Expected original-client attempt: ' + tag);
    assert.ok(exits.some(x => x.tag === tag && x.authorizationRejected), 'Expected actual rejection: ' + tag);
    assert.equal(audit.rpcAllowed[tag] ?? 0, 0);
  }
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  assert.equal(await page.evaluate(() => window.__integrationDeviceAttempts), 0);
  assert.equal(await frame.evaluate(() => window.__integrationDeviceAttempts), 0);
  assert.deepEqual(http.filter(x => x.method !== 'GET'), [{ method: 'POST', path: '/api/native-mount/session' }]);
  const currentFiles = new Map(promotion.files.map(f => [f.path, f.sha256]));
  const uniqueAssets = [...new Set(loadedAssets)].sort();
  assert.ok(uniqueAssets.length > 0);
  for (const path of uniqueAssets) assert.equal(hash(await readFile(resolve(root, 'artifacts/runtime/t3-native-ui-54/apps/web/dist', path))), currentFiles.get(path));
  observations = { environmentId, projects: shell.projects.length, threads: shell.threads.length,
    histories, tags, allDisallowedAttemptsGotAuthorizationFailure: true,
    sensitiveClientAttemptsRejectedAndNotForwarded: true, loadedCurrentAssetCount: uniqueAssets.length,
    loadedCurrentAssets: uniqueAssets, deviceAttempts: 0, pageErrors: 0,
    nativeSessionPosts: 1, aggregateGatewayAudit: audit };
} catch (error) {
  failure = { stage, name: error.name, code: error.code ?? null };
  process.exitCode = 1;
} finally {
  await writeFile(resolve(evidence, 'observations.json'), JSON.stringify({
    kind: 'actual Chromium original-client readonly boundary review', parent: promotion.parent_module,
    native: promotion.native_module, integration: promotion.native_integration_source,
    server: promotion.server_source, observations, failure, attempts, exits, http, errors, unexpected,
    limits: ['No injected business request, replay, model/device call or installation',
      'Original WS connection metadata is checked separately against protected database snapshots',
      'Aggregate gateway counters include concurrent authorized reviewers'],
  }, null, 2) + '\n');
  await context.close(); await browser.close();
  console.log(JSON.stringify({ ok: !failure, stage, attemptCount: attempts.length, exitCount: exits.length,
    observedTags: [...new Set(attempts.map(x => x.tag))].sort(), evidence: resolve(evidence, 'observations.json') }));
}
