import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolveDshHistoryBinding } from './dsh-native-history.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT);
    CREATE TABLE projection_threads(thread_id TEXT,project_id TEXT,deleted_at TEXT);
    CREATE TABLE provider_session_runtime(thread_id TEXT,provider_name TEXT,provider_instance_id TEXT,resume_cursor_json TEXT,runtime_payload_json TEXT);`);
  const query = { environmentId: 'env-original', projectId: 'project-original', workspaceRoot: '/workspace/original',
    providerInstanceId: 'dsh', threadId: 'thread-original' };
  const nativeId = 't3_' + createHash('sha256').update(JSON.stringify([query.environmentId, query.threadId])).digest('hex').slice(0, 40);
  db.prepare('INSERT INTO projection_projects VALUES(?,?,NULL)').run(query.projectId, query.workspaceRoot);
  db.prepare('INSERT INTO projection_threads VALUES(?,?,NULL)').run(query.threadId, query.projectId);
  db.prepare('INSERT INTO provider_session_runtime VALUES(?,?,?,?,NULL)').run(query.threadId, 'dsh', 'dsh', JSON.stringify({ sessionId: nativeId }));
  return { db, query, nativeId };
}
test('original DB supplies the deterministic same native session; browser cannot select a native ID', t => {
  const { db, query, nativeId } = fixture(t);
  assert.deepEqual(resolveDshHistoryBinding(db, query.environmentId, query),
    { sessionId: nativeId, cwd: query.workspaceRoot, preset: 'desktop-pet-work-v1' });
  assert.throws(() => resolveDshHistoryBinding(db, query.environmentId, { ...query, nativeSessionId: 'foreign' }));
});
test('changed live environment and project/workspace/provider/thread queries cannot reach native history', t => {
  const { db, query } = fixture(t);
  assert.throws(() => resolveDshHistoryBinding(db, 'env-other', query));
  for (const key of ['projectId', 'workspaceRoot', 'providerInstanceId', 'threadId']) {
    assert.throws(() => resolveDshHistoryBinding(db, query.environmentId, { ...query, [key]: 'foreign' }));
  }
});
test('retargeted provider or resume cursor cannot expose another original session', t => {
  const { db, query } = fixture(t);
  db.prepare('UPDATE provider_session_runtime SET resume_cursor_json=?').run(JSON.stringify({ sessionId: 't3_foreign' }));
  assert.throws(() => resolveDshHistoryBinding(db, query.environmentId, query));
  db.prepare('UPDATE provider_session_runtime SET provider_name=?').run('codex');
  assert.throws(() => resolveDshHistoryBinding(db, query.environmentId, query));
});
test('deleted original thread or project cannot be read through retained native bindings', t => {
  const { db, query } = fixture(t);
  db.exec("UPDATE projection_threads SET deleted_at='deleted'");
  assert.throws(() => resolveDshHistoryBinding(db, query.environmentId, query));
  db.exec("UPDATE projection_threads SET deleted_at=NULL; UPDATE projection_projects SET deleted_at='deleted'");
  assert.throws(() => resolveDshHistoryBinding(db, query.environmentId, query));
});

test('an imported existing native SID needs the trusted readonly import identity and retains its real preset', t => {
  const { db, query } = fixture(t), sid = 'session-existing-original';
  db.exec('DELETE FROM provider_session_runtime; DELETE FROM projection_threads');
  const imported = { ...query, threadId: 'import:dsh:' + sid };
  db.prepare('INSERT INTO projection_threads VALUES(?,?,NULL)').run(imported.threadId, query.projectId);
  const runtime = { cwd: query.workspaceRoot, nativeImport: { kind: 'dsh', sessionId: sid, preset: 'original-user-preset', readonly: true } };
  db.prepare('INSERT INTO provider_session_runtime VALUES(?,?,?,?,?)').run(imported.threadId, 'dsh', 'dsh', JSON.stringify({ sessionId: sid }), JSON.stringify(runtime));
  assert.deepEqual(resolveDshHistoryBinding(db, query.environmentId, imported), { sessionId: sid, cwd: query.workspaceRoot, preset: 'original-user-preset' });
  for (const change of [{ readonly: false }, { sessionId: 'foreign' }, { preset: '' }]) {
    db.prepare('UPDATE provider_session_runtime SET runtime_payload_json=?').run(JSON.stringify({ ...runtime, nativeImport: { ...runtime.nativeImport, ...change } }));
    assert.throws(() => resolveDshHistoryBinding(db, query.environmentId, imported));
  }
});
