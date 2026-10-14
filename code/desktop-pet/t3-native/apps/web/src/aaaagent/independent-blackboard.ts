import type { IndependentBlackboardSnapshot, BlackboardScope } from "@t3tools/contracts";
import type { FlowNode, FlowEdge } from "./FlowCanvas";
import { nodeKey } from "./flow-layout";

export type OriginalBoardThread = {
  environmentId: string; projectId: string; threadId: string; providerInstanceId: string;
};
export const boardScopeKey = (scope: BlackboardScope) => JSON.stringify([scope.environmentId, scope.projectId]);
export const boardEndpoint = (scope: BlackboardScope) =>
  `/api/orchestration/projects/${encodeURIComponent(scope.projectId)}/independent-blackboard?${new URLSearchParams({ environmentId: scope.environmentId })}`;
const present = (value: unknown) => typeof value === "string" && value.length > 0;
const revision = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
function assert(condition: unknown): asserts condition { if (!condition) throw Error("独立协作记录的来源或版本不一致。"); }

/** Validate the public record chain before any independent relationship is drawn. */
export function validateBoard(snapshot: IndependentBlackboardSnapshot, scope: BlackboardScope,
  originalThreads?: readonly OriginalBoardThread[]) {
  assert(snapshot && snapshot.apiVersion === "0.1.0" && snapshot.source === "aaaagent-independent-blackboard" &&
    snapshot.scope && boardScopeKey(snapshot.scope) === boardScopeKey(scope) && present(snapshot.boardId) &&
    revision(snapshot.revision) && date(snapshot.updatedAt) && Array.isArray(snapshot.participants) &&
    Array.isArray(snapshot.tasks) && Array.isArray(snapshot.events) && Array.isArray(snapshot.relations));
  assert(snapshot.participants.length >= 2 && snapshot.participants.length <= 16);
  const actors = new Map(snapshot.participants.map(actor => {
    assert(present(actor.actorId) && present(actor.threadId) && present(actor.providerInstanceId) && present(actor.title) &&
      (actor.role === "coordinator" || actor.role === "executor") && actor.identitySource === "t3-original-thread-snapshot" &&
      (actor.nativeThreadId === undefined || actor.nativeThreadId === null || present(actor.nativeThreadId)));
    if (originalThreads) assert(originalThreads.some(thread => thread.environmentId === scope.environmentId &&
      thread.projectId === scope.projectId && thread.threadId === actor.threadId && thread.providerInstanceId === actor.providerInstanceId));
    return [actor.actorId, actor] as const;
  }));
  assert(actors.size === snapshot.participants.length && new Set(snapshot.participants.map(actor => actor.threadId)).size === actors.size);
  const coordinators = snapshot.participants.filter(actor => actor.role === "coordinator");
  assert(coordinators.length === 1);
  const coordinator = coordinators[0]!;
  const tasks = new Map(snapshot.tasks.map(task => {
    assert(present(task.taskId) && present(task.title) && present(task.instructions) && actors.get(task.ownerActorId)?.role === "executor" &&
      ["assigned", "running", "reported"].includes(task.status) && revision(task.assignedRevision) && task.assignedRevision > 0 &&
      task.assignedRevision <= snapshot.revision);
    return [task.taskId, task] as const;
  }));
  assert(tasks.size === snapshot.tasks.length);
  let previousRevision = 0;
  const operations = new Set<string>();
  const events = new Map(snapshot.events.map(event => {
    assert(present(event.eventId) && present(event.operationId) && !operations.has(event.operationId) &&
      ["read", "assign", "start", "report", "summary"].includes(event.kind) && revision(event.revision) &&
      event.revision > previousRevision && event.revision <= snapshot.revision && date(event.observedAt) &&
      actors.get(event.actorId)?.threadId === event.threadId && Array.isArray(event.taskIds) &&
      new Set(event.taskIds).size === event.taskIds.length && event.taskIds.every((id: string) => tasks.has(id)));
    previousRevision = event.revision; operations.add(event.operationId);
    return [event.eventId, event] as const;
  }));
  assert(events.size === snapshot.events.length && previousRevision === snapshot.revision);
  const expected = new Map<string, { source: string; target: string; taskId: string; eventId: string; revision: number; kind: string }>();
  for (const event of events.values()) {
    if (event.kind === "assign") {
      assert(event.actorId === coordinator.actorId && event.taskIds.length > 0);
      for (const id of event.taskIds) {
        const task = tasks.get(id)!;
        assert(task.assignedRevision === event.revision);
        expected.set(`${event.eventId}:${id}`, { source: coordinator.threadId, target: actors.get(task.ownerActorId)!.threadId,
          taskId: id, eventId: event.eventId, revision: event.revision, kind: "assignment" });
      }
    } else if (event.kind === "report") {
      assert(event.taskIds.length === 1);
      const task = tasks.get(event.taskIds[0]!)!;
      assert(task.ownerActorId === event.actorId && task.status === "reported" && task.report?.eventId === event.eventId &&
        task.report.revision === event.revision && task.report.actorId === event.actorId && present(task.report.text));
      const read = events.get(task.report.assignmentReadEventId);
      assert(read?.kind === "read" && read.actorId === event.actorId &&
        read.revision >= task.assignedRevision && read.revision < event.revision);
      assert([...events.values()].some(start => start.kind === "start" && start.actorId === event.actorId &&
        start.taskIds.includes(task.taskId) && start.revision > task.assignedRevision && start.revision < event.revision));
      expected.set(event.eventId, { source: event.threadId, target: coordinator.threadId, taskId: task.taskId,
        eventId: event.eventId, revision: event.revision, kind: "report" });
    } else if (event.kind === "start") {
      assert(event.taskIds.length === 1 && tasks.get(event.taskIds[0]!)?.ownerActorId === event.actorId);
    }
  }
  for (const task of tasks.values()) {
    assert([...expected.values()].some(edge => edge.kind === "assignment" && edge.taskId === task.taskId));
    assert(task.status === "reported" ? task.report !== null && events.get(task.report.eventId)?.kind === "report" : task.report === null);
  }
  assert(snapshot.relations.length === expected.size && new Set(snapshot.relations.map(edge => edge.relationId)).size === expected.size);
  for (const edge of snapshot.relations) {
    const source = expected.get(edge.relationId);
    assert(source && edge.kind === source.kind && edge.sourceThreadId === source.source && edge.targetThreadId === source.target &&
      edge.taskId === source.taskId && edge.eventId === source.eventId && edge.recordRevision === source.revision);
  }
  if (snapshot.summary) {
    const summary = snapshot.summary, event = events.get(summary.eventId);
    const reports = snapshot.tasks.map(task => task.report?.eventId);
    assert(present(summary.text) && summary.actorId === coordinator.actorId && event?.kind === "summary" &&
      event.actorId === coordinator.actorId && event.revision === summary.revision && snapshot.tasks.length > 0 &&
      snapshot.tasks.every(task => task.status === "reported") && Array.isArray(summary.reportEventIds) &&
      summary.reportEventIds.length === reports.length && new Set(summary.reportEventIds).size === reports.length &&
      reports.every(id => id !== undefined && summary.reportEventIds.includes(id)) &&
      [...events.values()].some(read => read.kind === "read" && read.actorId === coordinator.actorId &&
        read.revision > Math.max(...snapshot.tasks.map(task => task.report!.revision)) && read.revision < summary.revision));
  }
  assert(snapshot.status === (snapshot.summary ? "summarized" : "in_progress"));
  return snapshot;
}

export const boardTaskLabel = (status: "assigned" | "running" | "reported") =>
  status === "assigned" ? "已分配" : status === "running" ? "执行中" : "已回报";

/** Annotate existing original T3 nodes; never manufacture nodes or native ancestry. */
export function projectBoardFlow(roots: readonly FlowNode[], snapshot: IndependentBlackboardSnapshot | null,
  scope: BlackboardScope, originalThreads: readonly OriginalBoardThread[]) {
  if (!snapshot) return { nodes: [...roots], edges: [] as FlowEdge[] };
  validateBoard(snapshot, scope, originalThreads);
  const nodes = roots.map(node => {
    if (node.nativeChild || node.environmentId !== scope.environmentId) return node;
    const actor = snapshot.participants.find(participant => participant.threadId === node.threadId);
    if (!actor) return node;
    const tasks = snapshot.tasks.filter(task => task.ownerActorId === actor.actorId);
    const role = actor.role === "coordinator" ? "协调 Agent" : "执行 Agent";
    const progress = actor.role === "coordinator" ? (snapshot.summary ? "协调汇总已发布" : "等待分工回报与协调汇总") :
      tasks.length ? tasks.map(task => `${task.title}：${boardTaskLabel(task.status)}`).join(" · ") : "尚未收到分工";
    return { ...node, role, progress: `${progress} · 黑板版本 ${snapshot.revision}` };
  });
  const keys = new Set(nodes.filter(node => !node.nativeChild).map(node => node.key));
  const edges = snapshot.relations.map(edge => ({ key: JSON.stringify(["blackboard", snapshot.boardId, edge.relationId]),
    source: nodeKey(scope.environmentId, edge.sourceThreadId), target: nodeKey(scope.environmentId, edge.targetThreadId),
    label: `${edge.kind === "assignment" ? "分配" : "回报"} · ${edge.taskId} · v${edge.recordRevision}` }));
  assert(edges.every(edge => keys.has(edge.source) && keys.has(edge.target)));
  return { nodes, edges };
}
