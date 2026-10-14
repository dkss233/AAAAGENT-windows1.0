// @effect-diagnostics nodeBuiltinImport:off -- Isolated SQLite integration evidence.
import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ProviderInstanceId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import { ProviderAdapterValidationError, type ProviderAdapterError } from "../provider/Errors.ts";
import { makeTestProviderAdapterHarness } from "../../integration/TestProviderAdapter.integration.ts";
import { makeAdapterRegistryMock } from "../provider/testUtils/providerAdapterRegistryMock.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";
import { makeNativeSessionSync, requestNativeSessionSync } from "./NativeSessionSync.ts";
import { object, type NativeHistory } from "./NativeSessionHistory.ts";

const pause = (ms: number) => Effect.runPromise(Effect.sleep(`${ms} millis`));
async function until(read: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 150; attempt++) { if (await read()) return; await pause(10); }
  throw Error("Native history projection did not receive its source notification");
}

describe.each(["codex", "dsh"] as const)("%s notification to durable T3 projection", provider => {
  it("stays idle, publishes exact-SID updates, deduplicates, and retains history/checkpoint across read failure", async () => {
    const threadId = ThreadId.make("realtime-imported-thread"), projectId = ProjectId.make("realtime-project");
    const nativeId = "11111111-1111-4111-8111-111111111111", cwd = "/tmp/realtime-original";
    let notify: (() => void) | undefined, reads = 0, watchCloses = 0, generation = 1, unavailable = false, enabled = true;
    const requests: Array<{ threadId: string; cwd: string; checkpoint?: unknown; nativePreset?: string }> = [];
    const fixture = await Effect.runPromise(makeTestProviderAdapterHarness({ provider: ProviderDriverKind.make(provider) }));
    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      ...fixture.adapter, watchNativeThread: (input, callback) => Effect.sync(() => {
        expect(input).toEqual({ threadId: nativeId, cwd }); notify = callback; return () => { watchCloses++; notify = undefined; };
      }),
      readNativeThread: input => Effect.suspend<unknown, ProviderAdapterError, never>(() => {
        reads++; requests.push(input); if (unavailable) return Effect.fail(new ProviderAdapterValidationError({ provider, operation: "controlled-read", issue: "source disconnected" }));
        if (provider === "dsh") return Effect.succeed<NativeHistory>({ nativeId, cwd, observation: "ready", complete: true, checkpoint: { afterSeq: generation * 2 },
          turns: Array.from({ length: generation }, (_, index) => ({ id: `original-turn-${index}`, state: "completed", startedAt: "2026-10-05T00:00:02.000Z", completedAt: "2026-10-05T00:00:03.000Z",
            messages: [{ role: "user", id: `original-user-${index}`, text: `original input ${index}`, createdAt: "2026-10-05T00:00:02.000Z" },
              { role: "assistant", id: `original-answer-${index}`, text: `original answer ${index}`, createdAt: "2026-10-05T00:00:03.000Z" }] })) });
        return Effect.succeed({ id: nativeId, cwd, createdAt: 1, updatedAt: 3,
          turns: Array.from({ length: generation }, (_, index) => ({ id: `original-turn-${index}`, status: "completed", startedAt: 2, completedAt: 3,
            items: [{ type: "userMessage", id: `original-user-${index}`, content: [{ type: "text", text: `original input ${index}` }] },
              { type: "agentMessage", id: `original-answer-${index}`, text: `original answer ${index}` }] })) });
      }),
    };
    const registry = makeAdapterRegistryMock({ [ProviderDriverKind.make(provider)]: adapter });
    const adapterRegistry = { ...registry, getInstanceInfo: (instanceId: ProviderInstanceId) => registry.getInstanceInfo(instanceId).pipe(Effect.map(info => ({ ...info, enabled }))) };
    const baseLayer = Layer.mergeAll(
      OrchestrationEngineLive.pipe(Layer.provide(OrchestrationProjectionSnapshotQueryLive), Layer.provide(OrchestrationProjectionPipelineLive)),
      OrchestrationProjectionSnapshotQueryLive, ProjectionTurnRepositoryLive, ProjectionThreadMessageRepositoryLive,
      ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
      Layer.succeed(ProviderAdapterRegistry, adapterRegistry),
    ).pipe(
      Layer.provideMerge(ThreadBackgroundLiveness.layer), Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationEventStoreLive), Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer), Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "realtime-native-sync-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(baseLayer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshots = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const read = () => runtime.runPromise(snapshots.getThreadDetailById(threadId)).then(Option.getOrThrow);
    const pushed: string[] = [];
    const subscriber = runtime.runFork(Stream.runForEach(engine.streamDomainEvents, event => Effect.sync(() => { pushed.push(event.type); })));
    let worker: ReturnType<typeof runtime.runFork> | undefined;
    try {
      const createdAt = "2026-10-05T00:00:00.000Z";
      await runtime.runPromise(engine.dispatch({ type: "project.create", commandId: CommandId.make("realtime-project"), projectId, title: "Original project", workspaceRoot: cwd, createdAt }));
      await runtime.runPromise(engine.dispatch({ type: "thread.create", commandId: CommandId.make("realtime-thread"), threadId, projectId, title: "Original history", historyImport: true,
        modelSelection: { instanceId: ProviderInstanceId.make(provider), model: "fixture" }, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdAt }));
      const cursor = provider === "codex" ? { threadId: nativeId } : { sessionId: nativeId };
      const originalRuntime = provider === "codex" ? { cwd } : { cwd, nativeImport: { kind: "dsh", sessionId: nativeId, preset: "original-native-preset", readonly: true } };
      await runtime.runPromise(sql`INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json) VALUES (${threadId}, ${provider}, ${provider}, ${provider}, 'full-access', 'stopped', ${createdAt}, ${JSON.stringify(cursor)}, ${JSON.stringify(originalRuntime)})`);
      worker = runtime.runFork(Effect.flatMap(makeNativeSessionSync, work => work));
      await until(async () => (await read()).messages.length === 2);
      expect(reads).toBe(1); await pause(5200); expect(reads).toBe(1);
      generation = 2; notify!(); notify!();
      await until(async () => (await read()).messages.length === 4);
      expect(reads).toBe(2);
      const before = await read(), beforePayload = object(before.activities.find(a => a.kind === "native.session.sync")!.payload)!;
      notify!(); await until(async () => reads === 3); await pause(80);
      expect((await read()).messages).toEqual(before.messages);
      expect(pushed.filter(type => type === "thread.native-session-synced")).toHaveLength(2);
      unavailable = true; notify!();
      await until(async () => object((await read()).activities.find(a => a.kind === "native.session.sync")?.payload)?.observation === "unknown");
      const failed = await read(); expect(failed.messages).toEqual(before.messages);
      expect(object(failed.activities.find(a => a.kind === "native.session.sync")!.payload)?.checkpoint).toEqual(beforePayload.checkpoint);
      unavailable = false; generation = 3; notify!();
      await until(async () => (await read()).messages.length === 6);
      requestNativeSessionSync(threadId); await until(async () => reads === 6); await pause(80);
      expect((await read()).messages).toHaveLength(6);
      expect(requests.every(request => request.threadId === nativeId && request.cwd === cwd)).toBe(true);
      if (provider === "dsh") expect(requests.every(request => request.nativePreset === "original-native-preset")).toBe(true);
      expect(pushed.some(type => type === "thread.turn-start-requested")).toBe(false);
      expect(Option.getOrThrow(await runtime.runPromise(snapshots.getThreadShellById(threadId))).nativeSessionObservation?.nativeId).toBe(nativeId);
      enabled = false; requestNativeSessionSync(threadId); await until(async () => watchCloses === 1);
      const retained = await read(), disabledReads = reads; requestNativeSessionSync(threadId); await pause(80);
      expect(reads).toBe(disabledReads); expect(notify).toBeUndefined(); expect((await read()).messages).toEqual(retained.messages);
      enabled = true; requestNativeSessionSync(threadId); await until(async () => reads === disabledReads + 1); await pause(80);
      expect((await read()).messages).toEqual(retained.messages);
      const binding = await runtime.runPromise(sql`SELECT resume_cursor_json, runtime_payload_json FROM provider_session_runtime WHERE thread_id=${threadId}`);
      expect(JSON.parse(binding[0]!.resume_cursor_json as string)).toEqual(cursor); expect(JSON.parse(binding[0]!.runtime_payload_json as string)).toEqual(originalRuntime);
      // A checkpoint rejected during a previous local-write conflict must be
      // retried after a new source observation, without restarting a model.
      const originalDispatch = engine.dispatch, attempts: string[] = [];
      let rejectNextSync = true;
      Object.assign(engine, { dispatch: (command: Parameters<typeof originalDispatch>[0]) => {
        if (command.type === "thread.native-session.sync") {
          attempts.push(command.commandId);
          if (rejectNextSync) { rejectNextSync = false; return originalDispatch({ ...command, expectedBinding: "obsolete-binding" }); }
        }
        return originalDispatch(command);
      } });
      try {
        generation = 4; notify!(); await until(async () => attempts.length === 1); await pause(80);
        expect((await read()).messages).toHaveLength(6);
        const rejected = await runtime.runPromise(sql`SELECT status FROM orchestration_command_receipts WHERE command_id=${attempts[0]!}`);
        expect(rejected[0]!.status).toBe("rejected");
        notify!(); await until(async () => (await read()).messages.length === 8);
        expect(attempts).toHaveLength(2); expect(attempts[1]).not.toBe(attempts[0]);
      } finally { Object.assign(engine, { dispatch: originalDispatch }); }
    } finally {
      if (worker) await Effect.runPromise(Fiber.interrupt(worker));
      await Effect.runPromise(Fiber.interrupt(subscriber)); await runtime.dispose();
    }
    expect(watchCloses).toBe(2);
  }, 15000);
});
