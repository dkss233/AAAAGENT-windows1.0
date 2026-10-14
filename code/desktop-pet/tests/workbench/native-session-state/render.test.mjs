import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../../../..');
const option = name => { const i = process.argv.indexOf(name); assert.ok(i >= 0 && process.argv[i + 1]); return resolve(process.argv[i + 1]); };
const assembly = option('--assembly'), evidence = option('--evidence');
assert.ok(assembly.startsWith(join(root, 'artifacts/runtime/native-session-state-54/')));
assert.ok(evidence.startsWith(join(root, 'artifacts/W1/native-session-state-54/')));
await mkdir(evidence, { recursive: true });
const web = join(assembly, 'apps/web'), require = createRequire(join(web, 'package.json'));
const esbuild = createRequire(import.meta.url)(option('--esbuild')), React = require('react');
const renderer = require('react-test-renderer'), { renderToStaticMarkup } = require('react-dom/server');
const { act } = renderer;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
globalThis.matchMedia = () => ({ matches: true });
const stateBoundary = `
import { useSyncExternalStore } from 'react';
let threads = []; const listeners = new Set();
const projects = [{ environmentId: 'env', id: 'project', title: '原项目' }];
const configs = new Map([['env', { providers: [{ instanceId: 'provider', driver: 'codex', displayName: 'Codex' }] }]]);
export const replaceThreads = value => { threads = value; listeners.forEach(notify => notify()); };
export const useProjects = () => projects;
export const useServerConfigs = () => configs;
export const useThreadShells = () => useSyncExternalStore(notify => { listeners.add(notify); return () => listeners.delete(notify); }, () => threads);
`;
const routeBoundary = `export const navigations = []; const navigate = value => { navigations.push(value); }; export const useNavigate = () => navigate;`;
const stubs = {
  '../state/entities': stateBoundary,
  '@tanstack/react-router': routeBoundary,
  '@t3tools/client-runtime/environment': 'export const scopeThreadRef = (environmentId, threadId) => ({ environmentId, threadId });',
  '../threadRoutes': 'export const buildThreadRouteParams = ref => ref;',
  '../components/ui/sidebar': 'import React from "react"; export const SidebarInset = props => React.createElement("div", props);',
  './NativeReadBoundary': 'export const NATIVE_READ = false;',
  './NativeChildConversation': 'export const useNativeChildReader = () => null; export const NativeChildConversation = () => null;',
  './native-child-flow': 'export const nativeChildKey = (target, id) => id; export const projectChildFlowNodes = nodes => ({ nodes, edges: [] }); export const useNativeChildRelations = () => ({ records: [], loading: false, errors: 0, refresh() {} });',
  './BlackboardReader': 'export const useBlackboardReader = () => null;',
  './IndependentBlackboard': 'const state = { fresh: false }; export const useIndependentBlackboard = () => state; export const useOriginalBoardThreads = () => []; export const checkedBoardState = value => value; export const IndependentBlackboardPanel = () => null;',
  './independent-blackboard': 'export const projectBoardFlow = nodes => ({ nodes, edges: [] });',
};
const flowPath = join(web, 'src/aaaagent/FlowOverview.tsx');
const chat = await readFile(join(web, 'src/components/ChatView.tsx'), 'utf8');
const memoStart = chat.indexOf('  const nativeSessionBannerItem = useMemo<');
const memoEnd = chat.indexOf('\n  const composerBannerItems = useMemo<', memoStart);
assert.ok(memoStart >= 0 && memoEnd > memoStart);
const entry = `
import React, { useMemo } from 'react';
import { InfoIcon } from 'lucide-react';
import { nativeSessionState } from ${JSON.stringify(join(web, 'src/aaaagent/native-session-state.ts'))};
import { ComposerBannerStack, type ComposerBannerStackItem } from ${JSON.stringify(join(web, 'src/components/chat/ComposerBannerStack.tsx'))};
export { FlowOverview } from ${JSON.stringify(flowPath)};
export { replaceThreads } from '../state/entities';
export { navigations } from '@tanstack/react-router';
const NATIVE_READ = false;
export function NativeBanner({ activeThreadShell }) {
${chat.slice(memoStart, memoEnd)}
return <ComposerBannerStack items={nativeSessionBannerItem ? [nativeSessionBannerItem] : []} />;
}
`;
async function bundle(name, baseline = false) {
  const outfile = join(assembly, `${name}.cjs`);
  const baselineSource = baseline ? execFileSync('git', ['show', 'a477266c688af1724fd181c2d8fab074df1b50d6:code/desktop-pet/t3-native/apps/web/src/aaaagent/FlowOverview.tsx'], { cwd: root, encoding: 'utf8' }) : null;
  await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: web }, outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
    tsconfig: join(web, 'tsconfig.json'), logLevel: 'silent', plugins: [{ name: 'controlled-external-read-boundaries', setup(build) {
      build.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: require.resolve(args.path), external: true }));
      build.onResolve({ filter: /.*/ }, args => args.path in stubs && (args.importer === flowPath || args.importer.endsWith('<stdin>')) ?
        { path: args.path, namespace: 'boundary' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'boundary' }, args => ({ contents: stubs[args.path], loader: 'tsx', resolveDir: web }));
      if (baseline) build.onLoad({ filter: /FlowOverview\.tsx$/ }, () => ({ contents: baselineSource, loader: 'tsx', resolveDir: dirname(flowPath) }));
    } }] });
  return require(outfile);
}
const at = '2026-10-03T05:00:00.000Z';
const fixture = (id, status) => ({ id, environmentId: 'env', projectId: 'project', title: '同名原对话',
  createdAt: at, updatedAt: at, archivedAt: null, modelSelection: { instanceId: 'provider', model: 'fixed-model' },
  session: { status: 'stopped', lastError: null, updatedAt: at }, settledAt: at,
  backgroundLiveness: null, hasPendingApprovals: false, hasPendingUserInput: false,
  latestTurn: { state: 'completed', requestedAt: at, startedAt: at, completedAt: at },
  nativeSessionObservation: { provider: 'codex', instanceId: 'provider', nativeId: `native-${id}`, status, checkedAt: at, syncVersion: 'v1' } });
const observations = [];
const baseline = await bundle('baseline-flow', true);
baseline.replaceThreads([fixture('a', 'running')]);
let view;
await act(() => { view = renderer.create(React.createElement(baseline.FlowOverview, { preferredEnvironment: 'env', preferredProject: 'project' })); });
const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : node ? text(node.children) : '';
assert.match(text(view.toJSON()), /已结束/);
observations.push({ name: 'original-regression', native: 'running', local: 'stopped', originalLabel: '已结束' });
await act(() => view.unmount()); storage.clear();

const current = await bundle('current-flow');
const a = fixture('a', 'running'), b = fixture('b', 'ready');
current.replaceThreads([a, b]);
await act(() => { view = renderer.create(React.createElement(current.FlowOverview, { preferredEnvironment: 'env', preferredProject: 'project' })); });
const cards = () => view.root.findAll(node => node.type === 'article' && node.props['data-thread-id']);
assert.equal(cards().length, 2);
assert.match(cards()[0].props['aria-label'], /原生进行中/); assert.match(cards()[1].props['aria-label'], /原生空闲/);
await act(() => view.root.findByProps({ 'aria-label': '状态筛选' }).props.onChange({ target: { value: 'working' } }));
assert.deepEqual(cards().map(node => node.props['data-thread-id']), ['a']);
await act(() => view.root.findByProps({ 'aria-label': '状态筛选' }).props.onChange({ target: { value: 'settled' } }));
assert.equal(cards().length, 0);
await act(() => view.root.findByProps({ 'aria-label': '状态筛选' }).props.onChange({ target: { value: 'all' } }));
await act(() => view.root.findAll(node => node.type === 'button' && node.children.includes('画布'))[0].props.onClick());
assert.equal(cards().length, 2);
await act(() => view.root.findByProps({ 'aria-label': '展开对话 b' }).props.onClick());
assert.deepEqual(current.navigations.at(-1), { to: '/$environmentId/$threadId', params: { environmentId: 'env', threadId: 'b' } });
observations.push({ name: 'original-list-canvas-filter-route', nodes: ['a', 'b'], labels: cards().map(node => node.props['aria-label']), route: current.navigations.at(-1) });
const unknownA = { ...a, nativeSessionObservation: { ...a.nativeSessionObservation, status: 'unknown', syncVersion: 'v2' } };
await act(() => current.replaceThreads([unknownA, b]));
assert.match(cards()[0].props['aria-label'], /原生待核验/); assert.match(cards()[1].props['aria-label'], /原生空闲/);
await act(() => view.unmount());
await act(() => { view = renderer.create(React.createElement(current.FlowOverview, { preferredEnvironment: 'env', preferredProject: 'project' })); });
assert.match(cards()[0].props['aria-label'], /原生待核验/); assert.equal(cards()[0].props.style.position, 'absolute');
await act(() => view.unmount());
observations.push({ name: 'observation-update-and-remount', sameNameSeparateIds: true, canvasPreferenceKept: true });

for (const thread of [a, b, unknownA, { ...a, nativeSessionObservation: null }]) {
  const markup = renderToStaticMarkup(React.createElement(current.NativeBanner, { activeThreadShell: thread }));
  assert.match(markup, /data-thread-id="a"|data-thread-id="b"/);
  assert.match(markup, /本地已结束/); assert.doesNotMatch(markup, /<button/);
  if (thread.nativeSessionObservation) {
    assert.ok(markup.includes(`data-native-id="${thread.nativeSessionObservation.nativeId}"`));
    assert.match(markup, /最近同步更新时间/); assert.doesNotMatch(markup, /最近核验/);
  }
  const expected = thread.nativeSessionObservation?.status === 'running' ? '原生进行中' : thread.nativeSessionObservation?.status === 'ready' ? '原生空闲' : thread.nativeSessionObservation?.status === 'unknown' ? '原生待核验' : '原生未核验';
  assert.ok(markup.includes(expected));
  observations.push({ name: 'original-chat-memo-and-banner-stack', threadId: thread.id, nativeId: thread.nativeSessionObservation?.nativeId ?? null, label: expected, actions: 0 });
}
assert.equal(renderToStaticMarkup(React.createElement(current.NativeBanner, { activeThreadShell: null })), '');
const stack = chat.slice(chat.indexOf('  const composerBannerItems = useMemo<'), chat.indexOf('\n  useEffect(() => {\n    setPendingServerThreadEnvMode', memoEnd));
assert.equal(stack.match(/\.\.\.nativeSessionItems/g)?.length, 2, 'both original banner return paths include the read-only notice');
await writeFile(join(evidence, 'observations.json'), JSON.stringify({ scope: 'controlled React original components; no foreground/browser/model/device/service operations', observations }, null, 2) + '\n');
console.log(`Passed ${observations.length} controlled rendering observations; original baseline regression preserved.`);
