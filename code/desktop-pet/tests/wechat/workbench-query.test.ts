import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, realpath, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WorkbenchChannelReadPort, WorkbenchChannelTaskRead, WorkbenchTaskRef } from '../../contracts/workbench.js';
import { WeChatStore } from '../../wechat/store.js';
import { WorkbenchQuery } from '../../wechat/workbench-query.js';

const signal = new AbortController().signal;
type T3Row = { task: Extract<WorkbenchTaskRef, { origin: 't3' }>; projection: NonNullable<WorkbenchChannelTaskRead['projection']> };
async function fixture(t: TestContext) {
  const parent = resolve('../../artifacts/W2/workbench-54/tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(await realpath(parent), 'query-'));
  let store = new WeChatStore(join(root, 'channel.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const taskId = randomUUID(), projectId = 'directory-synthetic-project';
  const row: T3Row = {
    task: { id: taskId, projectId, provider: 'codex', origin: 't3', environmentId: 'env', t3ProjectId: 'native-project', threadId: 'native-thread', providerInstanceId: 'instance' },
    projection: { taskId, sequence: 1, eventId: 'event-1', phase: 'running' },
  };
  const reads: string[] = [], lists: string[] = [];
  let value: typeof row = row, failure: Error | undefined;
  const read: WorkbenchChannelReadPort = {
    async listTasks(id) { lists.push(id); return { tasks: [value] }; },
    async refreshTask(id) { reads.push(id); if (failure) throw failure; return value; },
  };
  const query = (key: string, port: WorkbenchChannelReadPort | null = read) => new WorkbenchQuery({ read: port ?? undefined, store, channelKey: key });
  return { root, get store() { return store; }, taskId, projectId, row, read, reads, lists, query,
    reopen: () => { store.close(); store = new WeChatStore(join(root, 'channel.sqlite')); },
    setValue: (next: typeof row) => { value = next; }, setFailure: (next: Error | undefined) => { failure = next; } };
}

test('exact UUID readback saves durable same-channel focus; subsequent query survives restart without listing or dispatch', async t => {
  const f = await fixture(t), first = f.query('bound-user-a');
  assert.equal((await first.handle('查询任务', signal)).handled, false);
  const chosen = await first.handle('选择任务 ' + f.taskId, signal);
  assert.equal(chosen.handled, true);
  if (chosen.handled) assert.match(chosen.text!, /进行中/);
  f.reopen();
  const restarted = f.query('bound-user-a');
  const resumed = await restarted.handle('查询任务结果', signal, 'latest');
  if (resumed.handled) assert.match(resumed.text!, /进行中/);
  assert.deepEqual(f.reads, [f.taskId, f.taskId]);
  assert.deepEqual(f.lists, []);
  assert.equal((await f.query('bound-user-b').handle('查询任务', signal)).handled, false);
  const all = await restarted.handle('查询所有任务进度', signal, 'all');
  assert.equal(all.handled, false);
  const afterAll = await restarted.handle('查询任务', signal);
  if (afterAll.handled) assert.match(afterAll.text!, /进行中/);
});

test('unverified explicit UUID, empty projection, changed project or native identity return pending and never select', async t => {
  const f = await fixture(t), query = f.query('bound-user');
  f.setValue({ ...f.row, task: { ...f.row.task, id: randomUUID() } });
  let result = await query.handle('查询任务 ' + f.taskId, signal);
  if (result.handled) assert.match(result.text!, /待核/);
  assert.equal((await query.handle('查询任务', signal)).handled, false);
  f.setValue({ ...f.row, projection: null as never });
  result = await query.handle('查询任务 ' + f.taskId, signal);
  if (result.handled) assert.match(result.text!, /待核/);
  f.setValue(f.row);
  await query.handle('查询任务 ' + f.taskId, signal);
  f.setValue({ ...f.row, task: { ...f.row.task, projectId: 'other-project' } });
  result = await query.handle('查询任务', signal);
  if (result.handled) assert.match(result.text!, /待核/);
  f.setValue({ ...f.row, task: { ...f.row.task, threadId: 'different-native-thread' } });
  result = await query.handle('查询任务', signal);
  if (result.handled) assert.match(result.text!, /待核/);
  f.setFailure(Error('secret native failure'));
  result = await query.handle('查询任务', signal);
  if (result.handled) { assert.match(result.text!, /待核/); assert.doesNotMatch(result.text!, /secret/); }
  assert.deepEqual(f.lists, []);
});

test('missing read port keeps old unfocused query route but fails closed for explicit or focused T3 task', async t => {
  const f = await fixture(t), unavailable = f.query('bound-user', null);
  assert.equal((await unavailable.handle('查询任务', signal)).handled, false);
  const selected = await unavailable.handle('查看任务 ' + f.taskId, signal);
  if (selected.handled) assert.match(selected.text!, /待核/);
  await f.query('bound-user').handle('选择任务 ' + f.taskId, signal);
  const focused = await unavailable.handle('查询任务', signal);
  if (focused.handled) assert.match(focused.text!, /待核/);
  assert.deepEqual(f.lists, []);
});

test('late read cannot overwrite a newer task focus or produce a delayed answer', async t => {
  const f = await fixture(t), secondId = randomUUID(), query = f.query('bound-user');
  let release!: (value: typeof f.row) => void;
  const slow: WorkbenchChannelReadPort = {
    listTasks: f.read.listTasks,
    refreshTask: id => id === f.taskId ? new Promise(resolve => { release = resolve; }) : Promise.resolve({
      ...f.row, task: { ...f.row.task, id }, projection: { ...f.row.projection, taskId: id },
    }),
  };
  const active = f.query('late-channel', slow);
  const old = active.handle('选择任务 ' + f.taskId, signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  const fresh = await active.handle('选择任务 ' + secondId, signal);
  if (fresh.handled) assert.match(fresh.text!, /进行中/);
  release(f.row);
  const delayed = await old;
  assert.equal(delayed.handled, true);
  if (delayed.handled) { assert.equal(delayed.text, undefined); assert.equal(delayed.current(), false); }
  const persisted = f.store.get<{ task: { id: string } }>('workbench-focus:late-channel');
  assert.equal(persisted?.task.id, secondId);
  assert.equal((await query.handle('查询任务', signal)).handled, false);
});
