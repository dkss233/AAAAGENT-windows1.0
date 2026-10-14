import * as Effect from "effect/Effect";
import { AtomRegistry, type Atom, type AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";
import { MessageId, TurnId, type NativeChildFlowConversation, type NativeChildFlowNode,
  type NativeChildFlowRelations, type NativeChildFlowScope } from "@t3tools/contracts";
import { deriveTimelineEntries, type WorkLogEntry } from "../session-logic";
import type { ChatMessage } from "../types";
import type { FlowEdge, FlowNode } from "./FlowCanvas";
import { nodeKey } from "./flow-layout";

export type NativeChildTarget = Pick<NativeChildFlowScope,
  "environmentId" | "projectId" | "parentThreadId" | "providerInstanceId"> & { nativeParentThreadId?: string };
export type NativeChildReader = {
  relations: (target: NativeChildTarget, options?: { signal?: AbortSignal }) => Promise<NativeChildFlowRelations>;
  conversation: (target: NativeChildTarget, childId: string, options?: { signal?: AbortSignal }) => Promise<NativeChildFlowConversation>;
  subscribeConnection?: (targets: readonly NativeChildTarget[], onChange: () => void) => () => void;
};
export const nativeChildKey = (scope: NativeChildTarget, id: string) => JSON.stringify([
  "native-child", scope.environmentId, scope.projectId, scope.parentThreadId, scope.providerInstanceId, id,
]);
export const nativeTargetKey = (scope: NativeChildTarget) => nativeChildKey(scope, "");
export function sameNativeChildScope(expected: NativeChildTarget, actual: NativeChildFlowScope) {
  return expected.environmentId === actual.environmentId && expected.projectId === actual.projectId &&
    expected.parentThreadId === actual.parentThreadId && expected.providerInstanceId === actual.providerInstanceId &&
    (expected.nativeParentThreadId === undefined || expected.nativeParentThreadId === actual.nativeParentThreadId);
}
export function nativeChildEndpoint(target: NativeChildTarget, childId?: string) {
  const query = new URLSearchParams({ environmentId: target.environmentId,
    projectId: target.projectId, instanceId: target.providerInstanceId });
  return `/api/orchestration/threads/${encodeURIComponent(target.parentThreadId)}/native-children${
    childId === undefined ? "" : `/${encodeURIComponent(childId)}`}?${query}`;
}
/** Each GET owns its original runtime result, including concurrent reads of one scope. */
export function runIsolatedNativeChildRead<A, E>(registry: AtomRegistry.AtomRegistry,
  create: () => Atom.Atom<AsyncResult.AsyncResult<A, E>>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<A> {
  const atom = create(), release = registry.mount(atom);
  return Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true })
    .pipe(Effect.timeout(options.timeoutMs ?? 45_000)), { signal: options.signal }).finally(release);
}
export function useNativeChildRelations(targets: readonly NativeChildTarget[], reader: NativeChildReader) {
  const key = JSON.stringify(targets.map(nativeTargetKey)), [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{ key: string; records: NativeChildFlowRelations[]; errors: number } | null>(null);
  useEffect(() => {
    let active = true, pending = true;
    const controller = new AbortController();
    const unsubscribe = reader.subscribeConnection?.(targets, () => {
      // Pending reads already follow the original atom. Refresh settled records on reconnect.
      if (active && !pending) setRefresh(value => value + 1);
    });
    setState(null);
    void Promise.allSettled(targets.map(target => reader.relations(target, { signal: controller.signal }).then(response => {
      verifiedNativeChildren(response, target); return response;
    }))).then(results => {
      if (!active) return;
      pending = false;
      setState({ key, records: results.flatMap(result => result.status === "fulfilled" ? [result.value] : []),
        errors: results.filter(result => result.status === "rejected").length });
    });
    return () => { active = false; controller.abort(); unsubscribe?.(); };
  }, [key, reader, refresh]);
  const current = state?.key === key ? state : null;
  return { records: current?.records ?? [], errors: current?.errors ?? 0, loading: current === null && targets.length > 0,
    refresh: () => setRefresh(value => value + 1) };
}
export function verifiedNativeChildren(relations: NativeChildFlowRelations, target: NativeChildTarget) {
  if (!sameNativeChildScope(target, relations.scope)) throw new Error("子任务来源与当前项目或父会话不一致。");
  const children = new Map<string, NativeChildFlowNode>();
  for (const child of relations.children) {
    const prior = children.get(child.nativeThreadId);
    if (!prior || child.updatedAt > prior.updatedAt) children.set(child.nativeThreadId, child);
  }
  const verified = (id: string, path = new Set<string>()): boolean => {
    if (id === relations.scope.nativeParentThreadId) return true;
    if (path.has(id)) return false;
    const child = children.get(id);
    if (!child || child.relationship !== "verified" || !child.parentNativeThreadId) return false;
    return verified(child.parentNativeThreadId, new Set([...path, id]));
  };
  return [...children.values()].map(child => ({ child, verified: verified(child.nativeThreadId) }));
}
export function nativeChildSessionLabel(status: string | null) {
  if (status === "idle") return "空闲 · 可继续";
  if (status === "running" || status === "waiting" || status === "pending") return "进行中";
  if (status === "failed" || status === "error") return "异常";
  if (status === "completed") return "活动已完成";
  if (status === "interrupted" || status === "cancelled") return "活动已中止";
  return status ? `原会话：${status}` : "会话状态待核";
}
export function nativeChildTurnLabel(status: string | null) {
  return status === "completed" ? "本轮已完成" : status === "inProgress" ? "本轮进行中" :
    status === "failed" ? "本轮失败" : status === "interrupted" ? "本轮已中止" : "本轮状态待核";
}
export function projectChildFlowNodes(roots: readonly FlowNode[], records: readonly NativeChildFlowRelations[]) {
  const nodes = roots.map(node => ({ ...node })), edges: FlowEdge[] = [];
  for (const relations of records) {
    const parentKey = nodeKey(relations.scope.environmentId, relations.scope.parentThreadId);
    const parent = nodes.find(node => node.key === parentKey && !node.nativeChild);
    if (!parent) continue;
    const children = verifiedNativeChildren(relations, relations.scope), siblings = new Map<string, number>();
    if (children.length) parent.role = "主 Agent";
    for (const { child, verified } of children) {
      const key = nativeChildKey(relations.scope, child.nativeThreadId);
      const source = child.parentNativeThreadId === relations.scope.nativeParentThreadId ? parentKey :
        child.parentNativeThreadId ? nativeChildKey(relations.scope, child.parentNativeThreadId) : null;
      const siblingIndex = source ? siblings.get(source) ?? 0 : 0;
      if (source) siblings.set(source, siblingIndex + 1);
      const status = nativeChildSessionLabel(child.sessionStatus);
      nodes.push({ key, environmentId: relations.scope.environmentId, threadId: child.nativeThreadId,
        title: child.title || child.agentPath || "子 Agent", provider: parent.provider, role: "子 Agent",
        model: child.model ? `${child.model}${child.effort ? ` · ${child.effort}` : ""}` : "模型待核", status,
        category: child.sessionStatus === "running" || child.sessionStatus === "waiting" ? "working" :
          child.sessionStatus === "failed" || child.sessionStatus === "error" ? "attention" : "idle",
        updatedAt: child.updatedAt, progress: verified ? `${child.agentPath ?? "原子会话"} · ${nativeChildTurnLabel(child.lastTurnStatus)}` : "父子来源待核，保持独立",
        openable: verified, ...(verified && source ? { parentKey: source, siblingIndex } : {}),
        nativeChild: { target: relations.scope, child, verified } });
      if (verified && source) edges.push({ key: JSON.stringify([source, key]), source, target: key, label: "分配子任务" });
    }
  }
  return { nodes, edges };
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown) => typeof value === "string" ? value : "";
const textParts = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.map(part => typeof part === "string" ? part : string(record(part)?.text)).join("\n") : "";
const originalTime = (value: unknown, fallback: string) => typeof value === "string" && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : typeof value === "number" && Number.isFinite(value)
    ? new Date(value < 1e12 ? value * 1000 : value).toISOString() : fallback;

/** Display projection only. Original native turn/item JSON remains independently expandable. */
export function projectNativeChildConversation(response: NativeChildFlowConversation, target: NativeChildTarget, childId: string) {
  if (!sameNativeChildScope(target, response.scope) || response.child.nativeThreadId !== childId ||
    response.child.relationship !== "verified" || !response.complete) throw new Error("完整子对话来源未核实。");
  const thread = record(response.nativeThread);
  if (!thread || thread.id !== childId || !Array.isArray(thread.turns)) throw new Error("原生完整历史格式或身份不一致。");
  const messages: ChatMessage[] = [], workEntries: WorkLogEntry[] = [];
  const items: { key: string; turnId: string; id: string; type: string; original: unknown; recognized: boolean }[] = [];
  const order = new Map<string, number>();
  for (const [turnIndex, rawTurn] of thread.turns.entries()) {
    const turn = record(rawTurn), nativeTurnId = string(turn?.id);
    if (!turn || !nativeTurnId || !Array.isArray(turn.items)) throw new Error("原生轮次缺少完整项目，不能标记全文。");
    for (const [itemIndex, rawItem] of turn.items.entries()) {
      const item = record(rawItem), nativeItemId = string(item?.id), type = string(item?.type);
      const key = JSON.stringify([childId, nativeTurnId, nativeItemId, turnIndex, itemIndex]);
      const id = nativeItemId || key;
      const time = originalTime(item?.createdAt ?? turn.createdAt, response.child.createdAt);
      const turnId = TurnId.make(nativeTurnId);
      const role = type === "userMessage" ? "user" : type === "agentMessage" ? "assistant" : type === "reasoning" ? "reasoning" : null;
      const text = type === "userMessage" ? textParts(item?.content) : type === "reasoning"
        ? [textParts(item?.summary), textParts(item?.content)].filter(Boolean).join("\n\n") : string(item?.text);
      let recognized = false;
      if (role && text) {
        messages.push({ id: MessageId.make(id), role, text, turnId, streaming: false, createdAt: time, updatedAt: time });
        recognized = true;
      } else {
        const command = string(item?.command), output = string(item?.aggregatedOutput ?? item?.output);
        const commandItem = type === "commandExecution";
        workEntries.push({ id, turnId, createdAt: time, ...(nativeItemId ? { toolCallId: nativeItemId } : {}),
          label: commandItem ? "原生命令" : `原生项目 · ${type || "未知类型"}`,
          tone: commandItem ? "tool" : "info", ...(commandItem ? { command, rawCommand: command } : {}), detail: commandItem
            ? [output, item?.exitCode !== undefined ? `退出状态：${String(item.exitCode)}` : ""].filter(Boolean).join("\n")
            : JSON.stringify(rawItem, null, 2), toolData: rawItem,
          ...(commandItem ? { itemType: "command_execution" as const, toolTitle: "原生命令",
            ...(item?.status === "failed" ? { toolLifecycleStatus: "failed" as const } : item?.status === "inProgress"
              ? { toolLifecycleStatus: "inProgress" as const } : item?.status === "completed" ? { toolLifecycleStatus: "completed" as const } : {}) } : {}),
        });
        recognized = commandItem;
      }
      order.set(id, items.length);
      items.push({ key, turnId: nativeTurnId, id: nativeItemId, type, original: rawItem, recognized });
    }
  }
  const entries = deriveTimelineEntries(messages, [], workEntries).toSorted((a, b) => {
    const id = (entry: typeof a) => entry.kind === "message" ? entry.message.id : entry.kind === "work" ? entry.entry.id : entry.id;
    return (order.get(id(a)) ?? 0) - (order.get(id(b)) ?? 0);
  });
  return { entries, items, thread, turnCount: thread.turns.length,
    hasOriginalUserMessage: items.some(item => item.type === "userMessage"),
    lastTurnStatus: string(record(thread.turns.at(-1))?.status) || null };
}
