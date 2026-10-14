import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readCompanionChatHistory } from '../../app/companion-chat-history.js';
import { COMPANION_DATABASE_ID, COMPANION_SCHEMA_VERSION } from '../../memory/database-identity.js';
import { COMPANION_CHAT_HISTORY_MAX_ROWS, COMPANION_CHAT_HISTORY_MAX_TEXT_BYTES } from '../../contracts/companion-chat-history.js';
import type { CharacterId } from '../../contracts/index.js';
const scope = { characterId: 'companion', sessionId: 'original-session', turnId: 'original-turn', generation: 2 } as const;
const text = '原始内容：引号 " 与换行\n保持原文。';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(run: (file: string, db: Database.Database) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'aaa-chat-history-')), file = join(dir, 'companion.sqlite');
  const db = new Database(file);
  try {
    db.pragma('application_id = ' + COMPANION_DATABASE_ID); db.pragma('user_version = ' + COMPANION_SCHEMA_VERSION);
    db.exec("CREATE TABLE memory_records(character_id TEXT,id TEXT,version INTEGER,kind TEXT,state TEXT,message_role TEXT,text TEXT,created_at TEXT,logical_order INTEGER,sources_json TEXT); CREATE TABLE memory_turn_outcomes(character_id TEXT,current_message_id TEXT,scope_json TEXT,text_hash TEXT)");
    run(file, db);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}
function add(db: Database.Database, id: string, role: string, content: string, order: number, sources = '[]', state = 'active', character = 'companion') {
  db.prepare('INSERT INTO memory_records VALUES(?,?,1,?,?,?,?,?,?,?)').run(character, id, 'transcript', state, role, content, '2026-10-02T05:00:00.000Z', order, sources);
}
function pair(db: Database.Database) {
  add(db, 'original-turn:user', 'user', text, 1);
  add(db, 'original-turn:assistant', 'assistant', '原答复\n第二行。', 2, '[{"id":"original-turn:user","version":1}]');
  db.prepare('INSERT INTO memory_turn_outcomes VALUES(?,?,?,?)').run('companion', 'original-turn:user', JSON.stringify(scope), hash(text));
}
test('reads exact original pair and original scope without modifying the store or creating a substitute identity', () => fixture((file, db) => {
  pair(db); const before = readFileSync(file);
  const first = readCompanionChatHistory(file, 'companion'), second = readCompanionChatHistory(file, 'companion');
  assert.equal(first.status, 'ready'); assert.deepEqual(first, second); assert.equal(first.rows.length, 2);
  assert.deepEqual(first.rows.map(r => r.sourceScope), [scope, scope]);
  assert.deepEqual(first.rows.map(r => [r.recordId, r.recordVersion, r.role, r.text]),
    [['original-turn:user', 1, 'user', text], ['original-turn:assistant', 1, 'assistant', '原答复\n第二行。']]);
  assert.equal(first.hasMore, false); assert.deepEqual(readFileSync(file), before);
}));
test('excludes foreign/deleted/invalidated rows and refuses assistant provenance with an obsolete source version', () => fixture((file, db) => {
  pair(db); add(db, 'foreign:user', 'user', '不能泄漏', 9, '[]', 'active', 'other');
  add(db, 'deleted:user', 'user', '不能恢复', 10, '[]', 'deleted');
  add(db, 'invalid:user', 'user', '不能恢复', 11, '[]', 'invalidated');
  db.prepare('UPDATE memory_records SET version=2 WHERE id=?').run('original-turn:user');
  const result = readCompanionChatHistory(file, 'companion'); assert.equal(result.status, 'ready');
  assert.deepEqual(result.rows.map(row => row.recordId), ['original-turn:user']);
  assert.equal(readCompanionChatHistory(file, 'other' as CharacterId).status, 'unavailable');
}));
test('keeps unknown or edited historical scope null instead of assigning the new backend session', () => fixture((file, db) => {
  pair(db); db.prepare('UPDATE memory_records SET text=? WHERE message_role=?').run('修改后的原文', 'user');
  assert.deepEqual(readCompanionChatHistory(file, 'companion').rows.map(r => r.sourceScope), [null, null]);
  db.prepare('UPDATE memory_turn_outcomes SET scope_json=?').run(JSON.stringify({ ...scope, characterId: 'other' }));
  assert.deepEqual(readCompanionChatHistory(file, 'companion').rows.map(r => r.sourceScope), [null, null]);
}));
test('bounds recent display, preserves full UTF8 bodies, and refuses oversized records without truncation', () => fixture((file, db) => {
  for (let i = 1; i <= COMPANION_CHAT_HISTORY_MAX_ROWS + 3; i++) add(db, 'u' + i, 'user', '完整正文' + i, i);
  const recent = readCompanionChatHistory(file, 'companion'); assert.equal(recent.rows.length, COMPANION_CHAT_HISTORY_MAX_ROWS);
  assert.equal(recent.hasMore, true); assert.equal(recent.rows[0]?.recordId, 'u4'); assert.equal(recent.rows.at(-1)?.recordId, 'u53');
  add(db, 'too-large', 'user', '界'.repeat(COMPANION_CHAT_HISTORY_MAX_TEXT_BYTES), 100);
  const refused = readCompanionChatHistory(file, 'companion'); assert.equal(refused.status, 'unavailable'); assert.deepEqual(refused.rows, []);
}));
test('missing, wrong product identity and malformed provenance never become restored records', () => fixture((file, db) => {
  pair(db); db.prepare('UPDATE memory_records SET sources_json=? WHERE message_role=?').run('{broken', 'assistant');
  assert.equal(readCompanionChatHistory(file, 'companion').status, 'unavailable');
  assert.equal(readCompanionChatHistory(file + '.absent', 'companion').status, 'unavailable');
  db.pragma('application_id = 0'); assert.equal(readCompanionChatHistory(file, 'companion').status, 'unavailable');
}));
