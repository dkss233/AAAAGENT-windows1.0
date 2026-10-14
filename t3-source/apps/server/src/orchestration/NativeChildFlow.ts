import { NativeChildFlowNode, type OrchestrationThreadActivity, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry.ts";

type Child = typeof NativeChildFlowNode.Type;
export class NativeChildScopeError extends Data.TaggedError("NativeChildScopeError")<{ readonly message: string }> {}
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value : null;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable native task IDs only; titles/paths never create ownership edges. */
export function foldNativeChildActivities(activities: ReadonlyArray<OrchestrationThreadActivity>): Child[] {
  const children = new Map<string, Child>();
  for (const a of [...activities].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) {
    const p = record(a.payload); const id = text(p?.taskId);
    if (!p || !id || !uuid.test(id) || p.timelineBypass !== true || !a.kind.startsWith("task.")) continue;
    const previous = children.get(id);
    if (!previous && a.kind !== "task.started") continue;
    const node: Child = previous ?? {
      nativeThreadId: id, parentNativeThreadId: null, relationship: "unknown",
      spawnTurnId: text(a.turnId), activityId: a.id, agentPath: null, title: id,
      model: null, effort: null, sessionStatus: null, nativeReadStatus: null,
      lastTurnStatus: null, createdAt: a.createdAt, updatedAt: a.createdAt,
    };
    children.set(id, {
      ...node, title: text(p.title) ?? text(p.description) ?? node.title,
      agentPath: text(p.agentPath) ?? node.agentPath,
      model: text(p.model) ?? node.model, effort: text(p.effort) ?? node.effort,
      sessionStatus: text(p.status) ?? node.sessionStatus, updatedAt: a.createdAt,
      parentNativeThreadId: text(p.parentAgentId) ?? node.parentNativeThreadId,
    });
  }
  return [...children.values()];
}

export function readNativeParentId(native: unknown): string | null {
  const t = record(native); const source = record(t?.source);
  const sub = record(source?.subAgent); const spawn = record(sub?.thread_spawn);
  const fromSource = text(spawn?.parent_thread_id), fromThread = text(t?.parentThreadId);
  if (fromSource && fromThread && fromSource !== fromThread) throw new NativeChildScopeError({ message: "Conflicting original native parent identity." });
  return fromSource ?? fromThread;
}

export function verifyNativeRelationships(children: Child[], metadata: ReadonlyMap<string, unknown>, rootId: string): Child[] {
  const nodes = new Map(children.map(child => {
    const meta = record(metadata.get(child.nativeThreadId));
    if (!meta || meta.id !== child.nativeThreadId) throw new NativeChildScopeError({ message: "Original child identity mismatch." });
    const parent = readNativeParentId(meta);
    if (child.parentNativeThreadId && parent && child.parentNativeThreadId !== parent) throw new NativeChildScopeError({ message: "Durable and native parent identity conflict." });
    return [child.nativeThreadId, { ...child, parentNativeThreadId: parent ?? child.parentNativeThreadId,
      nativeReadStatus: text(record(meta.status)?.type) }];
  }));
  const reachesRoot = (id: string): boolean => {
    const visited = new Set<string>(); let current: string | null = id;
    while (current !== rootId) {
      if (current === null || visited.has(current)) return false;
      visited.add(current); current = nodes.get(current)?.parentNativeThreadId ?? null;
    }
    return true;
  };
  return [...nodes.values()].map(child => ({ ...child, relationship: reachesRoot(child.nativeThreadId) ? "verified" : "unknown" }));
}

export interface NativeChildFlowDependencies {
  readonly environmentId: string;
  readonly projection: Pick<ProjectionSnapshotQueryShape, "getThreadDetailById">;
  readonly directory: Pick<ProviderSessionDirectoryShape, "getBinding">;
  readonly registry: Pick<ProviderAdapterRegistryShape, "getByInstance" | "getInstanceInfo">;
}
export interface NativeChildFlowInput {
  readonly threadId: ThreadId;
  readonly environmentId: string;
  readonly projectId: string;
  readonly instanceId: string;
}

const getContext = Effect.fn("nativeChildFlow.getContext")(function* (
  deps: NativeChildFlowDependencies, input: NativeChildFlowInput, requestedChildId?: string,
) {
  const deny = (message: string) => Effect.fail(new NativeChildScopeError({ message: message }));
  if (input.environmentId !== deps.environmentId) return yield* deny("Environment identity mismatch.");
  const thread = yield* deps.projection.getThreadDetailById(input.threadId, { activityKinds: ["task.started", "task.updated", "task.progress", "task.completed", "task.failed"] });
  if (Option.isNone(thread) || thread.value.projectId !== input.projectId) return yield* deny("Parent project/thread identity mismatch.");
  const binding = yield* deps.directory.getBinding(input.threadId);
  if (Option.isNone(binding) || binding.value.provider !== "codex" || binding.value.providerInstanceId !== input.instanceId) return yield* deny("Original parent provider identity mismatch.");
  const nativeParentThreadId = text(record(binding.value.resumeCursor)?.threadId);
  const cwd = text(record(binding.value.runtimePayload)?.cwd);
  if (!nativeParentThreadId || !cwd) return yield* deny("Original native parent/cwd is unavailable.");
  const children = foldNativeChildActivities(thread.value.activities).filter(child => child.nativeThreadId !== nativeParentThreadId);
  if (requestedChildId !== undefined && !children.some(child => child.nativeThreadId === requestedChildId)) return yield* deny("Child is not in the exact parent's durable task records.");
  const instance = ProviderInstanceId.make(input.instanceId);
  const info = yield* deps.registry.getInstanceInfo(instance);
  if (info.driverKind !== "codex" || !info.enabled) return yield* deny("Original Codex provider instance is unavailable.");
  const adapter = yield* deps.registry.getByInstance(instance);
  if (adapter.provider !== "codex" || !adapter.readNativeThread) return yield* deny("Original provider does not expose native readonly history.");
  const metadata = new Map<string, unknown>();
  for (const child of children) metadata.set(child.nativeThreadId, yield* adapter.readNativeThread({ threadId: child.nativeThreadId, cwd, includeTurns: false }));
  const verified = yield* Effect.try({ try: () => verifyNativeRelationships(children, metadata, nativeParentThreadId), catch: cause => cause instanceof NativeChildScopeError ? cause : new NativeChildScopeError({ message: "Invalid native relationship." }) });
  return { scope: { environmentId: deps.environmentId, projectId: thread.value.projectId,
    parentThreadId: input.threadId, providerInstanceId: input.instanceId, nativeParentThreadId },
    children: verified, readNativeThread: adapter.readNativeThread, cwd };
});

export const readNativeChildRelations = Effect.fn("readNativeChildRelations")(function* (deps: NativeChildFlowDependencies, input: NativeChildFlowInput) {
  const context = yield* getContext(deps, input);
  return { apiVersion: "0.1.0" as const, scope: context.scope, children: context.children };
});

export const readNativeChildConversation = Effect.fn("readNativeChildConversation")(function* (deps: NativeChildFlowDependencies, input: NativeChildFlowInput, childId: string) {
  const context = yield* getContext(deps, input, childId);
  const child = context.children.find(child => child.nativeThreadId === childId)!;
  if (child.relationship !== "verified") return yield* Effect.fail(new NativeChildScopeError({ message: "Native ownership chain is not verified." }));
  const native = yield* context.readNativeThread({ threadId: childId, cwd: context.cwd, includeTurns: true });
  const full = record(native);
  const parentId = yield* Effect.try({ try: () => readNativeParentId(full), catch: () => new NativeChildScopeError({ message: "Invalid original parent identity." }) });
  if (!full || full.id !== childId || parentId !== child.parentNativeThreadId || !Array.isArray(full.turns)) return yield* Effect.fail(new NativeChildScopeError({ message: "Full native history scope changed." }));
  const lastTurn = record(full.turns.at(-1));
  return { apiVersion: "0.1.0" as const, scope: context.scope, child: { ...child, lastTurnStatus: text(lastTurn?.status) },
    complete: true as const, source: "codex-native-thread-read" as const, nativeThread: native };
});
