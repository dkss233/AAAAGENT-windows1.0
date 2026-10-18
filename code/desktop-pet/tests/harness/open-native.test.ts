import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ForwardReceipts } from '../../harness/receipts.js';
import { HarnessForwarding } from '../../harness/forwarding.js';
import { SqliteProjectIndex } from '../../projects/sqlite-project-index.js';

const host = 'http://127.0.0.1:50066/';
const launcher = host + '?token=controlled-token';
const deep = host + '#aaaagent-session=1&sid=t3_' + 'a'.repeat(40) + '&cwd=' + encodeURIComponent('C:/work/项目');

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'open-native-'));
  const receipts = new ForwardReceipts(join(root, 'harness-relay.sqlite'));
  const projects = new SqliteProjectIndex(join(root, 'project-index.sqlite'));
  const opened: string[] = [];
  const forwarding = new HarnessForwarding({ receipts, projects, presetId: 'desktop-pet-relay-v1', workspace: root,
    compatible: async () => true, presetReady: async () => true, openUrl: async url => { opened.push(url); },
    harness: { async probe() { return { state: 'ready' as const, observedAt: 'now', codexDelivery: 'unverified' as const }; },
      async createRelaySession() {}, async submitConfirmedOperation() {} },
    codex: { list: () => [], discover: async () => ({ available: true }), async send() { throw Error('unused'); }, async receipt() { throw Error('unused'); } },
    nativeWork: { workHostUrl: async () => host, workAuthUrl: async () => launcher,
      async createWorkSession() {}, async submitWork() {}, async workReceipt() { return { status: 'working' as const }; } } });
  // One hook: closing the stores must happen before the directory disappears, and separate hooks run
  // in an order that made Windows unlink a still-open SQLite file.
  t.after(async () => { await forwarding.close(); await projects.close(); await rm(root, { recursive: true, force: true }); });
  const row = receipts.create({ text: 'controlled task', executor: 'harness' });
  receipts.mutate(row.id, value => { value.phase = 'accepted'; value.confirmedAt = new Date().toISOString();
    value.harnessSessionId = 'session-1'; value.nativeSessionUrl = deep; });
  return { receipts, forwarding, opened, id: row.id, row };
}

test('viewing a Harness task opens the session deep link, authenticating the browser once first', async t => {
  const f = await fixture(t);
  await f.forwarding.openNative(f.id);
  // The launcher URL sets this activation's cookie; the deep link can only work afterwards.
  assert.deepEqual(f.opened, [launcher, deep]);
  f.opened.length = 0;
  await f.forwarding.openNative(f.id);
  // Same host, already authenticated in this process: only the deep link is reopened.
  assert.deepEqual(f.opened, [deep]);
});

test('a receipt without a usable deep link still opens the Host root', async t => {
  const f = await fixture(t);
  for (const value of [undefined, 'http://127.0.0.1:50066/?token=leak', 'http://evil.invalid/#aaaagent-session=1&sid=t3_x',
    'http://127.0.0.1:50066/#other=1']) {
    f.opened.length = 0;
    f.receipts.mutate(f.id, row => { if (value === undefined) delete row.nativeSessionUrl; else row.nativeSessionUrl = value; });
    await f.forwarding.openNative(f.id);
    assert.deepEqual(f.opened, [host], 'unexpected open for ' + JSON.stringify(value));
  }
});
