import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Original reader, session atom factory, registry and authenticated HTTP helper.
// Only the connection supervisor's prepared ref and HTTP response boundary are controlled.
const taskRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); assert.ok(at >= 0 && args[at + 1], name); return resolve(args[at + 1]); };
const assembly = option("--assembly"), evidence = option("--evidence"), esbuildPackage = option("--esbuild");
const playwright = option("--playwright"), fixtureRoot = option("--fixtures");
assert.ok(assembly.startsWith(join(taskRoot, "artifacts/runtime/")));
assert.ok(["artifacts/W1/native-child-flow-54/", "artifacts/W0-I/native-child-flow-54/"]
  .some(prefix => evidence.startsWith(join(taskRoot, prefix))));
await mkdir(evidence, { recursive: true });
const fixtures = await Promise.all(["01a0f649-c6eb-7dd2-9fa6-9ed2848fff38", "01a0f649-e098-73f1-adc7-e5d9b3943d0c"]
  .map(id => readFile(join(fixtureRoot, `actual-child-${id}.json`), "utf8").then(JSON.parse)));
const web = join(assembly, "apps/web"), client = join(assembly, "packages/client-runtime/src");
const runtime = `
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { createEnvironmentSessionAtoms } from ${JSON.stringify(join(client, "state/session.ts"))};
import { EnvironmentRegistry, EnvironmentNotRegisteredError } from ${JSON.stringify(join(client, "connection/registry.ts"))};
import { EnvironmentSupervisor } from ${JSON.stringify(join(client, "connection/supervisor.ts"))};
export const registry = AtomRegistry.make();
const refs = new Map();
let activeStreams = 0;
export const connectionActive = () => activeStreams;
export const refFor = id => { if (!refs.has(id)) refs.set(id, Effect.runSync(SubscriptionRef.make(Option.none()))); return refs.get(id); };
const originalServiceBoundary = { followStream: (id, stream) => Stream.unwrap(Effect.sync(() => {
 if (id === "33333333-3333-4333-8333-333333333333") return Stream.fail(new EnvironmentNotRegisteredError({ environmentId: id }));
 activeStreams++;
 return Stream.provideService(stream, EnvironmentSupervisor, { prepared: refFor(id) })
  .pipe(Stream.ensuring(Effect.sync(() => { activeStreams--; })));
})) };
export const connectionAtomRuntime = Atom.runtime(Layer.succeed(EnvironmentRegistry, originalServiceBoundary));
export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);
export const readPreparedConnection = id => Option.getOrNull(registry.get(environmentSession.preparedConnectionValueAtom(id)));
export const setPrepared = (id, base) => Effect.runPromise(SubscriptionRef.set(refFor(id), base === null ? Option.none() : Option.some({
  environmentId: id, label: "offline", httpBaseUrl: base, socketUrl: "ws://blocked.invalid", httpAuthorization: null,
  target: { _tag: "Primary", environmentId: id }
})));
`;
const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { registry, setPrepared, readPreparedConnection, connectionActive } from "offline-prepared-runtime";
import { useNativeChildReader } from ${JSON.stringify(join(web, "src/aaaagent/NativeChildConversation.tsx"))};
import { useNativeChildRelations } from ${JSON.stringify(join(web, "src/aaaagent/native-child-flow.ts"))};
const fixtures = ${JSON.stringify(fixtures)};
const targets = [fixtures[0].scope, { ...fixtures[0].scope, parentThreadId: "offline-ordinary-parent", nativeParentThreadId: "offline-ordinary-native" }];
function Harness() {
 const reader = useNativeChildReader(), state = useNativeChildRelations(targets, reader);
 window.__reader = reader; window.__targets = targets;
 window.__refresh = state.refresh;
 window.__state = { errors: state.errors, loading: state.loading, counts: state.records.map(record => record.children.length),
  titles: state.records.flatMap(record => record.children.map(child => child.title)) };
 return <p>{JSON.stringify(window.__state)}</p>;
}
window.__setPrepared = setPrepared; window.__snapshot = () => readPreparedConnection(targets[0].environmentId) !== null;
window.__connectionActive = connectionActive;
window.__registryDisposed = false;
window.__unmount = () => root.unmount();
window.__dispose = () => { root.unmount(); registry.dispose(); window.__registryDisposed = true; };
const root = createRoot(document.getElementById("root"));
root.render(<RegistryContext.Provider value={registry}><Harness /></RegistryContext.Provider>);
`;
const require = createRequire(join(esbuildPackage, "package.json"));
const { build } = require(esbuildPackage);
const built = await build({ stdin: { contents: entry, resolveDir: web, loader: "tsx", sourcefile: "original-connection-read.tsx" },
 bundle: true, write: false, platform: "browser", format: "esm", target: "es2022", jsx: "automatic", tsconfig: join(web, "tsconfig.json"),
 define: { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({ APP_VERSION: "offline", VITE_AAA_NATIVE_READ: "1", VITE_AAA_PREVIEW: "0", MODE: "test", DEV: false, PROD: true }) },
 plugins: [{ name: "controlled-original-connection-boundaries", setup(builder) {
  builder.onResolve({ filter: /^offline-prepared-runtime$/ }, () => ({ path: "runtime", namespace: "offline-prepared" }));
  builder.onLoad({ filter: /.*/, namespace: "offline-prepared" }, () => ({ contents: runtime, loader: "ts", resolveDir: web }));
  builder.onResolve({ filter: /^\.\.\/state\/session$/ }, input => input.importer.endsWith("NativeChildConversation.tsx")
    ? { path: "runtime", namespace: "offline-prepared" } : undefined);
  builder.onResolve({ filter: /^\.\.\/connection\/runtime$/ }, input => input.importer.endsWith("NativeChildConversation.tsx")
    ? { path: "runtime", namespace: "offline-prepared" } : undefined);
  builder.onResolve({ filter: /\?worker$/ }, input => ({ path: input.path, namespace: "unused-worker" }));
  builder.onLoad({ filter: /.*/, namespace: "unused-worker" }, () => ({ contents: 'export default class { constructor() { throw new Error("unused offline worker"); } }', loader: "js" }));
 } }], loader: { ".svg": "dataurl", ".woff2": "dataurl" }, logLevel: "silent" });
const script = built.outputFiles.find(file => file.path.endsWith(".js"))?.text ?? built.outputFiles[0].text;
const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>';
const { chromium } = await import(pathToFileURL(playwright).href), browser = await chromium.launch({ headless: true });
const requests = [], blocked = [], errors = [], results = [], abortedResponses = [];
const held = []; let pause = false, rejectNext = false;
let failure;
try {
 const context = await browser.newContext(); const page = await context.newPage();
 page.on("pageerror", error => errors.push(String(error)));
 await page.addInitScript(() => {
  for (const name of ["WebSocket", "EventSource"]) window[name] = class { constructor() { throw new Error("offline blocks " + name); } };
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error("offline blocks device"));
 });
 await page.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.host === "original-connection.invalid" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
  if (url.host === "original-connection.invalid" && url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: script });
  if (url.host.startsWith("prepared-") && url.host.endsWith(".invalid") && url.pathname.includes("/native-children")) {
   assert.equal(route.request().method(), "GET");
   const target = { ...fixtures[0].scope, environmentId: url.searchParams.get("environmentId"),
     projectId: url.searchParams.get("projectId"), parentThreadId: decodeURIComponent(url.pathname.split("/")[4]) };
   const match = fixtures.find(fixture => url.pathname.endsWith(fixture.child.nativeThreadId));
   const ordinary = url.pathname.includes("offline-ordinary-parent");
   const body = match ?? { apiVersion: "0.1.0", scope: ordinary ? { ...target, nativeParentThreadId: "offline-ordinary-native" } : target,
     children: ordinary ? [] : fixtures.map(fixture => url.host === "prepared-stale.invalid" ? { ...fixture.child, title: "obsolete connection result" } : fixture.child) };
   requests.push({ host: url.host, path: url.pathname, query: url.search, method: route.request().method() });
   if (pause) await new Promise(resolve => held.push(resolve));
   if (rejectNext) { rejectNext = false; return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "offline controlled unauthorized" }) }); }
   return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) })
    .catch(() => { abortedResponses.push({ host: url.host, path: url.pathname }); });
  }
  blocked.push(url.origin + url.pathname); return route.abort("blockedbyclient");
 });
 await page.goto("http://original-connection.invalid/");
 await page.waitForFunction(() => window.__state !== undefined);
 assert.equal(await page.evaluate(() => window.__snapshot()), false);
 assert.equal(requests.length, 0);
 const before = await page.evaluate(() => window.__state);
 await page.evaluate(() => window.__setPrepared(window.__targets[0].environmentId, "http://prepared-a.invalid"));
 await page.waitForFunction(() => window.__snapshot());
 try { await page.waitForFunction(() => window.__state.counts.length === 2, undefined, { timeout: 2500 }); } catch {}
 const after = await page.evaluate(() => window.__state);
 results.push({ case: "fresh original prepared None to Some without warm chat/manual retry", before, after, requests: [...requests] });
 assert.equal(after.errors, 0, "Original reader must not retain a cold local connection failure after prepared Some");
 assert.deepEqual(after.counts.toSorted(), [0, 2]);
 assert.equal(requests.length, 2, "One scoped GET per original parent");
 await page.evaluate(() => window.__setPrepared(window.__targets[0].environmentId, null));
 await page.waitForFunction(() => window.__state.loading);
 assert.equal(requests.length, 2, "Reconnect None must wait for the original prepared connection");
 await page.evaluate(() => window.__setPrepared(window.__targets[0].environmentId, "http://prepared-b.invalid"));
 await page.waitForFunction(() => !window.__state.loading && window.__state.counts.length === 2);
 assert.deepEqual(requests.slice(2).map(request => request.host), ["prepared-b.invalid", "prepared-b.invalid"]);
 results.push({ case: "settled relations follow original reconnect None to new Some", after: await page.evaluate(() => window.__state), requests: requests.slice(2) });
 const staleStart = requests.length;
 pause = true;
 await page.evaluate(() => window.__setPrepared(window.__targets[0].environmentId, "http://prepared-stale.invalid"));
 await assertEventually(() => held.length === 2);
 await page.evaluate(() => window.__setPrepared(window.__targets[0].environmentId, null));
 pause = false;
 await page.evaluate(() => window.__setPrepared(window.__targets[0].environmentId, "http://prepared-current.invalid"));
 await page.waitForFunction(() => !window.__state.loading && window.__state.counts.length === 2);
 held.splice(0).forEach(release => release());
 await page.waitForTimeout(50);
 assert.ok(!(await page.evaluate(() => window.__state.titles)).includes("obsolete connection result"));
 assert.equal(requests.length - staleStart, 4);
 results.push({ case: "reconnect interrupts pending old HTTP and ignores its delayed response", after: await page.evaluate(() => window.__state), requests: requests.slice(staleStart) });
 const parallelStart = requests.length;
 pause = true;
 await page.evaluate(ids => {
  window.__parallel = Promise.all([
   window.__reader.relations(window.__targets[0]), window.__reader.relations(window.__targets[1]),
   window.__reader.conversation(window.__targets[0], ids[0]), window.__reader.conversation(window.__targets[0], ids[1]),
  ]).then(rows => rows.map(row => row.child?.nativeThreadId ?? row.scope.parentThreadId));
 }, fixtures.map(fixture => fixture.child.nativeThreadId));
 await assertEventually(() => held.length === 4);
 pause = false; held.splice(0).toReversed().forEach(release => release());
 assert.deepEqual(await page.evaluate(() => window.__parallel), [fixtures[0].scope.parentThreadId, "offline-ordinary-parent", ...fixtures.map(fixture => fixture.child.nativeThreadId)]);
 assert.equal(requests.length - parallelStart, 4);
 results.push({ case: "four delayed interleaved parent/child reads retain exact own identity", requests: requests.slice(parallelStart) });
 const otherStart = requests.length;
 const otherEnvironment = "22222222-2222-4222-8222-222222222222";
 await page.evaluate(id => window.__setPrepared(id, "http://prepared-other.invalid"), otherEnvironment);
 assert.equal(await page.evaluate(id => window.__reader.relations({ ...window.__targets[0], environmentId: id })
  .then(row => row.scope.environmentId), otherEnvironment), otherEnvironment);
 assert.equal(requests.length - otherStart, 1);
 assert.equal(requests.at(-1).host, "prepared-other.invalid");
 results.push({ case: "different environment consumes its own original prepared identity", request: requests.at(-1) });
 const failureStart = requests.length;
 assert.match(await page.evaluate(() => window.__reader.relations({ ...window.__targets[0], environmentId: "33333333-3333-4333-8333-333333333333" })
  .then(() => "unexpected success", error => String(error)), undefined), /not registered/);
 assert.equal(requests.length, failureStart);
 results.push({ case: "original prepared stream failure propagates before HTTP", requests: [] });
 await page.evaluate(() => window.__setPrepared(window.__targets[0].environmentId, null));
 await page.waitForFunction(() => window.__state.loading);
 const cancelledStart = requests.length;
 const activeBeforeCancel = await page.evaluate(() => window.__connectionActive());
 await page.evaluate(id => {
  const controller = new AbortController();
  window.__abortWaitingRead = () => controller.abort();
  window.__cancelled = window.__reader.conversation({ ...window.__targets[0], environmentId: "44444444-4444-4444-8444-444444444444" }, id, { signal: controller.signal })
   .then(() => "unexpected success", () => "cancelled");
 }, fixtures[0].child.nativeThreadId);
 await page.waitForFunction(count => window.__connectionActive() === count + 1, activeBeforeCancel);
 await page.evaluate(() => window.__abortWaitingRead());
 assert.equal(await page.evaluate(() => window.__cancelled), "cancelled");
 await page.waitForFunction(count => window.__connectionActive() === count, activeBeforeCancel);
 assert.equal(await page.evaluate(() => window.__registryDisposed), false);
 assert.equal(requests.length, cancelledStart);
 results.push({ case: "cancelled original prepared wait releases its subscription while registry stays alive", requests: [], activeBefore: activeBeforeCancel, activeAfter: await page.evaluate(() => window.__connectionActive()), registryDisposed: false });
 await page.evaluate(() => window.__setPrepared(window.__targets[0].environmentId, "http://prepared-c.invalid"));
 await page.waitForFunction(() => !window.__state.loading && window.__state.counts.length === 2);
 const errorStart = requests.length; rejectNext = true;
 assert.equal(await page.evaluate(id => window.__reader.conversation(window.__targets[0], id)
  .then(() => "unexpected success", () => "original HTTP error"), fixtures[0].child.nativeThreadId), "original HTTP error");
 assert.equal(requests.length - errorStart, 1, "Cookie HTTP rejection is preserved without new authentication/retry policy");
 results.push({ case: "original HTTP 401 remains a request error", requests: requests.slice(errorStart) });
 assert.deepEqual(errors, []);
 await page.evaluate(() => window.__unmount());
 await page.waitForFunction(() => window.__connectionActive() === 0);
 assert.equal(await page.evaluate(() => window.__registryDisposed), false);
 results.push({ case: "component unmount releases original prepared subscriptions while registry stays alive", activeStreams: 0, registryDisposed: false });
 await page.evaluate(() => window.__dispose());
 await context.close();
} catch (error) { failure = String(error); }
finally {
 held.splice(0).forEach(release => release());
 await browser.close();
 const sourcePaths = ["apps/web/src/aaaagent/NativeChildConversation.tsx", "apps/web/src/aaaagent/native-child-flow.ts", "packages/client-runtime/src/state/session.ts", "packages/client-runtime/src/state/environmentHttpAuth.ts"];
 const sourceHashes = await Promise.all(sourcePaths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(assembly, path))).digest("hex") })));
 const harnessSha256 = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
 await writeFile(join(evidence, "results.json"), JSON.stringify({ sourceHashes, harnessSha256, results, requests, blocked, errors, abortedResponses, failure: failure ?? null,
   boundaries: "original reader/session factory/Atom registry/HTTP helper; controlled prepared SubscriptionRef and memory-only HTTP; no live service or private auth" }, null, 2) + "\n");
}
if (failure) throw new Error(failure);
console.log(JSON.stringify({ ok: true, cases: results.length, requests: requests.length, evidence }));

async function assertEventually(predicate) {
 const end = Date.now() + 5000;
 while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
 assert.ok(predicate(), "Controlled original reads must reach their HTTP boundary");
}
