import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";

type ReadClient = { readonly raw: { readonly request: (method: string, params: unknown) => Effect.Effect<unknown, CodexErrors.CodexAppServerError> } };
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Read the original native fields/items, including every paginated turn. Never loads/resumes a thread. */
export const readCompleteNativeThread = Effect.fn("readCompleteNativeThread")(function* (
  client: ReadClient, threadId: string, includeTurns: boolean, checkpoint?: unknown,
) {
  const response = record(yield* client.raw.request("thread/read", { threadId, includeTurns: false }));
  const thread = record(response?.thread);
  const fail = (message: string) => CodexErrors.CodexAppServerRequestError.internalError(message, undefined, { method: "thread/read", operation: "decode-payload" });
  if (!thread || thread.id !== threadId) return yield* fail("Original native thread identity mismatch.");
  if (!includeTurns) return thread;
  if (thread.historyMode !== "paginated") {
    const full = record(yield* client.raw.request("thread/read", { threadId, includeTurns: true }));
    const native = record(full?.thread);
    if (!native || native.id !== threadId || !Array.isArray(native.turns)) return yield* fail("Invalid original native history.");
    return yield* Schema.decodeUnknownEffect(Schema.Json)(native).pipe(Effect.mapError(() => fail("Invalid native JSON history.")));
  }
  const saved = record(checkpoint);
  const afterTurnId = typeof saved?.afterTurnId === "string" ? saved.afterTurnId : undefined;
  if (afterTurnId) {
    const newest: unknown[] = [], visited = new Set<string | null>(); let cursor: string | null = null;
    do {
      if (visited.has(cursor)) return yield* fail("Original incremental native cursor repeated."); visited.add(cursor);
      const page = record(yield* client.raw.request("thread/turns/list", { threadId, cursor, limit: 100, sortDirection: "desc", itemsView: "full" }));
      if (!page || !Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === "string")) return yield* fail("Invalid original incremental native page.");
      for (const item of page.data) {
        const turn = record(item);
        if (!turn || typeof turn.id !== "string" || !Array.isArray(turn.items)) return yield* fail("Invalid original incremental native turn.");
        newest.push(turn);
        if (turn.id === afterTurnId) return yield* Schema.decodeUnknownEffect(Schema.Json)({ ...thread, turns: newest.reverse() }).pipe(Effect.mapError(() => fail("Invalid native incremental JSON history.")));
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return yield* fail("Original incremental native checkpoint is no longer present.");
  }
  const turns: unknown[] = []; const cursors = new Set<string | null>();
  let cursor: string | null = null;
  do {
    if (cursors.has(cursor)) return yield* fail("Original native history repeated a pagination cursor.");
    cursors.add(cursor);
    const page = record(yield* client.raw.request("thread/turns/list", { threadId, cursor, limit: 100, sortDirection: "asc", itemsView: "full" }));
    if (!page || !Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === "string")) return yield* fail("Invalid original native history page.");
    for (const turn of page.data) {
      const value = record(turn);
      if (!value || typeof value.id !== "string" || !Array.isArray(value.items)) return yield* fail("Invalid original native turn.");
      turns.push(turn);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  // Preserve native turn status/error and all typed item fields; no summary conversion here.
  return yield* Schema.decodeUnknownEffect(Schema.Json)({ ...thread, turns }).pipe(Effect.mapError(() => fail("Invalid native JSON history.")));
});
