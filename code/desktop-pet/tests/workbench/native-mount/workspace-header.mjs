import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const runtime = resolve(root, 'artifacts/runtime/workspace-ui-integration-54');
const out = resolve(root, process.env.WORKSPACE_UI_HEADER_EVIDENCE ?? 'artifacts/W0-I/workspace-ui-integration-54/header');
await mkdir(out, { recursive: true });
const session = JSON.parse(await readFile(resolve(runtime, 'candidate-session.json'), 'utf8'));
const version = JSON.parse(await readFile(process.env.WORKSPACE_UI_VERSION ?? resolve(out, '../asset-promotion-747.json'), 'utf8'));
assert.equal(session.origin, 'http://127.0.0.1:59914');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(12000);
const errors = [], unexpected = [], http = [], observations = [];
let stage = 'entry', failure;
page.on('pageerror', error => errors.push(error.name));
page.on('request', request => { if (request.method() !== 'GET') http.push({ method: request.method(), path: new URL(request.url()).pathname }); });
await page.route('**/*', route => {
  if (new URL(route.request().url()).origin === session.origin) return route.continue();
  unexpected.push(new URL(route.request().url()).origin); return route.abort();
});
try {
  try { await page.goto(session.url, { waitUntil: 'domcontentloaded' }); }
  catch { throw Error('Private candidate entry omitted'); }
  await page.getByRole('button', { name: '进入工程工作台', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.native-workbench-state')?.hidden === true);
  const frame = page.frames().find(f => f !== page.mainFrame());
  await frame.locator('.aaa-flow-node').first().waitFor();
  stage = 'canvas-outside';
  const menu = frame.getByRole('button', { name: 'AAAAGENT 菜单', exact: true });
  await menu.click(); assert.equal(await menu.getAttribute('aria-expanded'), 'true');
  await page.mouse.click(936, 586);
  assert.equal(await menu.getAttribute('aria-expanded'), 'false');
  observations.push({ name: 'actual gesture canvas pointer closes menu' });
  const descriptor = await (await context.request.get(session.origin + '/.well-known/t3/environment')).json();
  await frame.getByLabel('选择项目').selectOption(JSON.stringify([descriptor.environmentId, '5659cde4-4f61-4748-807f-cef35b1aecf5']));
  const thread = '55321ff5-339c-4654-b094-8eed93833125';
  await frame.locator(`[data-thread-id="${thread}"]`).getByRole('button', { name: `展开对话 ${thread}`, exact: true }).click();
  const editor = frame.locator('[contenteditable=true]').first(); await editor.waitFor();
  stage = 'original-shared-controls';
  assert.equal(await frame.locator('[data-chat-header]').count(), 0);
  assert.equal(await frame.locator('.aaa-workspace-bar').count(), 1);
  assert.equal(await frame.locator('#aaa-native-header-actions [data-chat-header-actions]').count() > 0, true);
  assert.equal(await frame.locator('#aaa-native-panel-controls [data-workspace-titlebar-controls]').count(), 1);
  const action = frame.getByRole('button', { name: 'More header actions', exact: true });
  await action.click(); await frame.getByRole('menu').waitFor(); await action.press('Escape');
  await editor.fill('I-header-local-draft');
  const documentMark = await frame.evaluate(() => window.__integrationDocument = Math.random());
  const originalRoute = new URL(frame.url()).pathname;
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
    await frame.waitForFunction(w => innerWidth === w, width);
    const bounds = await frame.locator('.aaa-workspace-bar').boundingBox();
    const controls = await frame.locator('.aaa-workspace-bar button:visible').evaluateAll(buttons => buttons.map(b => {
      const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label') ?? b.textContent?.trim(), x: r.x, y: r.y, width: r.width, height: r.height };
    }));
    for (const box of controls) assert.ok(box.x >= -1 && box.x + box.width <= width + 1 && box.y >= -1 && box.y + box.height <= (width === 390 ? 845 : 721));
    await menu.click(); await menu.press('Escape'); assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    observations.push({ name: 'single shared original controls in viewport', width, toolbar: bounds, controls });
  }
  stage = 'same-original-state';
  const viewportBefore = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await menu.click(); await frame.getByRole('menuitem', { name: '运行总览', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.native-workbench-portal').hidden);
  const viewportHidden = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.deepEqual(viewportHidden, viewportBefore);
  await page.getByRole('button', { name: '进入工程工作台', exact: true }).click();
  await editor.waitFor();
  assert.equal(await frame.evaluate(() => window.__integrationDocument), documentMark);
  assert.equal(new URL(frame.url()).pathname, originalRoute);
  assert.equal(await editor.innerText(), 'I-header-local-draft');
  await editor.fill('');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  assert.deepEqual(http, [{ method: 'POST', path: '/api/native-mount/session' }]);
  observations.push({ name: 'original route/document/draft/viewport retained across management return', viewportBefore, viewportHidden, ownTemporaryDraftRemoved: true });
} catch (error) { failure = { stage, name: error.name, code: error.code ?? null,
  detail: error.message.replace(/https?:\/\/\S+/g, '[url omitted]').slice(0, 1800) }; process.exitCode = 1; }
finally {
  await writeFile(resolve(out, 'observations.json'), JSON.stringify({ parent: version.parent_module, native: version.native_module,
    integration: version.native_integration_source ?? version.integration_native_source,
    parentIntegration: version.I_parent_source, browser: 'Chromium', observations, errors, unexpected, http, failure,
    scope: 'Only affected original shared controls, canvas outside click and390; prior4418 boundary evidence remains separately versioned',
  }, null, 2) + '\n');
  await context.close(); await browser.close();
  console.log(JSON.stringify({ ok: !failure, stage, observations: observations.length, evidence: resolve(out, 'observations.json') }));
}
