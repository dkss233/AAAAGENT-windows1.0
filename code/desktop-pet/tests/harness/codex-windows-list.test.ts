import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { CodexWindowsConnection } from '../../harness/codex-windows.js';
import { CodexAppError } from '../../harness/codex-app.js';

const SCHEMA = 'CREATE TABLE local_thread_catalog(host_id TEXT NOT NULL, thread_id TEXT NOT NULL, display_title TEXT, cwd TEXT, source_kind TEXT, missing_candidate INTEGER NOT NULL DEFAULT 0, source_updated_at TEXT)';

/** Build the catalog table the Windows App writes, with the rows that must and must not be listed. */
async function catalog(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), 'codex-win-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'sqlite'), { recursive: true });
  const db = new Database(join(home, 'sqlite', 'codex-dev.db'));
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT INTO local_thread_catalog(host_id,thread_id,display_title,cwd,source_kind,missing_candidate,source_updated_at) VALUES(?,?,?,?,?,?,?)');
  insert.run('local', '11111111-1111-4111-8111-111111111111', '恢复上个项目对话', 'C:\\work\\alpha', 'vscode', 0, '2026-10-02T10:00:00Z');
  insert.run('local', '22222222-2222-4222-8222-222222222222', null, 'C:\\work\\gamma', 'cli', 0, '2026-10-03T10:00:00Z');
  insert.run('local', '33333333-3333-4333-8333-333333333333', '已经消失的任务', 'C:\\work\\beta', 'vscode', 1, '2026-10-04T10:00:00Z');
  insert.run('local', '44444444-4444-4444-8444-444444444444', '云端任务', 'C:\\work\\delta', 'chatgpt', 0, '2026-10-05T10:00:00Z');
  insert.run('remote', '55555555-5555-4555-8555-555555555555', '另一个主机的任务', 'C:\\elsewhere', 'vscode', 0, '2026-10-06T10:00:00Z');
  // A task with no working directory cannot be resolved for forwarding, so it must not be offered.
  insert.run('local', '66666666-6666-4666-8666-666666666666', '没有目录的任务', null, 'vscode', 0, '2026-10-07T10:00:00Z');
  db.close();
  return home;
}

test('the Windows catalog lists only local, present, continuable tasks that have a directory', async t => {
  const home = await catalog(t);
  const targets = new CodexWindowsConnection(home).list('', 10);
  assert.deepEqual(targets.map(item => item.threadId), ['22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111']);
  assert.equal(targets[0]!.title, '未命名任务');
  assert.equal(targets[0]!.projectPath, 'C:\\work\\gamma');
  assert.equal(targets[1]!.projectPath, 'C:\\work\\alpha');
  assert.ok(targets.every(item => item.hostId === 'local'));
});

test('a chosen target is re-read by its thread id, which confirmation depends on', async t => {
  const home = await catalog(t);
  const connection = new CodexWindowsConnection(home);
  // forwarding.validatePrepare calls list(threadId) and refuses the card when nothing comes back.
  const found = connection.list('11111111-1111-4111-8111-111111111111');
  assert.deepEqual(found.map(item => item.threadId), ['11111111-1111-4111-8111-111111111111']);
  assert.equal(found[0]!.title, '恢复上个项目对话');
});

test('the Windows catalog searches title and directory, and refuses nonsense instead of guessing', async t => {
  const home = await catalog(t);
  const connection = new CodexWindowsConnection(home);
  assert.deepEqual(connection.list('恢复', 10).map(item => item.title), ['恢复上个项目对话']);
  assert.deepEqual(connection.list('alpha', 10).map(item => item.threadId), ['11111111-1111-4111-8111-111111111111']);
  assert.deepEqual(connection.list('gamma', 10).map(item => item.threadId), ['22222222-2222-4222-8222-222222222222']);
  assert.equal(connection.list('', 1).length, 1);
  assert.throws(() => connection.list('', 0), (error: unknown) => error instanceof CodexAppError && error.code === 'invalid_target');
  assert.throws(() => connection.list('x'.repeat(201), 10), (error: unknown) => error instanceof CodexAppError && error.code === 'invalid_target');
});

test('a missing catalog refuses to guess instead of reporting an empty task list', async t => {
  const home = await mkdtemp(join(tmpdir(), 'codex-win-empty-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.throws(() => new CodexWindowsConnection(home).list('', 10), (error: unknown) => error instanceof CodexAppError && error.code === 'unavailable');
});
