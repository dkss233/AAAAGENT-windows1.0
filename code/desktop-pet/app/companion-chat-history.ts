import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isProductCharacter } from '../contracts/character.js';
import type { CharacterId, TurnScope } from '../contracts/index.js';
import {
  COMPANION_CHAT_HISTORY_VERSION, COMPANION_CHAT_HISTORY_MAX_ROWS,
  COMPANION_CHAT_HISTORY_MAX_TEXT_BYTES,
  unavailableCompanionChatHistory,
  type CompanionChatHistory, type CompanionChatHistoryRow,
} from '../contracts/companion-chat-history.js';
import { assertDatabaseFileIdentity } from '../memory/database-identity.js';

interface StoredRow {
  id: string; version: number; message_role: 'user' | 'assistant';
  text: string | null; created_at: string; logical_order: number; sources_json: string | null;
}
interface StoredOutcome { scope_json: string | null; text_hash: string }
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0');
/** Reads the existing PET2 store in one snapshot; creates no schema, records or model jobs. */
export function readCompanionChatHistory(filename: string, characterId: CharacterId): CompanionChatHistory {
  if (!isProductCharacter(characterId)) return unavailableCompanionChatHistory(characterId);
  let db: Database.Database | undefined;
  try {
    assertDatabaseFileIdentity(filename);
    db = new Database(filename, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    const connection = db;
    return connection.transaction((): CompanionChatHistory => {
      const selected = connection.prepare(
        'SELECT id,version,message_role,created_at,logical_order,' +
        'CASE WHEN length(CAST(text AS BLOB))<=? THEN text ELSE NULL END AS text,' +
        'CASE WHEN length(CAST(sources_json AS BLOB))<=4096 THEN sources_json ELSE NULL END AS sources_json ' +
        "FROM memory_records WHERE character_id=? AND kind='transcript' AND state='active' " +
        "AND message_role IN ('user','assistant') ORDER BY logical_order DESC,id DESC LIMIT ?"
      ).all(COMPANION_CHAT_HISTORY_MAX_TEXT_BYTES, characterId, COMPANION_CHAT_HISTORY_MAX_ROWS + 1) as StoredRow[];
      const hasMore = selected.length > COMPANION_CHAT_HISTORY_MAX_ROWS;
      const window = selected.slice(0, COMPANION_CHAT_HISTORY_MAX_ROWS).reverse();
      if (window.some(row => !identifier(row.id) || row.text === null || !row.text.trim() ||
        row.text.includes('\0') || row.sources_json === null || !Number.isSafeInteger(row.version) ||
        row.version < 1 || !Number.isSafeInteger(row.logical_order) || row.logical_order < 1 ||
        !Number.isFinite(Date.parse(row.created_at)))) return unavailableCompanionChatHistory(characterId);
      const users = new Map(window.filter(row => row.message_role === 'user').map(row => [row.id, row]));
      const outcome = connection.prepare(
        'SELECT CASE WHEN length(CAST(scope_json AS BLOB))<=2048 THEN scope_json ELSE NULL END AS scope_json,text_hash ' +
        'FROM memory_turn_outcomes WHERE character_id=? AND current_message_id=?'
      );
      function originalScope(user: StoredRow): TurnScope | null {
        const saved = outcome.get(characterId, user.id) as StoredOutcome | undefined;
        // The lifecycle stores SHA256(JSON.stringify(text)), not SHA256(raw UTF8).
        if (!saved?.scope_json || saved.text_hash !==
          createHash('sha256').update(JSON.stringify(user.text)).digest('hex')) return null;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(saved.scope_json) as Record<string, unknown>; } catch { return null; }
        if (!parsed || typeof parsed !== 'object' || parsed.characterId !== characterId ||
          !identifier(parsed.sessionId) || !identifier(parsed.turnId) ||
          !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 0 ||
          user.id !== parsed.turnId + ':user') return null;
        return { characterId, sessionId: parsed.sessionId, turnId: parsed.turnId, generation: Number(parsed.generation) };
      }
      const rows: CompanionChatHistoryRow[] = [];
      let textBytes = 0;
      for (const row of window) {
        let user: StoredRow | undefined = row.message_role === 'user' ? row : undefined;
        if (row.message_role === 'assistant') {
          // The record id is the exact pointer: '<turnId>:assistant' answers '<turnId>:user', and the
          // pair shares one turn id. Matching on that is what proves the reply belongs to a message in
          // this window. Sources are corroboration only, so a well-formed '[]' — the common case when
          // the memory layer cited nothing — must NOT drop the reply. Requiring a citation did exactly
          // that and left the panel showing the operator's own messages only.
          //
          // Malformed sources still abort the panel: unreadable provenance means the store cannot be
          // trusted for display, which is a separate decision from "this reply cited nothing".
          let sources: unknown;
          try { sources = JSON.parse(row.sources_json!); } catch { return unavailableCompanionChatHistory(characterId); }
          if (!Array.isArray(sources)) return unavailableCompanionChatHistory(characterId);
          const suffix = ':assistant';
          if (!row.id.endsWith(suffix)) continue;
          const answer = users.get(row.id.slice(0, -suffix.length) + ':user');
          if (!answer) continue;
          // A reply whose cited source version no longer matches its user record is stale evidence.
          const cited = sources.filter(source => !!source && typeof source === 'object' &&
            (source as { id?: unknown }).id === answer.id);
          if (cited.some(source => (source as { version?: unknown }).version !== answer.version)) continue;
          user = answer;
        }
        textBytes += Buffer.byteLength(row.text!, 'utf8');
        if (textBytes > COMPANION_CHAT_HISTORY_MAX_TEXT_BYTES) return unavailableCompanionChatHistory(characterId);
        rows.push({ characterId, recordId: row.id, recordVersion: row.version, role: row.message_role,
          text: row.text!, createdAt: row.created_at, logicalOrder: row.logical_order,
          sourceScope: user ? originalScope(user) : null });
      }
      return { version: COMPANION_CHAT_HISTORY_VERSION, characterId, status: 'ready', rows, hasMore };
    }).deferred();
  } catch {
    return unavailableCompanionChatHistory(characterId);
  } finally {
    db?.close();
  }
}
