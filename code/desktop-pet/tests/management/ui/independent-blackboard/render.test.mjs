import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), taskRoot = resolve(here, '../../../../../..');
const option = name => { const at = process.argv.indexOf(name); assert.ok(at >= 0 && process.argv[at + 1]); return resolve(process.argv[at + 1]); };
const assembly = option('--assembly'), evidence = option('--evidence'), esbuildPath = option('--esbuild');
const playwright = option('--playwright'), styleRoot = option('--styles');
assert.ok(assembly.startsWith(join(taskRoot, 'artifacts/runtime/')));
assert.ok(evidence.startsWith(join(taskRoot, 'artifacts/W1/independent-blackboard-54/')));
await mkdir(evidence, { recursive: true });
const fixtures = JSON.parse(execFileSync('/usr/bin/python3', [join(here, 'fixtures.py')], { encoding: 'utf8' }));
const web = join(assembly, 'apps/web'), nativePath = join(web, 'src/aaaagent/NativeChildConversation.tsx');
const native = await readFile(nativePath, 'utf8'), start = native.indexOf('export function useNativeChildReader()'), end = native.indexOf('\nexport function NativeChildConversation', start);
assert.ok(start >= 0 && end > start);
const nativeControlled = native.slice(0, start) + 'export function useNativeChildReader(): NativeChildReader { return window.__nativeReader; }\n' + native.slice(end);
const boundary = `
import { useSyncExternalStore } from 'react';
import { BoardReadError } from ${JSON.stringify(join(web, 'src/aaaagent/blackboard-poll.ts'))};
const fixtures = ${JSON.stringify(fixtures)}, scope = fixtures.empty.scope;
let board = fixtures.empty, ready = true, mismatch = false, rejectNext = false;
const listeners = new Set(), connections = new Set();
const notify = () => listeners.forEach(action => action());
const subscribe = callback => { listeners.add(callback); return () => listeners.delete(callback); };
const projects = [{ environmentId: scope.environmentId, id: scope.projectId, title: '受控独立协作项目' },
 { environmentId: scope.environmentId, id: 'unregistered-project', title: '未登记项目' }];
let threads = fixtures.empty.participants.map((actor, index) => ({ environmentId: scope.environmentId, id: actor.threadId,
 projectId: scope.projectId, title: actor.title, archivedAt: null, createdAt: new Date(1700000000000 + index * 1000).toISOString(),
 updatedAt: fixtures.empty.updatedAt, modelSelection: { instanceId: 'codex', model: 'controlled' }, session: { status: 'idle' } }));
const configs = new Map([[scope.environmentId, { providers: [{ instanceId: 'codex', driver: 'codex', displayName: 'Codex' }] }]]);
export const useProjects = () => projects;
export const useServerConfigs = () => configs;
export const useThreadShells = () => useSyncExternalStore(subscribe, () => threads);
const reader = { snapshot: async target => {
 window.__reads.push({ ...target });
 if (target.projectId !== scope.projectId) throw new BoardReadError(404);
 if (rejectNext) { rejectNext = false; throw new BoardReadError(401); }
 return structuredClone(board);
}, watchConnection: (_, callback) => { connections.add(callback); callback(ready); return () => connections.delete(callback); } };
export const useBlackboardReader = () => reader;
window.__reads = [];
window.__setBoard = name => { board = fixtures[name]; };
window.__setReady = value => { ready = value; connections.forEach(callback => callback(value)); };
window.__rejectNext = () => { rejectNext = true; };
window.__setMismatch = value => { mismatch = value; threads = threads.map(thread => ({ ...thread,
 modelSelection: { ...thread.modelSelection, instanceId: mismatch ? 'wrong-provider' : 'codex' } })); notify(); };
window.__nativeReader = { relations: async target => ({ apiVersion: '0.1.0', scope: target, children: [] }),
 conversation: async () => { throw Error('No controlled native child'); } };
`;
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createRootRoute, createRoute, createRouter, RouterProvider, Outlet, useRouterState } from '@tanstack/react-router';
import { FlowOverview } from ${JSON.stringify(join(web, 'src/aaaagent/FlowOverview.tsx'))};
import { AgentsPanel } from ${JSON.stringify(join(web, 'src/components/AgentsPanel.tsx'))};
import 'controlled-board-boundary';
const scope = ${JSON.stringify(fixtures.empty.scope)};
const model = { hasAgents: false, workflows: [], directAgents: [], runningCount: 0, waitingCount: 0, idleCount: 0, settledCount: 0, totalTokens: 0 };
function Flow() {
 const search = useRouterState({ select: state => state.location.search });
 return <FlowOverview preferredEnvironment={search.aaaEnvironment ?? scope.environmentId} preferredProject={search.aaaProject ?? scope.projectId} />;
}
function OriginalRouteBoundary() {
 const location = useRouterState({ select: state => state.location });
 const id = decodeURIComponent(location.pathname.split('/').at(-1));
 return <main><button onClick={() => history.back()}>原路由返回</button><p data-original-route>{location.pathname}</p>
  <div style={{ width: '100%', height: '80vh', overflow: 'auto' }}><AgentsPanel model={model} environmentId={scope.environmentId} threadId={id}
   nativeTarget={{ ...scope, parentThreadId: id, providerInstanceId: 'codex' }} /></div></main>;
}
const root = createRootRoute({ component: () => <div className='aaa-workspace-shell' style={{ height: '100vh' }}><Outlet /></div> });
const index = createRoute({ getParentRoute: () => root, path: '/', component: Flow });
const thread = createRoute({ getParentRoute: () => root, path: '/$environmentId/$threadId', component: OriginalRouteBoundary });
createRoot(document.getElementById('root')).render(<RouterProvider router={createRouter({ routeTree: root.addChildren([index, thread]) })} />);
`;
const esbuild = createRequire(import.meta.url)(esbuildPath);
const built = await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: web }, bundle: true, write: false,
  platform: 'browser', format: 'esm', jsx: 'automatic', target: 'es2022', tsconfig: join(web, 'tsconfig.json'),
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ APP_VERSION: 'controlled', VITE_AAA_NATIVE_READ: '1', VITE_AAA_PREVIEW: '0', MODE: 'test', DEV: false, PROD: true }) },
  plugins: [{ name: 'controlled-project-and-reader-boundaries', setup(builder) {
    builder.onResolve({ filter: /^controlled-board-boundary$/ }, () => ({ path: 'boundary', namespace: 'board-boundary' }));
    builder.onResolve({ filter: /(?:^|\/)BlackboardReader(?:\.tsx)?$/ }, () => ({ path: 'boundary', namespace: 'board-boundary' }));
    builder.onResolve({ filter: /^\.\.\/state\/entities$/ }, input => /(?:FlowOverview|IndependentBlackboard)\.tsx$/.test(input.importer)
      ? { path: 'boundary', namespace: 'board-boundary' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'board-boundary' }, () => ({ contents: boundary, loader: 'ts', resolveDir: web }));
    builder.onLoad({ filter: /NativeChildConversation\.tsx$/ }, () => ({ contents: nativeControlled, loader: 'tsx', resolveDir: dirname(nativePath) }));
    builder.onResolve({ filter: /\?worker$/ }, input => ({ path: input.path, namespace: 'unused-worker' }));
    builder.onLoad({ filter: /.*/, namespace: 'unused-worker' }, () => ({ contents: 'export default class { constructor() { throw Error("unused controlled worker"); } }', loader: 'js' }));
  } }], loader: { '.svg': 'dataurl', '.woff2': 'dataurl' }, logLevel: 'silent' });
const script = built.outputFiles[0].text;
const styles = (await Promise.all((await readdir(styleRoot)).filter(name => name.endsWith('.css')).map(name => readFile(join(styleRoot, name), 'utf8')))).join('\n')
  + await readFile(join(web, 'src/aaaagent/flow.css'), 'utf8');
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>';
const { chromium } = await import(pathToFileURL(playwright).href), browser = await chromium.launch({ headless: true });
const cases = [], checkpoints = [], errors = [], blocked = []; let failure;
try {
  for (const [width, height] of [[319, 767], [1440, 900]]) for (const theme of ['light', 'dark']) {
    if (process.argv.includes('--first') && (width !== 319 || theme !== 'light')) continue;
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(theme => {
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.classList.toggle('dark', theme === 'dark'); });
      for (const name of ['WebSocket', 'EventSource']) window[name] = class { constructor() { throw Error('controlled blocks ' + name); } };
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(Error('controlled blocks device'));
      window.__controlledVisible = true;
      Object.defineProperty(document, 'visibilityState', { get: () => window.__controlledVisible ? 'visible' : 'hidden' });
      window.__visible = value => { window.__controlledVisible = value; document.dispatchEvent(new Event('visibilitychange')); };
    }, theme);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.host === 'independent-ui.invalid') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
        if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        if (url.pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: styles });
      }
      blocked.push(url.origin + url.pathname); return route.abort('blockedbyclient');
    });
    await page.goto('http://independent-ui.invalid/');
    await page.waitForSelector('[data-board-fresh="true"]');
    await page.getByRole('button', { name: '画布', exact: true }).click();
    assert.equal(await page.locator('[data-relation-key]').count(), 0);
    await page.evaluate(() => window.__setBoard('assigned'));
    await page.waitForFunction(() => document.querySelectorAll('[data-relation-key]').length === 2);
    assert.equal(await page.locator('[data-parent-key]').count(), 0);
    await page.getByRole('button', { name: '放大画布', exact: true }).click();
    const viewport = await page.locator('[data-viewport]').getAttribute('data-viewport');
    const search = page.getByRole('textbox', { name: '搜索当前项目对话' }); await search.fill(''); await search.focus();
    await page.evaluate(() => window.__setBoard('final'));
    await page.waitForFunction(() => document.querySelectorAll('[data-relation-key]').length === 4);
    assert.equal(await search.evaluate(element => document.activeElement === element), true);
    assert.deepEqual(JSON.parse(await page.locator('[data-viewport]').getAttribute('data-viewport')), JSON.parse(viewport));
    await page.locator('.aaa-blackboard-details > summary').click();
    await page.locator('.aaa-blackboard-records').getByText('受控协调汇总，引用两份回报', { exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, `${width}-${theme}-flow.png`) });
    const participants = fixtures.final.participants;
    await page.getByRole('button', { name: `展开对话 ${participants[1].threadId}`, exact: true }).click();
    await page.waitForSelector('[data-original-route]');
    assert.ok(page.url().endsWith(`/${fixtures.final.scope.environmentId}/${participants[1].threadId}`));
    await page.waitForSelector('[data-board-fresh="true"]');
    await page.locator('.aaa-blackboard-details > summary').click();
    await page.getByRole('button', { name: `打开独立对话 ${participants[2].threadId}`, exact: true }).click();
    await page.waitForFunction(id => document.querySelector('[data-original-route]')?.textContent.endsWith(id), participants[2].threadId);
    await page.getByRole('button', { name: '原路由返回', exact: true }).click();
    await page.waitForFunction(id => document.querySelector('[data-original-route]')?.textContent.endsWith(id), participants[1].threadId);
    await page.getByRole('button', { name: '原路由返回', exact: true }).click();
    await page.waitForSelector('.aaa-flow-content');
    checkpoints.push({ width, theme, step: 'original route back to Flow', url: page.url(), priorViewport: viewport,
      current: await page.evaluate(() => ({ viewport: document.querySelector('[data-viewport]')?.getAttribute('data-viewport') ?? null,
        canvasPressed: [...document.querySelectorAll('button')].find(button => button.textContent === '画布')?.getAttribute('aria-pressed'),
        listPressed: [...document.querySelectorAll('button')].find(button => button.textContent === '列表')?.getAttribute('aria-pressed') })) });
    await page.screenshot({ path: join(evidence, `${width}-${theme}-return.png`) });
    await page.waitForSelector('[data-viewport]', { timeout: 2500 });
    assert.deepEqual(JSON.parse(await page.locator('[data-viewport]').getAttribute('data-viewport')), JSON.parse(viewport));
    await page.waitForFunction(() => document.querySelectorAll('[data-relation-key]').length === 4);
    await page.evaluate(() => window.__setMismatch(true));
    await page.waitForSelector('[data-board-fresh="false"]'); assert.equal(await page.locator('[data-relation-key]').count(), 0);
    await page.evaluate(() => window.__setMismatch(false)); await page.waitForFunction(() => document.querySelectorAll('[data-relation-key]').length === 4);
    await page.evaluate(() => window.__setReady(false)); assert.equal(await page.locator('[data-relation-key]').count(), 0);
    const offlineReads = await page.evaluate(() => window.__reads.length); await page.waitForTimeout(2100);
    assert.equal(await page.evaluate(() => window.__reads.length), offlineReads);
    await page.evaluate(() => window.__setReady(true)); await page.waitForSelector('[data-board-fresh="true"]');
    await page.evaluate(() => window.__visible(false));
    const hiddenReads = await page.evaluate(() => window.__reads.length); await page.waitForTimeout(2100);
    assert.equal(await page.evaluate(() => window.__reads.length), hiddenReads);
    await page.evaluate(() => window.__visible(true)); await page.waitForSelector('[data-board-fresh="true"]');
    await page.evaluate(() => window.__rejectNext());
    await page.waitForSelector('[data-board-fresh="false"]'); assert.equal(await page.locator('[data-relation-key]').count(), 0);
    await page.waitForSelector('[data-board-fresh="true"]');
    await page.getByRole('combobox', { name: '选择项目' }).selectOption(JSON.stringify([fixtures.empty.scope.environmentId, 'unregistered-project']));
    await page.getByText('此项目尚未登记独立协作黑板。', { exact: true }).waitFor();
    assert.equal(await page.locator('.aaa-blackboard-details').count(), 0);
    await page.getByRole('combobox', { name: '选择项目' }).selectOption(JSON.stringify([fixtures.empty.scope.environmentId, fixtures.empty.scope.projectId]));
    await page.waitForSelector('[data-viewport]');
    assert.deepEqual(JSON.parse(await page.locator('[data-viewport]').getAttribute('data-viewport')), JSON.parse(viewport));
    cases.push({ width, height, theme, passed: true, group: 'original Flow/Canvas/Agents/route params: independent records, refresh, focus, view state, unavailable scope/provider/source',
      reads: await page.evaluate(() => window.__reads.length), viewport });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
} catch (error) { failure = error; }
finally { await browser.close(); }
await writeFile(join(evidence, 'render-results.json'), JSON.stringify({ cases, checkpoints, errors, blocked, failure: failure ? String(failure) : null,
  scriptSha256: createHash('sha256').update(script).digest('hex'), evidence: 'controlled original UI components with fixed-store data and selected project/reader boundaries; original route boundary only, full ChatView/real service pending',
  modelRequests: 0, liveNetworkRequests: 0 }, null, 2) + '\n');
if (failure) throw failure;
console.log(JSON.stringify({ passed: cases.length, models: 0, liveNetwork: 0, errors: 0 }));
