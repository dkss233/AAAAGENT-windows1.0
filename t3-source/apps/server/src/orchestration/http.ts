import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderAdapterRegistryLive } from "../provider/Layers/ProviderAdapterRegistry.ts";
import { readNativeChildRelations, readNativeChildConversation, NativeChildScopeError } from "./NativeChildFlow.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const commandReceipts = yield* OrchestrationCommandReceiptRepository;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
    const providerRegistry = yield* ProviderRegistry;
    const directory = yield* ProviderSessionDirectory;
    const registry = yield* ProviderAdapterRegistry;
    const environment = yield* ServerEnvironment;

    return handlers
      .handle("nativeChildRelations", Effect.fn("environment.orchestration.nativeChildRelations")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* readNativeChildRelations({ environmentId: yield* environment.getEnvironmentId,
          projection: projectionSnapshotQuery, directory, registry }, { ...args.payload, threadId: args.params.threadId }).pipe(
          Effect.catch(Effect.fnUntraced(function* (cause) {
            if (cause instanceof NativeChildScopeError) return yield* failEnvironmentNotFound("thread_not_found");
            return yield* failEnvironmentInternal("orchestration_thread_snapshot_failed", cause);
          })),
        );
      }))
      .handle("nativeChildConversation", Effect.fn("environment.orchestration.nativeChildConversation")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* readNativeChildConversation({ environmentId: yield* environment.getEnvironmentId,
          projection: projectionSnapshotQuery, directory, registry }, { ...args.payload, threadId: args.params.threadId }, args.params.childId).pipe(
          Effect.catch(Effect.fnUntraced(function* (cause) {
            if (cause instanceof NativeChildScopeError) return yield* failEnvironmentNotFound("thread_not_found");
            return yield* failEnvironmentInternal("orchestration_thread_snapshot_failed", cause);
          })),
        );
      }))
      .handle(
        "providerModels",
        Effect.fn("environment.orchestration.providerModels")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const providers = yield* providerRegistry.refreshInstance(ProviderInstanceId.make(args.query.instanceId ?? "codex"));
          return { providers: providers.map((provider) => ({
            instanceId: provider.instanceId,
            driver: provider.driver,
            enabled: provider.enabled,
            installed: provider.installed,
            status: provider.status,
            authStatus: provider.auth.status,
            checkedAt: provider.checkedAt,
            models: provider.models.map((model) => ({ slug: model.slug, name: model.name, capabilities: model.capabilities })),
          })) };
        }),
      )
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "commandReceipt",
        Effect.fn("environment.orchestration.commandReceipt")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const stored = yield* commandReceipts.getByCommandId({ commandId: args.params.commandId }).pipe(
            Effect.catch((cause) => failEnvironmentInternal("orchestration_command_receipt_failed", cause)),
          );
          if (Option.isNone(stored)) return null;
          const { commandId, aggregateKind, aggregateId, acceptedAt, resultSequence, status } = stored.value;
          return { commandId, aggregateKind, aggregateId, acceptedAt, resultSequence, status };
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(
            snapshot.value,
            args.payload.reasoningMessages === "true",
          );
        }),
      )
      .handle(
        "threadEventPage",
        Effect.fn("environment.orchestration.threadEventPage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const threadId = args.params.threadId;
          const afterSequence = args.payload.afterSequence;
          const limit = args.payload.limit;
          const existing = yield* projectionSnapshotQuery.getThreadDetailSnapshot(threadId, { turnLimit: 1 }).pipe(
            Effect.catch((cause) => failEnvironmentInternal("orchestration_thread_snapshot_failed", cause)),
          );
          if (Option.isNone(existing)) return yield* failEnvironmentNotFound("thread_not_found");
          const headSequence = yield* orchestrationEngine.latestSequence;
          const reset = (reason: "cursor_ahead" | "gap_too_large" | "payload_too_large") => ({
            threadId, afterSequence, headSequence, nextSequence: headSequence,
            hasMore: false, resetRequired: true, resetReason: reason, events: [],
          });
          if (afterSequence > headSequence) return reset("cursor_ahead");
          if (headSequence - afterSequence > 1_000) return reset("gap_too_large");
          const range = { threadId, fromSequenceExclusive: afterSequence, toSequenceInclusive: headSequence };
          const stats = yield* orchestrationEngine.getThreadReplayStats({ ...range, maxEvents: limit + 1 }).pipe(
            Effect.catch((cause) => failEnvironmentInternal("orchestration_snapshot_failed", cause)),
          );
          if (stats.payloadBytes > 8 * 1024 * 1024) return reset("payload_too_large");
          const chunk = yield* orchestrationEngine.readThreadEvents({ ...range, limit }).pipe(
            Stream.runCollect,
            Effect.catch((cause) => failEnvironmentInternal("orchestration_snapshot_failed", cause)),
          );
          const events = chunk.map((event) => {
            const payload = event.payload as { turnId?: unknown };
            const activity = event.type === "thread.activity-appended" ? event.payload.activity : null;
            const session = event.type === "thread.session-set" ? event.payload.session : null;
            const turnId = activity?.turnId ?? (typeof payload.turnId === "string" ? payload.turnId : null) ?? session?.activeTurnId;
            return {
              eventId: event.eventId, sequence: event.sequence, occurredAt: event.occurredAt, type: event.type,
              ...(turnId ? { turnId } : {}),
              ...(activity ? { activityId: activity.id, activityKind: activity.kind, activityTone: activity.tone } : {}),
              ...(session ? { sessionStatus: session.status } : {}),
            };
          });
          const hasMore = stats.eventCount > limit;
          return { threadId, afterSequence, headSequence,
            nextSequence: hasMore ? events[events.length - 1]!.sequence : headSequence,
            hasMore, resetRequired: false, events };
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* ProjectCloneTracker.rejectCommandsDuringClone(
            projectCloneTracker,
            args.payload,
          ).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          const result = yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
            Effect.tapError(() =>
              cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          yield* ProjectCloneTracker.discardCloneForDeletedProject(
            projectCloneTracker,
            normalizedCommand,
          );
          return result;
        }),
      );
  }),
).pipe(Layer.provide(ProviderAdapterRegistryLive), Layer.provide(OrchestrationCommandReceiptRepositoryLive));
