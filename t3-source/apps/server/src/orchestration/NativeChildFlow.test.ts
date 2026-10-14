import { describe, it, expect } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { foldNativeChildActivities, verifyNativeRelationships, readNativeChildConversation, readNativeChildRelations, type NativeChildFlowDependencies } from "./NativeChildFlow.ts";
const A = "11111111-1111-7111-8111-111111111111", B = "22222222-2222-7222-8222-222222222222";
const at = "2026-10-01T07:00:00.000Z";
const activity = (id: string, kind = "task.started", payload: any = {}) => ({ id: "activity-" + id + kind, kind, turnId: "native-parent-turn", createdAt: at, tone: "info", summary: "", payload: { taskId: id, timelineBypass: true, agentPath: "/root/a", title: "a", ...payload } }) as any;
const input = { threadId: ThreadId.make("T3-parent"), environmentId: "env", projectId: "project", instanceId: "codex" };
function harness(changes: { projectId?: string; provider?: string; bindingInstance?: string; activities?: any[]; parent?: string; activeAdapterSession?: boolean } = {}) {
  const reads: any[] = [];
  const deps = {
    environmentId: "env",
    projection: { getThreadDetailById: () => Effect.succeed(Option.some({ projectId: changes.projectId ?? "project", activities: changes.activities ?? [activity(A), activity(A, "task.progress", { status: "idle", model: "gpt-6-astra", effort: "low" })] })) },
    directory: { getBinding: () => Effect.succeed(Option.some({ provider: changes.provider ?? "codex", providerInstanceId: changes.bindingInstance ?? "codex", resumeCursor: { threadId: "native-parent" }, runtimePayload: { cwd: "/public-fixture" } })) },
    registry: { getInstanceInfo: () => Effect.succeed({ driverKind: "codex", enabled: true }), getByInstance: () => Effect.succeed({ provider: "codex", hasSession: () => Effect.succeed(changes.activeAdapterSession ?? false), readNativeThread: (request: any) => Effect.sync(() => {
      reads.push(request); return { id: request.threadId, parentThreadId: changes.parent ?? "native-parent", status: { type: "notLoaded" }, turns: request.includeTurns ? [{ id: "original-child-turn", status: "completed", items: [{ id: "original-item", type: "agentMessage", text: "whole original child answer" }] }] : [] };
    }) }) },
  } as unknown as NativeChildFlowDependencies;
  return { deps, reads };
}
describe("durable parent scoped native child flow", () => {
  it("deduplicates stable task IDs without title or path attribution", () => {
    const nodes = foldNativeChildActivities([activity(A), activity(A, "task.updated"), activity(B, "task.updated"), activity("not-a-native-id")]);
    expect(nodes).toHaveLength(1); expect(nodes[0]?.relationship).toBe("unknown");
    expect(nodes[0]?.parentNativeThreadId).toBe(null); expect(nodes[0]?.spawnTurnId).toBe("native-parent-turn");
  });
  it("verifies multiple layers from explicit native parents; unknown/cycles never get guessed edges", () => {
    const nodes = foldNativeChildActivities([activity(A), activity(B)]);
    const verified = verifyNativeRelationships(nodes, new Map([[A, { id: A, parentThreadId: "native-parent" }], [B, { id: B, parentThreadId: A }]]), "native-parent");
    expect(verified.map(n => n.relationship)).toEqual(["verified", "verified"]);
    expect(verified[1]?.parentNativeThreadId).toBe(A);
    const unknown = verifyNativeRelationships(nodes, new Map([[A, { id: A, parentThreadId: B }], [B, { id: B, parentThreadId: A }]]), "native-parent");
    expect(unknown.map(n => n.relationship)).toEqual(["unknown", "unknown"]);
  });
  it.each([{ environmentId: "other" }, { projectId: "other" }, { instanceId: "dsh" }])("scope mismatch never reaches native history %j", async patch => {
    const { deps, reads } = harness();
    await expect(Effect.runPromise(readNativeChildConversation(deps, { ...input, ...patch }, A))).rejects.toThrow("identity mismatch");
    expect(reads).toEqual([]);
  });
  it("a forged child ID is rejected before any original child read", async () => {
    const { deps, reads } = harness();
    await expect(Effect.runPromise(readNativeChildConversation(deps, input, B))).rejects.toThrow("durable task records"); expect(reads).toEqual([]);
  });
  it("DSH parents cannot use the Codex reader", async () => {
    const { deps, reads } = harness({ provider: "dsh" });
    await expect(Effect.runPromise(readNativeChildRelations(deps, input))).rejects.toThrow("provider identity mismatch"); expect(reads).toEqual([]);
  });
  it("reads complete original child after restart with no adapter session, without resuming", async () => {
    const { deps, reads } = harness({ activeAdapterSession: false });
    const result: any = await Effect.runPromise(readNativeChildConversation(deps, input, A));
    expect(result.complete).toBe(true); expect(result.child.sessionStatus).toBe("idle");
    expect(result.child.nativeReadStatus).toBe("notLoaded"); expect(result.child.lastTurnStatus).toBe("completed");
    expect(result.nativeThread.turns[0].items[0].id).toBe("original-item");
    expect(result.scope.nativeParentThreadId).toBe("native-parent");
    expect(reads.map(r => r.includeTurns)).toEqual([false, true]);
  });
  it("an outside native parent leaves relationship unknown and full history closed", async () => {
    const { deps, reads } = harness({ parent: "unrelated-private-thread" });
    const result = await Effect.runPromise(readNativeChildRelations(deps, input)); expect(result.children[0]?.relationship).toBe("unknown");
    reads.length = 0;
    await expect(Effect.runPromise(readNativeChildConversation(deps, input, A))).rejects.toThrow("not verified"); expect(reads.every(r => !r.includeTurns)).toBe(true);
  });
});
