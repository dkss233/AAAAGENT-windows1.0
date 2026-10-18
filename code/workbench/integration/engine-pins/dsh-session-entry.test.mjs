import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// The plugin is shipped as source in the DSH module-loader format, so this evaluates exactly the bytes
// the DSH web boot will evaluate - no bundling step and no mock of our own code.
const source = readFileSync(fileURLToPath(new URL('../../../desktop-pet/plugins/dsh-session-entry/lib/client.js', import.meta.url)), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

function load(hash, { refreshFails = false } = {}) {
  const loaded = [], opened = [], refreshed = [], replaced = [], listeners = new Map();
  const location = { hash, href: 'http://127.0.0.1:1234/' + hash };
  const sandbox = { URL, URLSearchParams, location, console,
    history: { replaceState: (_state, _title, url) => { replaced.push(url); location.href = url; location.hash = ''; } },
    setTimeout, clearTimeout,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  sandbox.window = { __ModuleLoader__: { load: mod => loaded.push(mod) } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  assert.equal(loaded.length, 1, 'the bundle must register exactly one module');
  const mod = loaded[0];
  assert.equal(mod.id, '@aaaagent/dsh-session-entry');
  const exports = mod.factory(() => { throw Error('the plugin must not require other modules'); });
  const ctx = { effect: fn => fn(),
    sessions: { async refresh() { refreshed.push(1); if (refreshFails) throw Error('catalog down'); } },
    uiWorkspace: { openSession: sid => opened.push(sid) } };
  exports.apply(ctx);
  return { exports, opened, refreshed, replaced, listeners, fire: async next => { location.hash = next; const fn = listeners.get('hashchange'); assert.ok(fn, 'a hashchange listener is required'); fn(); await tick(); } };
}

test('a pet deep link opens exactly that Session and consumes the hash', async () => {
  const f = load('#aaaagent-session=1&sid=t3_' + 'a'.repeat(40) + '&cwd=' + encodeURIComponent('C:/work/项目'));
  await tick();
  assert.deepEqual(f.opened, ['t3_' + 'a'.repeat(40)]);
  assert.equal(f.refreshed.length, 1, 'the catalog is refreshed before navigation');
  assert.equal(f.replaced.length, 1, 'the entry is consumed so a reload does not reopen it');
  assert.equal(f.replaced[0].includes('aaaagent-session'), false);
  // The exports come from another realm: copy before comparing, or deepEqual reports prototype drift.
  assert.deepEqual([...f.exports.inject], ['uiWorkspace', 'sessions']);
  assert.equal(f.exports.name, 'aaaagent-session-entry');
  assert.equal(typeof f.exports.apply, 'function');
});

test('ordinary hashes, malformed ids and repeats never navigate', async () => {
  for (const hash of ['', '#', '#general', '#aaaagent-session=1', '#aaaagent-session=1&sid=', '#aaaagent-session=1&sid=has%2Fslash', '#aaaagent-session=0&sid=t3_x']) {
    const f = load(hash);
    await tick();
    assert.deepEqual(f.opened, [], 'unexpected navigation for ' + JSON.stringify(hash));
  }
  const f = load('#aaaagent-session=1&sid=t3_same');
  await tick();
  await f.fire('');
  await f.fire('#aaaagent-session=1&sid=t3_same');
  assert.deepEqual(f.opened, ['t3_same'], 'the same entry must not reopen');
});

test('a failing catalog refresh still navigates, and hash changes are followed', async () => {
  const f = load('#aaaagent-session=1&sid=t3_first', { refreshFails: true });
  await tick();
  assert.deepEqual(f.opened, ['t3_first'], 'a stale catalog must not block an already known Session');
  await f.fire('#aaaagent-session=1&sid=t3_second');
  assert.deepEqual(f.opened, ['t3_first', 't3_second']);
});

test('a navigation that throws is swallowed instead of breaking the console', async () => {
  const loaded = [];
  const sandbox = { URL, URLSearchParams, console, setTimeout, clearTimeout,
    location: { hash: '#aaaagent-session=1&sid=t3_boom', href: 'http://127.0.0.1:1234/' },
    history: { replaceState: () => {} }, addEventListener: () => {}, removeEventListener: () => {} };
  sandbox.window = { __ModuleLoader__: { load: mod => loaded.push(mod) } };
  vm.runInNewContext(source, sandbox);
  const exports = loaded[0].factory(() => { throw Error('unused'); });
  exports.apply({ effect: fn => fn(), sessions: { refresh: async () => {} },
    uiWorkspace: { openSession: () => { throw Error('navigation refused'); } } });
  await tick();
  assert.ok(true, 'apply and openSession threw, and nothing propagated');
});
