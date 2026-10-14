// Real production DOM with a private shell fixture. No Host, asset, media or model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const output = resolve(process.env.PET_WINDOW_TEST_OUTPUT);
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(output, 'browser-build-'));
const { webkit } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const observations = [], errors = [];
let server, browser;
try {
  await build({ entryPoints: ['desktop/main.mjs'], bundle: true, format: 'esm', outfile: join(temp, 'main.js'),
    plugins: [{ name: 'silent-adapters', setup(plugin) {
      plugin.onResolve({ filter: /cubism-renderer\.mjs|browser-playback\.ts|browser-capture\.ts/ }, args => ({ path: args.path, namespace: 'silent' }));
      plugin.onLoad({ filter: /.*/, namespace: 'silent' }, args => ({ contents: args.path.includes('cubism') ?
        'export class JellyfishRenderer {ready=true;async load(){}setAutomaticPolicy(){}setFraming(){}reset(){}beginAttention(){}updateView(){}snapshot(){return {}}dispose(){}}' :
        args.path.includes('playback') ? 'export class BrowserPlaybackDriver {async open(){window.forbiddenCalls++;throw Error("playback forbidden")}}' :
        'export class BrowserCaptureDriver {async open(){window.forbiddenCalls++;throw Error("capture forbidden")}}' }));
    } }] });
  const html = (await readFile('desktop/index.html', 'utf8')).replace(/<script[\s\S]*?<\/script>/g, '')
    .replace('</body>', '<script type="module" src="main.js"></script></body>');
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://local').pathname;
      const data = path === '/' ? html : path === '/main.js' ? await readFile(join(temp, 'main.js')) : path === '/style.css' ? await readFile('desktop/style.css') : null;
      if (data === null) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', path === '/' ? 'text/html; charset=utf-8' : path === '/style.css' ? 'text/css' : 'text/javascript'); res.end(data);
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, locale: 'zh-CN' });
  page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.wires = []; window.forbiddenCalls = 0;
    window.fixture = { mode: 'half', preferredWidth: 360, modelWidth: 360, modelHeight: 340, drawerHeight: 540,
      petLeft: 450, petTop: 10, petWidth: 380, drawerLeft: 860, drawerTop: 10, drawerWidth: 480,
      collapsed: false, ballLeft: 618, ballTop: 10, ballSize: 44, open: false };
    window.paint = () => petBridge.displayConfig(fixture);
    window.webkit = { messageHandlers: Object.fromEntries(['desktop', 'shell', 'diagnostic'].map(name => [name, { postMessage(value) {
      wires.push({ name, value });
      if (name !== 'shell' || !window.petBridge) return;
      if (value.type === 'panel') fixture.open = value.open;
      else if (value.type === 'set_collapsed') { fixture.collapsed = value.collapsed; fixture.open = value.open; }
      else if (value.type === 'drag') {
        if (fixture.collapsed) { fixture.ballLeft += value.dx; fixture.ballTop += value.dy; }
        else { fixture.petLeft += value.dx; fixture.petTop += value.dy; fixture.drawerLeft += value.dx; fixture.drawerTop += value.dy; }
      } else return;
      queueMicrotask(paint);
    } }])) };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => { forbiddenCalls++; throw Error('device forbidden'); };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.petBridge);
  const bridgeVersion = (await readFile('contracts/desktop-bridge.ts', 'utf8')).match(/DESKTOP_BRIDGE_VERSION\s*=\s*'([^']+)'/)[1];
  await page.evaluate(version => {
    petBridge.connectionChanged({ generation: 1, state: 'connecting' });
    petBridge.receive({ channel: 'backend_ready', bridgeVersion: version, characterId: 'companion', sessionId: 'fixture-session' }, 1);
    paint();
  }, bridgeVersion);
  await page.locator('#open').click();
  await page.waitForFunction(() => !document.querySelector('#drawer').getAnimations().length);
  const task = { id: 'fixture-task', projectId: 'fixture-project', provider: 'codex', origin: 't3', environmentId: 'fixture-env',
    t3ProjectId: 'fixture-native', threadId: 'fixture-thread', providerInstanceId: 'codex' };
  const draft = { id: 'fixture-draft', commandId: 'fixture-command', version: 1, state: 'open', task,
    input: { inputId: 'fixture-message', origin: { channel: 'desktop', channelSessionId: 'desktop-primary', messageId: 'fixture-message' },
      rawText: '保留工程原话。'.repeat(300), dispatchText: '保留尚未转交的工程草稿。'.repeat(200), createdAt: '' } };
  const state = { version: '0.1.0', sequence: 1, readAvailable: true, dispatchEnabled: false,
    focus: { version: '0.1.0', revision: 1, projectId: task.projectId, task }, projects: [{ id: task.projectId, name: '受控项目' }],
    projectsTruncated: false, tasks: [{ task, projection: { taskId: task.id, sequence: 1, eventId: 'fixture-event', phase: 'running' } }],
    drafts: [draft], draftsTruncated: false, selectedDraftId: draft.id };
  await page.evaluate(state => petBridge.receive({ channel: 'workbench_state', state }, 1), state);
  await page.locator('#text').fill('尚未发送的聊天草稿');
  await page.locator('#workbench-open').click();
  assert.equal(await page.locator('#workbench-dialog').evaluate(node => node.matches(':modal')), false);
  await page.locator('#workbench-project-query').fill('未提交搜索');
  await page.locator('#workbench-content').evaluate(node => { node.scrollTop = 96; });
  const before = await page.locator('#workbench-dialog').boundingBox(), character = await page.locator('#character').boundingBox();
  await page.mouse.move(character.x + 100, character.y + 180); await page.mouse.down();
  await page.mouse.move(character.x + 130, character.y + 200, { steps: 3 }); await page.mouse.up();
  const after = await page.locator('#workbench-dialog').boundingBox();
  const drags = await page.evaluate(() => wires.filter(x => x.name === 'shell' && x.value.type === 'drag'));
  observations.push({ check: 'overview drag coordinates', before, after, drags });
  // Headless macOS WebKit's screenY has the opposite sign from its clientY.
  // This fixture checks the actual private deltas; device drag direction is S's GUI check.
  const dx = drags.reduce((sum, row) => sum + row.value.dx, 0), dy = drags.reduce((sum, row) => sum + row.value.dy, 0);
  assert.ok(dx !== 0 && dy !== 0 && Math.abs(after.x - before.x - dx) < 1 && Math.abs(after.y - before.y - dy) < 1,
    JSON.stringify({ before, after, drags }));
  assert.equal(await page.locator('#workbench-dialog').evaluate(node => node.open), true);
  observations.push({ check: 'overview character drag and attached position', pass: true, before, after });
  for (let n = 0; n < 6; n++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.querySelector('#workbench-dialog').contains(document.activeElement)), true); }
  await page.locator('#workbench-content').evaluate(node => { node.scrollTop = 96; });
  const scroll = await page.locator('#workbench-content').evaluate(node => node.scrollTop);
  await page.locator('#workbench-collapse').click();
  await page.waitForFunction(() => document.body.dataset.petCollapsed === 'true');
  const hidden = await page.evaluate(() => ({ width: document.querySelector('#model').clientWidth, height: document.querySelector('#model').clientHeight,
    visible: getComputedStyle(document.querySelector('#pet')).visibility, active: document.activeElement.id,
    modalCount: document.querySelectorAll(':modal').length }));
  assert.deepEqual(hidden, { width: 360, height: 340, visible: 'hidden', active: 'pet-ball', modalCount: 0 });
  assert.equal(await page.locator('#text').inputValue(), '尚未发送的聊天草稿');
  const ball = await page.locator('#pet-ball').boundingBox(); assert.equal(ball.width, 44); assert.equal(ball.height, 44);
  await page.screenshot({ path: join(output, 'controlled-ball.png') });
  await page.mouse.move(ball.x + 22, ball.y + 22); await page.mouse.down();
  await page.mouse.move(ball.x + 60, ball.y + 44, { steps: 4 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => document.body.dataset.petCollapsed), 'true');
  const moved = await page.locator('#pet-ball').boundingBox(); assert.ok(moved.x > ball.x + 30);
  await page.locator('#pet-ball').click(); await page.waitForFunction(() => document.body.dataset.petCollapsed === 'false');
  assert.equal(await page.locator('#workbench-dialog').evaluate(node => node.open), true);
  assert.equal(await page.locator('#workbench-project-query').inputValue(), '未提交搜索');
  assert.equal(await page.locator('#workbench-content').evaluate(node => node.scrollTop), scroll);
  assert.match(await page.locator('#workbench-content').innerText(), /保留尚未转交的工程草稿/);
  assert.equal(await page.locator('#text').inputValue(), '尚未发送的聊天草稿');
  observations.push({ check: 'collapse, ball drag, click restore with draft/scroll/size', pass: true, hidden, ball, moved, scroll });
  await page.screenshot({ path: join(output, 'controlled-overview-restored.png') });
  // A real modal record must be closed before the ball can receive a click.
  await page.locator('#workbench-close').click();
  await page.evaluate(() => { document.querySelector('#work-records-content').textContent = '保留工程记录'; document.querySelector('#work-records-dialog').showModal(); });
  await page.locator('#work-records-collapse').click(); await page.waitForFunction(() => document.body.dataset.petCollapsed === 'true');
  assert.equal(await page.evaluate(() => document.querySelectorAll(':modal').length), 0);
  await page.locator('#pet-ball').click(); await page.waitForFunction(() => document.body.dataset.petCollapsed === 'false');
  assert.equal(await page.locator('#work-records-dialog').evaluate(node => node.matches(':modal')), true);
  assert.equal(await page.locator('#work-records-content').innerText(), '保留工程记录');
  await page.locator('#work-records-close').click(); await page.locator('#close').click();
  // Collapse during the existing close animation, before its delayed native panel close.
  await page.locator('#pet-collapse').click(); await page.waitForFunction(() => document.body.dataset.petCollapsed === 'true');
  await page.locator('#pet-ball').focus(); await page.keyboard.press('Space');
  await page.waitForFunction(() => document.body.dataset.petCollapsed === 'false');
  assert.equal(await page.locator('#drawer').evaluate(node => node.hidden), true);
  observations.push({ check: 'modal record restoration and accessible ball restoration to closed chat', pass: true });
  const calls = await page.evaluate(() => ({ forbidden: forbiddenCalls,
    commands: wires.filter(x => x.name === 'desktop'), shell: wires.filter(x => x.name === 'shell') }));
  assert.equal(calls.forbidden, 0); assert.equal(calls.commands.length, 0); assert.deepEqual(errors, []);
  await writeFile(join(output, 'browser-observations.json'), JSON.stringify({ status: 'passed', evidence: 'headless WebKit with fake private bridge, no native App/device/model acceptance', observations, errors, calls }, null, 2) + '\n');
  console.log(`${observations.length} real DOM interaction groups passed; no backend commands or device calls`);
} catch (error) {
  await writeFile(join(output, 'browser-failure.json'), JSON.stringify({ observations, errors, error: String(error), stack: error.stack }, null, 2) + '\n'); throw error;
} finally {
  await browser?.close(); if (server) await new Promise(done => server.close(done)); await rm(temp, { recursive: true, force: true });
}
