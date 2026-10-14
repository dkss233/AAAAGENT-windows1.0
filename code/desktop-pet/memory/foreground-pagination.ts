import type { ConversationMessage } from '../contracts/index.js';

export interface RecentPageRow { readonly message: ConversationMessage; readonly order: number; readonly rowId: number }
export interface RecentCursor { readonly order: number; readonly rowId: number }
export interface RecentPage { readonly rows: readonly RecentPageRow[]; readonly hasMore: boolean }
/** Lazy descending pages. A user-led group is yielded only after its boundary is read. */
export class ForegroundRecentTurns implements Iterable<readonly ConversationMessage[]> {
  private unread = true;
  constructor(private readonly page: (cursor: RecentCursor | null) => RecentPage) {}
  hasUnread(): boolean { return this.unread; }
  *[Symbol.iterator](): Generator<readonly ConversationMessage[]> {
    let cursor: RecentCursor | null = null;
    let assistants: ConversationMessage[] = [];
    for (;;) {
      const page = this.page(cursor);
      this.unread = page.rows.length > 0 || page.hasMore;
      for (let index = 0; index < page.rows.length; index++) {
        const row = page.rows[index]!;
        cursor = { order: row.order, rowId: row.rowId };
        this.unread = index + 1 < page.rows.length || page.hasMore;
        if (row.message.role === 'user') {
          const turn = [row.message, ...assistants.reverse()]; assistants = [];
          yield turn;
        } else assistants.push(row.message);
      }
      if (!page.hasMore) {
        this.unread = false;
        // Leading orphan replies are reported, never admitted as independent turns.
        if (assistants.length) yield assistants.reverse();
        return;
      }
    }
  }
}
