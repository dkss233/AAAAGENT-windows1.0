import type { CharacterId, TurnScope } from './index.js';

/** Read-only display of stored records. A restored row is never a new turn event. */
export const COMPANION_CHAT_HISTORY_VERSION = '0.1.0' as const;
export const COMPANION_CHAT_HISTORY_MAX_ROWS = 50;
export const COMPANION_CHAT_HISTORY_MAX_TEXT_BYTES = 256 * 1024;
export interface CompanionChatHistoryRow {
  readonly characterId: CharacterId;
  readonly recordId: string;
  readonly recordVersion: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly createdAt: string;
  readonly logicalOrder: number;
  /** Exact original persisted turn identity, or null when that evidence is absent. */
  readonly sourceScope: TurnScope | null;
}
export interface CompanionChatHistory {
  readonly version: typeof COMPANION_CHAT_HISTORY_VERSION;
  readonly characterId: CharacterId;
  readonly status: 'ready' | 'unavailable';
  readonly rows: readonly CompanionChatHistoryRow[];
  readonly hasMore: boolean;
}
export const unavailableCompanionChatHistory = (characterId: CharacterId): CompanionChatHistory =>
  ({ version: COMPANION_CHAT_HISTORY_VERSION, characterId, status: 'unavailable', rows: [], hasMore: false });
