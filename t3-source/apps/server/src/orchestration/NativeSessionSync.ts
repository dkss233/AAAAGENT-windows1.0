// @effect-diagnostics globalDate:off -- The clock only expires advisory UI observation; provider evidence uses original timestamps.
import { CommandId, MessageId, ProviderInstanceId, NativeSessionSyncPayload, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { NativeRealtimeQueue } from "./NativeRealtimeQueue.ts";
import * as DateTime from "effect/DateTime";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { object, digest, nativeMessageKey, nativeBindingToken, decodeCodexHistory, planNativeHistory, type NativeHistory } from "./NativeSessionHistory.ts";

class NativeSyncReadError extends Data.TaggedError("NativeSyncReadError")<{ readonly message: string }> {}
const registrations = new Set<(threadId: ThreadId) => void>();
const viewed = new Map<ThreadId, { lastView: number; subscribers: number }>();
/** Advisory watch registration. It conveys no native ID, provider setting, write authorization or model request. */
export function requestNativeSessionSync(threadId: ThreadId) { const current = viewed.get(threadId); viewed.set(threadId, { lastView: Date.now(), subscribers: current?.subscribers ?? 0 }); for (const notify of registrations) notify(threadId); }

export function attachNativeSessionSyncWatch(threadId: ThreadId) {
  requestNativeSessionSync(threadId); viewed.get(threadId)!.subscribers++;
  let closed = false;
  return () => { if (closed) return; closed = true; const watch = viewed.get(threadId); if (watch) watch.subscribers = Math.max(0, watch.subscribers - 1); };
}

export const makeNativeSessionSync = Effect.gen(function* () {
  const directoryOption = yield* Effect.serviceOption(ProviderSessionDirectory);
  const registryOption = yield* Effect.serviceOption(ProviderAdapterRegistry);
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const turnRepository = yield* ProjectionTurnRepository;
  const messageRepository = yield* ProjectionThreadMessageRepository;
  if (Option.isNone(directoryOption) || Option.isNone(registryOption)) return Effect.void;
  const directory = directoryOption.value, registry = registryOption.value;
  const queue = new NativeRealtimeQueue<ThreadId>();
  const watches = new Map<ThreadId, { token: string; adapter: unknown; close: () => void }>();
  const closeWatch = (threadId: ThreadId) => { watches.get(threadId)?.close(); watches.delete(threadId); };
  const syncOne = Effect.fn("NativeSessionSync.syncOne")(function* (threadId: ThreadId) {
    const bindingOption = yield* directory.getBinding(threadId);
    if (Option.isNone(bindingOption)) { closeWatch(threadId); return; }
    const binding = bindingOption.value;
    if (!["codex", "dsh"].includes(binding.provider) || !binding.providerInstanceId || binding.status === "starting") { closeWatch(threadId); return; }
    const scope = object(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(nativeBindingToken(binding)))!;
    const detail = yield* snapshots.getThreadDetailById(threadId, { activityKinds: ["native.session.sync"] });
    if (Option.isNone(detail) || detail.value.archivedAt !== null || detail.value.deletedAt !== null) { closeWatch(threadId); return; }
    const thread = detail.value;
    const prior = object(thread.activities.find(a => a.kind === "native.session.sync")?.payload);
    if (prior && (prior.nativeId !== scope.nativeId || prior.instanceId !== scope.instanceId)) throw Error("Original native sync scope changed");
    const info = yield* registry.getInstanceInfo(ProviderInstanceId.make(scope.instanceId));
    if (!info.enabled || info.driverKind !== scope.provider) { closeWatch(threadId); return; }
    const adapter = yield* registry.getByInstance(ProviderInstanceId.make(scope.instanceId));
    if (adapter.provider !== scope.provider || !adapter.readNativeThread) { closeWatch(threadId); return; }
    const token = nativeBindingToken(binding), watched = watches.get(threadId);
    if (!watched || watched.token !== token || watched.adapter !== adapter) {
      closeWatch(threadId);
      if (adapter.watchNativeThread) {
        const close = yield* adapter.watchNativeThread({ threadId: scope.nativeId, cwd: scope.cwd }, () => queue.mark(threadId))
          .pipe(Effect.orElseSucceed(() => undefined));
        if (close) watches.set(threadId, { token, adapter, close });
      }
    }
    // Local execution already enters the same projection through ProviderRuntimeIngestion.
    if (thread.session?.status === "running" || thread.session?.status === "starting") return;
    const checkpoint = object(prior?.checkpoint) ?? {};
    const read = adapter.readNativeThread({ threadId: scope.nativeId, cwd: scope.cwd, includeTurns: true, ...(scope.nativePreset ? { nativePreset: scope.nativePreset } : {}), checkpoint: checkpoint.native });
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const attempt = yield* Effect.result(read.pipe(Effect.timeout("25 seconds")));
    let history: NativeHistory | null = null;
    if (Result.isSuccess(attempt)) history = yield* Effect.try({
      try: () => scope.provider === "codex" ? decodeCodexHistory(attempt.success, scope.nativeId, scope.cwd) : attempt.success as NativeHistory,
      catch: () => new NativeSyncReadError({ message: "Original native history validation failed" }),
    }).pipe(Effect.orElseSucceed(() => null));
    if (history && (history.nativeId !== scope.nativeId || history.cwd !== scope.cwd)) history = null;
    const savedTurns = yield* turnRepository.listByThreadId({ threadId });
    const existing = [...thread.messages];
    if (history) {
      const candidates = new Set<string>();
      for (const turn of history.turns) for (const row of turn.messages) {
        candidates.add(`assistant:${row.id}`);
        candidates.add(nativeMessageKey(scope.provider, scope.nativeId, turn, row));
      }
      for (const turn of savedTurns) if (turn.pendingMessageId) candidates.add(turn.pendingMessageId);
      for (const id of candidates) {
        if (existing.some(m => m.id === id)) continue;
        const row = yield* messageRepository.getByMessageId({ messageId: MessageId.make(id) });
        if (Option.isSome(row)) {
          if (row.value.threadId !== threadId) throw Error("Original message belongs to another thread");
          const { messageId, isStreaming, threadId: _threadId, ...message } = row.value;
          existing.push({ ...message, id: messageId, streaming: isStreaming });
        }
      }
    }
    const plan = history ? yield* Effect.try({ try: () => planNativeHistory(history!, scope.provider, savedTurns, existing, checkpoint.aliases ?? {}), catch: () => new NativeSyncReadError({ message: "Native history/T3 identity conflict" }) }).pipe(Effect.orElseSucceed(() => null)) : null;
    const content = {
      threadId, provider: scope.provider, instanceId: scope.instanceId, nativeId: scope.nativeId,
      expectedBinding: nativeBindingToken(binding), observation: plan && history ? history.observation : "unknown",
      checkpoint: plan && history ? { native: history.checkpoint, aliases: plan.aliases, latestTurn: history.complete ? plan.latestTurn ?? checkpoint.latestTurn ?? null : checkpoint.latestTurn ?? null } : checkpoint,
      messages: plan?.messages ?? [], turns: plan?.turns ?? [],
      latestTurn: history?.complete && plan ? plan.latestTurn ?? checkpoint.latestTurn ?? null : null,
    };
    // Digest represents native content/state, not poll time. Duplicate reads produce no event.
    const syncVersion = digest({ binding: content.expectedBinding, observation: content.observation, checkpoint: content.checkpoint, nativeTurns: scope.provider === "codex" && history && plan ? history.turns : null });
    const payload = yield* Schema.decodeUnknownEffect(NativeSessionSyncPayload)({ ...content, checkedAt, previousVersion: prior?.syncVersion ?? null, syncVersion });
    // The ledger retains rejected commands too. A new observation must be able
    // to retry unchanged native content after an earlier local-write conflict;
    // previousVersion still makes successful projection commits idempotent.
    if (syncVersion !== prior?.syncVersion) yield* engine.dispatch({ type: "thread.native-session.sync", commandId: CommandId.make(`native-sync:${threadId}:${digest([prior?.syncVersion ?? null, syncVersion, checkedAt])}`), ...payload });
    if (history && !history.complete && plan) queue.mark(threadId);
    if (scope.provider === "codex" && binding.status === "running" && payload.observation === "ready" && payload.latestTurn?.state === "completed") {
      yield* engine.dispatch({ type: "thread.native-session.release", threadId, checkedAt, expectedBinding: payload.expectedBinding, commandId: CommandId.make(`native-release:${threadId}:${payload.latestTurn.turnId}:${syncVersion}`) });
    }
  });
  // Subscribe before reconciliation; queued identities survive in-flight reads and reconnects.
  return Effect.scoped(Effect.gen(function* () {
    const notify = (threadId: ThreadId) => queue.mark(threadId);
    registrations.add(notify);
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      registrations.delete(notify); queue.close(); for (const id of [...watches.keys()]) closeWatch(id);
    }));
    const changes = yield* registry.subscribeChanges;
    const reconcile = Effect.gen(function* () {
      for (const binding of yield* directory.listBindings()) queue.mark(binding.threadId);
      for (const id of viewed.keys()) queue.mark(id);
    });
    yield* Stream.runForEach(Stream.fromSubscription(changes), () => reconcile).pipe(Effect.forkScoped);
    yield* Stream.runForEach(engine.streamDomainEvents, event => Effect.sync(() => {
      if (["thread.created", "thread.session-set", "thread.history-imported", "thread.archived", "thread.unarchived", "thread.deleted"].includes(event.type)) {
        const payload = object(event.payload); if (typeof payload?.threadId === "string") queue.mark(payload.threadId as ThreadId);
      }
    })).pipe(Effect.forkScoped);
    yield* reconcile;
    while (true) {
      const threadId = yield* Effect.promise(signal => queue.take(signal));
      if (threadId === undefined) return;
      yield* syncOne(threadId).pipe(Effect.catchCause(() => Effect.logDebug("Original native session sync unavailable", { threadId })));
    }
  }));
});
