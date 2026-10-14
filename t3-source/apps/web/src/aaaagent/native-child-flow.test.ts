import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { FlowNode } from "./FlowCanvas";
import { nodeKey } from "./flow-layout";
import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ThreadId, type NativeChildFlowConversation, type NativeChildFlowNode, type NativeChildFlowRelations } from "@t3tools/contracts";
import { nativeChildEndpoint, nativeChildKey, nativeChildSessionLabel, nativeChildTurnLabel,
  projectChildFlowNodes, projectNativeChildConversation, runIsolatedNativeChildRead, sameNativeChildScope, verifiedNativeChildren } from "./native-child-flow";

const scope = { environmentId: "env", projectId: ProjectId.make("project"),
  parentThreadId: ThreadId.make("parent"), providerInstanceId: "codex", nativeParentThreadId: "native-parent" };
const child = (id = "child", parent = "native-parent"): NativeChildFlowNode => ({ nativeThreadId: id,
  parentNativeThreadId: parent, relationship: "verified", spawnTurnId: "spawn-turn", activityId: "activity",
  agentPath: "/root/a", title: "a", model: "gpt-6-astra", effort: "low", sessionStatus: "idle",
  nativeReadStatus: "notLoaded", lastTurnStatus: null, createdAt: "2026-10-01T07:07:05.398Z", updatedAt: "2026-10-01T07:07:20.161Z" });
const relations = (children: NativeChildFlowNode[]): NativeChildFlowRelations => ({ apiVersion: "0.1.0", scope, children });
const conversation = (items: unknown[]): NativeChildFlowConversation => ({ apiVersion: "0.1.0", scope,
  child: child(), complete: true, source: "codex-native-thread-read",
  nativeThread: { id: "child", parentThreadId: "native-parent", status: { type: "notLoaded" },
    turns: [{ id: "original-turn", status: "completed", items }] } });

describe("native child identity and verified relation projection", () => {
  it("keeps same child UUID separate for environment/project/parent/provider and encodes all GET parameters", () => {
    const key = nativeChildKey(scope, "same");
    for (const change of [{ environmentId: "other" }, { projectId: ProjectId.make("other") },
      { parentThreadId: ThreadId.make("other") }, { providerInstanceId: "other" }]) {
      expect(nativeChildKey({ ...scope, ...change }, "same")).not.toBe(key);
      expect(sameNativeChildScope(scope, { ...scope, ...change })).toBe(false);
    }
    expect(nativeChildEndpoint({ ...scope, parentThreadId: ThreadId.make("p/a") }, "child/?")).toContain("p%2Fa/native-children/child%2F%3F?");
  });
  it("deduplicates persisted updates and verifies explicit known multilevel parents", () => {
    const older = child();
    const rows = verifiedNativeChildren(relations([older, { ...older, title: "latest", updatedAt: "2026-10-01T08:00:00.000Z" }, child("grandchild", "child")]), scope);
    expect(rows.map(row => [row.child.title, row.verified])).toEqual([["latest", true], ["a", true]]);
  });
  it("never verifies unknown, missing-parent or cyclic ancestry", () => {
    expect(verifiedNativeChildren(relations([{ ...child(), relationship: "unknown" }, child("orphan", "missing"),
      child("cycle-a", "cycle-b"), child("cycle-b", "cycle-a")]), scope).every(row => !row.verified)).toBe(true);
  });

  it("builds explicit main/two-child/grandchild edges without changing the original roots", () => {
    const root: FlowNode = { key: nodeKey(scope.environmentId, scope.parentThreadId), environmentId: scope.environmentId,
      threadId: scope.parentThreadId, title: "original parent", provider: "Codex", model: "original model",
      status: "空闲", category: "idle", progress: "original progress", updatedAt: child().updatedAt };
    const before = JSON.stringify(root);
    const a = child("a"), b = child("b"), nested = child("nested", "a"), orphan = child("unknown", "missing");
    const graph = projectChildFlowNodes([root], [relations([a, b, nested, orphan])]);
    expect(JSON.stringify(root)).toBe(before);
    expect(graph.nodes[0]?.role).toBe("主 Agent");
    expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([
      [root.key, nativeChildKey(scope, "a")], [root.key, nativeChildKey(scope, "b")],
      [nativeChildKey(scope, "a"), nativeChildKey(scope, "nested")],
    ]);
    expect(graph.nodes.find(node => node.key === nativeChildKey(scope, "unknown"))).toMatchObject({ openable: false });
    expect(graph.nodes.find(node => node.key === nativeChildKey(scope, "unknown"))?.parentKey).toBeUndefined();
    expect(projectChildFlowNodes([root], [{ ...relations([a]), scope: { ...scope, environmentId: "other" } }]).nodes).toHaveLength(1);
  });
  it("rejects a response for a different scope", () => {
    expect(() => verifiedNativeChildren({ ...relations([child()]), scope: { ...scope, environmentId: "other" } }, scope)).toThrow("来源");
  });
  it("separates reusable idle session from completed turn and never uses read-process notLoaded as stopped", () => {
    expect(nativeChildSessionLabel("idle")).toContain("可继续");
    expect(nativeChildTurnLabel("completed")).toBe("本轮已完成");
    expect(nativeChildTurnLabel(null)).toContain("待核");
    expect(nativeChildSessionLabel("notLoaded")).not.toContain("结束");
  });
});

describe("complete native conversation to original timeline", () => {
  it("preserves original turn/item IDs, command/output and native order without inventing user messages", () => {
    const output = "line\n".repeat(12000) + "EXACT_END";
    const response = conversation([{ id: "native-command", type: "commandExecution", command: "cat task-a.md", aggregatedOutput: output, exitCode: 0, status: "completed" },
      { id: "native-answer", type: "agentMessage", text: "总数9" }]);
    const result = projectNativeChildConversation(response, scope, "child");
    expect(result.entries.map(entry => entry.kind)).toEqual(["work", "message"]);
    const command = result.entries[0];
    expect(command?.kind === "work" && command.entry.command).toBe("cat task-a.md");
    expect(command?.kind === "work" && command.entry.detail).toContain(output);
    expect(result.items.map(item => [item.id, item.turnId])).toEqual([["native-command", "original-turn"], ["native-answer", "original-turn"]]);
    expect(result.hasOriginalUserMessage).toBe(false);
    expect(result.lastTurnStatus).toBe("completed");
    expect(result.thread.status).toEqual({ type: "notLoaded" });
  });
  it("does not turn an unknown original command state into completed", () => {
    const raw = { id: "command", type: "commandExecution", command: "original", status: "future-state" };
    const result = projectNativeChildConversation(conversation([raw]), scope, "child");
    const entry = result.entries[0];
    expect(entry?.kind === "work" && entry.entry.toolLifecycleStatus).toBeUndefined();
    expect(result.items[0]?.original).toBe(raw);
  });
  it("keeps genuine original user text and all untouched raw fields", () => {
    const raw = { id: "user", type: "userMessage", content: [{ type: "text", text: "原提示" }, { type: "image", url: "original-image" }] };
    const result = projectNativeChildConversation(conversation([raw]), scope, "child");
    expect(result.hasOriginalUserMessage).toBe(true);
    expect(result.items[0]?.original).toBe(raw);
    const message = result.entries[0];expect(message?.kind === "message" && message.message.text).toBe("原提示\n");
  });
  it("keeps unknown typed items visibly expandable instead of dropping them", () => {
    const raw = { id: "future", type: "futureType", body: { exact: "完整未知正文" } };
    const result = projectNativeChildConversation(conversation([raw]), scope, "child");
    expect(result.items[0]?.recognized).toBe(false);
    expect(result.items[0]?.original).toBe(raw);
    const entry = result.entries[0];expect(entry?.kind === "work" && entry.entry.detail).toContain("完整未知正文");
  });
  it("rejects wrong child/project/provider, unverifiable relation and incomplete turn data", () => {
    const response = conversation([]);
    expect(() => projectNativeChildConversation(response, scope, "different")).toThrow();
    expect(() => projectNativeChildConversation(response, { ...scope, projectId: ProjectId.make("wrong") }, "child")).toThrow();
    expect(() => projectNativeChildConversation(response, { ...scope, providerInstanceId: "wrong" }, "child")).toThrow();
    expect(() => projectNativeChildConversation(response, { ...scope, nativeParentThreadId: "wrong" }, "child")).toThrow();
    expect(() => projectNativeChildConversation({ ...response, child: { ...child(), relationship: "unknown" } }, scope, "child")).toThrow();
    expect(() => projectNativeChildConversation({ ...response, nativeThread: { id: "child", turns: [{ id: "turn" }] } }, scope, "child")).toThrow("完整");
  });
});


describe("isolated original runtime read results", () => {
  it("bounds an unavailable read and releases its original atom", async () => {
    const registry = AtomRegistry.make(), finished: string[] = [];
    try {
      const read = runIsolatedNativeChildRead(registry, () => Atom.make(Effect.never.pipe(
        Effect.ensuring(Effect.sync(() => { finished.push("released"); })))), { timeoutMs: 25 });
      await expect(read).rejects.toThrow("timed out");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(finished).toEqual(["released"]);
    } finally { registry.dispose(); }
  });
  it("cancels a waiting read and releases it before any later result", async () => {
    const registry = AtomRegistry.make(), controller = new AbortController(), finished: string[] = [];
    try {
      const read = runIsolatedNativeChildRead(registry, () => Atom.make(Effect.never.pipe(
        Effect.ensuring(Effect.sync(() => { finished.push("released"); })))), { signal: controller.signal });
      const rejected = expect(read).rejects.toThrow();
      controller.abort(); await rejected;
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(finished).toEqual(["released"]);
    } finally { registry.dispose(); }
  });
  it("preserves an original request error and releases the failed atom", async () => {
    const registry = AtomRegistry.make(), finished: string[] = [];
    try {
      class OriginalReadUnavailable extends Schema.TaggedError<OriginalReadUnavailable>()("OriginalReadUnavailable", { message: Schema.String }) {}
      await expect(runIsolatedNativeChildRead(registry, () => Atom.make(Effect.fail(new OriginalReadUnavailable({ message: "original unavailable" })).pipe(
        Effect.ensuring(Effect.sync(() => { finished.push("released"); })))))).rejects.toThrow("original unavailable");
      expect(finished).toEqual(["released"]);
    } finally { registry.dispose(); }
  });
  it("keeps interleaved scope results and simultaneous same-scope reads independent", async () => {
    const registry = AtomRegistry.make();
    const pending = new Map<string, (value: string) => void>();
    const read = (id: string) => runIsolatedNativeChildRead(registry,
      () => Atom.make(Effect.promise(() => new Promise<string>(resolve => pending.set(id, resolve)))));
    try {
      const a = read("scope-a"), b = read("scope-b"), sameFirst = read("scope-a-first"), sameSecond = read("scope-a-second");
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(pending.size).toBe(4);
      pending.get("scope-b")!("original b");
      expect(await b).toBe("original b");
      pending.get("scope-a-second")!("newer a");
      expect(await sameSecond).toBe("newer a");
      pending.get("scope-a")!("original a");
      pending.get("scope-a-first")!("older a");
      expect(await a).toBe("original a");
      expect(await sameFirst).toBe("older a");
    } finally { registry.dispose(); }
  });
});
