import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), taskRoot = resolve(here, '../../../../../..');
const option = name => { const at = process.argv.indexOf(name); assert.ok(at >= 0 && process.argv[at + 1]); return resolve(process.argv[at + 1]); };
const assembly = option('--assembly'), evidence = option('--evidence'), esbuildPath = option('--esbuild'), playwright = option('--playwright');
assert.ok(assembly.startsWith(join(taskRoot, 'artifacts/runtime/')));
assert.ok(evidence.startsWith(join(taskRoot, 'artifacts/W1/independent-blackboard-54/')));
await mkdir(evidence, { recursive: true });
const fixtures = JSON.parse(execFileSync('/usr/bin/python3', [join(here, 'fixtures.py')], { encoding: 'utf8' }));
const web = join(assembly, 'apps/web'), client = join(assembly, 'packages/client-runtime/src');
const runtime = `
import * as Effect from 'effect/Effect'; import * as Layer from 'effect/Layer'; import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream'; import * as SubscriptionRef from 'effect/SubscriptionRef';
import { Atom, AtomRegistry } from 'effect/unstable/reactivity';
import { createEnvironmentSessionAtoms } from ${JSON.stringify(join(client, 'state/session.ts'))};
import { EnvironmentRegistry, EnvironmentNotRegisteredError } from ${JSON.stringify(join(client, 'connection/registry.ts'))};
import { EnvironmentSupervisor } from ${JSON.stringify(join(client, 'connection/supervisor.ts'))};
export const registry = AtomRegistry.make(); const refs = new Map(); let streams = 0;
const ref = id => { if (!refs.has(id)) refs.set(id, Effect.runSync(SubscriptionRef.make(Option.none()))); return refs.get(id); };
const boundary = { followStream: (id, stream) => Stream.unwrap(Effect.sync(() => {
 if (id === '33333333-3333-4333-8333-333333333333') return Stream.fail(new EnvironmentNotRegisteredError({ environmentId: id }));
 streams++;
 return Stream.provideService(stream, EnvironmentSupervisor, { prepared: ref(id) }).pipe(Stream.ensuring(Effect.sync(() => { streams--; })));
})) };
export const connectionAtomRuntime = Atom.runtime(Layer.succeed(EnvironmentRegistry, boundary));
export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);
export const setPrepared = (id, base) => Effect.runPromise(SubscriptionRef.set(ref(id), base === null ? Option.none() : Option.some({
 environmentId: id, label: 'controlled', httpBaseUrl: base, socketUrl: 'ws://blocked.invalid', httpAuthorization: null,
 target: { _tag: 'Primary', environmentId: id }
})));
export const activeStreams = () => streams;
`;
const entry = `
import React from 'react'; import { createRoot } from 'react-dom/client'; import { RegistryContext } from '@effect/atom-react';
import { registry, setPrepared, activeStreams } from 'controlled-prepared-runtime';
import { useBlackboardReader } from ${JSON.stringify(join(web, 'src/aaaagent/BlackboardReader.tsx'))};
import { useIndependentBlackboard } from ${JSON.stringify(join(web, 'src/aaaagent/IndependentBlackboard.tsx'))};
const scope = ${JSON.stringify(fixtures.empty.scope)};
function Harness() {
 const reader = useBlackboardReader(), state = useIndependentBlackboard(scope, reader);
 window.__reader = reader; window.__state = { phase: state.phase, fresh: state.fresh, loading: state.loading, revision: state.snapshot?.revision ?? null };
 return <p>{JSON.stringify(window.__state)}</p>;
}
const root = createRoot(document.getElementById('root'));
root.render(<RegistryContext.Provider value={registry}><Harness /></RegistryContext.Provider>);
window.__setPrepared = setPrepared; window.__activeStreams = activeStreams; window.__scope = scope;
window.__unmount = () => root.unmount(); window.__dispose = () => registry.dispose();
`;
const esbuild = createRequire(import.meta.url)(esbuildPath);
const built = await esbuild.build({ stdin: { contents: entry, loader: 'tsx', resolveDir: web }, bundle: true, write: false,
 platform: 'browser', format: 'esm', jsx: 'automatic', target: 'es2022', tsconfig: join(web, 'tsconfig.json'),
 define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ APP_VERSION: 'controlled', VITE_AAA_NATIVE_READ: '1', VITE_AAA_PREVIEW: '0', MODE: 'test', DEV: false, PROD: true }) },
 plugins: [{ name: 'original-session-factory-controlled-supervisor', setup(builder) {
  builder.onResolve({ filter: /^controlled-prepared-runtime$/ }, () => ({ path: 'runtime', namespace: 'prepared-boundary' }));
  builder.onLoad({ filter: /.*/, namespace: 'prepared-boundary' }, () => ({ contents: runtime, loader: 'ts', resolveDir: web }));
  builder.onResolve({ filter: /^\.\.\/(?:state\/session|connection\/runtime)$/ }, input => input.importer.endsWith('BlackboardReader.tsx')
    ? { path: 'runtime', namespace: 'prepared-boundary' } : undefined);
  builder.onResolve({ filter: /\?worker$/ }, input => ({ path: input.path, namespace: 'unused-worker' }));
  builder.onLoad({ filter: /.*/, namespace: 'unused-worker' }, () => ({ contents: 'export default class { constructor() { throw Error("unused controlled worker"); } }', loader: 'js' }));
 } }], loader: { '.svg': 'dataurl', '.woff2': 'dataurl' }, logLevel: 'silent' });
const script = built.outputFiles[0].text;
const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>';
const { chromium } = await import(pathToFileURL(playwright).href), browser = await chromium.launch({ headless: true });
const requests = [], cases = [], errors = [], blocked = [], held = [];
let pause = false, status = 200, body = fixtures.assigned, failure;
try {
 const context = await browser.newContext(), page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
 await page.addInitScript(() => {
  for (const name of ['WebSocket', 'EventSource']) window[name] = class { constructor() { throw Error('controlled blocks ' + name); } };
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(Error('controlled blocks device'));
  window.__credentials = [];
  const original = window.fetch;
  window.fetch = (input, options) => { window.__credentials.push(options?.credentials ?? (input instanceof Request ? input.credentials : null)); return original(input, options); };
 });
 await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.host === 'board-connection.invalid' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
  if (url.host === 'board-connection.invalid' && url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: script });
  if (url.host.startsWith('prepared-') && url.host.endsWith('.invalid') && url.pathname.endsWith('/independent-blackboard')) {
   assert.equal(route.request().method(), 'GET');
   const request = { host: url.host, path: url.pathname, environmentId: url.searchParams.get('environmentId'), method: route.request().method(), status };
   requests.push(request);
   const currentStatus = status, current = url.host === 'prepared-obsolete.invalid' ? fixtures.empty : body;
   const response = currentStatus === 200 ? { ...current, scope: { ...current.scope, environmentId: request.environmentId } } :
     { error: currentStatus === 404 ? 'board_unavailable' : currentStatus === 401 ? 'native_auth_expired' : 'board_read_unavailable' };
   if (pause) await new Promise(resolve => held.push(resolve));
   return route.fulfill({ status: currentStatus, contentType: 'application/json', body: JSON.stringify(response) }).catch(() => {});
  }
  blocked.push(url.origin + url.pathname); return route.abort('blockedbyclient');
 });
 await page.goto('http://board-connection.invalid/'); await page.waitForFunction(() => window.__state !== undefined);
 assert.equal(requests.length, 0); assert.equal((await page.evaluate(() => window.__state)).fresh, false);
 await page.evaluate(() => window.__setPrepared(window.__scope.environmentId, 'http://prepared-first.invalid'));
 await page.waitForFunction(() => window.__state.fresh);
 assert.equal(requests.length, 1); assert.equal(requests[0].environmentId, fixtures.empty.scope.environmentId);
 assert.equal((await page.evaluate(() => window.__state)).revision, fixtures.assigned.revision);
 cases.push({ name: 'cold original None to Some, one typed authenticated scoped GET', passed: true, request: requests[0] });
 await page.evaluate(() => window.__setPrepared(window.__scope.environmentId, null));
 await page.waitForFunction(() => !window.__state.fresh); assert.equal(requests.length, 1);
 body = fixtures.final;
 await page.evaluate(() => window.__setPrepared(window.__scope.environmentId, 'http://prepared-second.invalid'));
 await page.waitForFunction(() => window.__state.fresh && window.__state.revision > 1);
 assert.equal(requests.length, 2); cases.push({ name: 'settled read invalidated at None and reread on new original Some', passed: true });
 pause = true;
 await page.evaluate(() => window.__setPrepared(window.__scope.environmentId, 'http://prepared-obsolete.invalid'));
 await until(() => held.length === 1);
 await page.evaluate(() => window.__setPrepared(window.__scope.environmentId, null));
 pause = false;
 await page.evaluate(() => window.__setPrepared(window.__scope.environmentId, 'http://prepared-current.invalid'));
 await page.waitForFunction(() => window.__state.fresh);
 held.splice(0).forEach(resolve => resolve()); await page.waitForTimeout(80);
 assert.equal((await page.evaluate(() => window.__state)).revision, fixtures.final.revision);
 cases.push({ name: 'pending old original connection interrupted; delayed obsolete response ignored', passed: true });
 await page.evaluate(() => window.__unmount()); await page.waitForFunction(() => window.__activeStreams() === 0);
 cases.push({ name: 'unmount releases original streams with shared registry alive', passed: true });
 const count = requests.length;
 const other = '22222222-2222-4222-8222-222222222222';
 await page.evaluate(id => window.__setPrepared(id, 'http://prepared-other.invalid'), other);
 assert.equal(await page.evaluate(id => window.__reader.snapshot({ ...window.__scope, environmentId: id }, { signal: new AbortController().signal }).then(row => row.scope.environmentId), other), other);
 assert.equal(requests.length, count + 1); assert.equal(requests.at(-1).host, 'prepared-other.invalid');
 cases.push({ name: 'another environment uses its own original prepared connection', passed: true });
 for (const code of [401, 404, 503]) {
  status = code;
  const previous = requests.length;
  const result = await page.evaluate(() => window.__reader.snapshot(window.__scope, { signal: new AbortController().signal })
    .then(() => ({ unexpectedSuccess: true }), error => ({ name: error.constructor.name, status: error.status ?? null })));
  cases.push({ name: `original helper preserves mount ${code} failure classification`, response: result, requests: requests.length - previous, passed: result.status === code });
  assert.equal(requests.length - previous, 1); assert.equal(result.status, code);
 }
 assert.ok((await page.evaluate(() => window.__credentials)).every(value => value === 'include'));
 assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
 await page.evaluate(() => window.__dispose()); await context.close();
} catch (error) { failure = error; }
finally { held.splice(0).forEach(resolve => resolve()); await browser.close(); }
await writeFile(join(evidence, 'connection-results.json'), JSON.stringify({ cases, requests, errors, blocked, failure: failure ? String(failure) : null,
 scriptSha256: createHash('sha256').update(script).digest('hex'), evidence: 'original reader, typed client/auth helper, original session factory/runtime/registry; prepared supervisor and all HTTP memory boundaries controlled',
 liveNetworkRequests: 0, modelRequests: 0 }, null, 2) + '\n');
if (failure) throw failure;
console.log(JSON.stringify({ passed: cases.length, liveNetwork: 0, models: 0 }));
async function until(condition) {
 const limit = Date.now() + 5000;
 while (!condition()) { if (Date.now() > limit) throw Error('Controlled pending HTTP timeout'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
