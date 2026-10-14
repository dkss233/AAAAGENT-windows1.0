import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { BlackboardScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "../threadRoutes";
import { useServerConfigs, useThreadShells } from "../state/entities";
import { boardScopeKey, boardTaskLabel, validateBoard, type OriginalBoardThread } from "./independent-blackboard";
import { emptyBoardState, observeBoard, type BlackboardReader, type BoardReadState } from "./blackboard-poll";
import { useBlackboardReader } from "./BlackboardReader";

export function useIndependentBlackboard(scope: BlackboardScope | null, reader: BlackboardReader, visible = true) {
  const key = scope ? boardScopeKey(scope) : "";
  const [result, setResult] = useState<{ key: string; reader: BlackboardReader; state: BoardReadState } | null>(null);
  const observation = useRef<ReturnType<typeof observeBoard> | null>(null);
  useEffect(() => {
    if (!scope || !visible) return;
    const observer = observeBoard(scope, reader, state => setResult({ key, reader, state }));
    observation.current = observer;
    const visibility = () => observer.visible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibility); visibility();
    return () => {
      observation.current = null; document.removeEventListener("visibilitychange", visibility); observer.dispose();
    };
  }, [key, reader, visible]);
  const state = visible && observation.current !== null && result?.key === key && result.reader === reader ? result.state : emptyBoardState();
  return { ...state, refresh: () => observation.current?.refresh() };
}

export function useOriginalBoardThreads(scope: BlackboardScope | null): OriginalBoardThread[] {
  const threads = useThreadShells(), configs = useServerConfigs();
  return useMemo(() => scope ? threads.filter(thread => thread.environmentId === scope.environmentId &&
    thread.projectId === scope.projectId && !thread.archivedAt && configs.get(thread.environmentId)?.providers.some(provider =>
      provider.instanceId === thread.modelSelection.instanceId && provider.driver === "codex"))
    .map(thread => ({ environmentId: thread.environmentId, projectId: thread.projectId, threadId: thread.id,
      providerInstanceId: thread.modelSelection.instanceId })) : [], [scope?.environmentId, scope?.projectId, threads, configs]);
}

export function checkedBoardState(state: BoardReadState, scope: BlackboardScope, threads: readonly OriginalBoardThread[]): BoardReadState {
  if (!state.snapshot) return state;
  try { validateBoard(state.snapshot, scope, threads); return state; }
  catch { return { ...state, fresh: false, loading: false, phase: "unavailable" }; }
}

export function IndependentBlackboardPanel({ scope, state, refresh, onOpen }: {
  scope: BlackboardScope; state: BoardReadState; refresh: () => void; onOpen: (threadId: string) => void;
}) {
  const snapshot = state.snapshot;
  const phase = state.phase === "unregistered" ? "此项目尚未登记独立协作黑板。" : state.phase === "unavailable" ?
    "原连接或协作记录暂不可读取，关系未核实。" : state.phase === "paused" ? "页面不可见，读取已暂停。" :
    state.phase === "waiting" ? "等待原连接就绪。" : state.phase === "loading" ? "正在读取独立协作黑板…" :
    state.loading ? "正在更新独立协作记录…" : "独立协作记录已读取。";
  return <section className="aaa-blackboard" aria-label="独立 Agent 协作黑板" data-board-scope={boardScopeKey(scope)} data-board-fresh={state.fresh}>
    <div className="aaa-blackboard-heading"><div><strong>独立 Agent 协作</strong><p role="status">{phase}</p></div>
      <button type="button" onClick={refresh}>重新读取协作</button></div>
    {snapshot && <details className="aaa-blackboard-details">
      <summary>{state.fresh ? "共享黑板" : "上次读取 · 当前来源未核实"} · 版本 {snapshot.revision} · {snapshot.participants.length} 个独立对话</summary>
      <div className="aaa-blackboard-records">
        <p className="aaa-blackboard-source">原项目 {scope.projectId} · 环境 {scope.environmentId}<br />
          黑板 {snapshot.boardId} · {snapshot.updatedAt}</p>
        <div className="aaa-blackboard-participants">{snapshot.participants.map(actor => <article key={actor.actorId}>
          <strong>{actor.role === "coordinator" ? "协调 Agent" : "执行 Agent"} · {actor.title}</strong>
          <p>{actor.actorId} · 原对话 {actor.threadId}</p>
          <button type="button" disabled={!state.fresh} onClick={() => onOpen(actor.threadId)} aria-label={`打开独立对话 ${actor.threadId}`}>打开原对话 ↗</button>
        </article>)}</div>
        {snapshot.tasks.length === 0 && <p>尚未发布分工，当前没有协作连线。</p>}
        {snapshot.tasks.map(task => <details key={task.taskId} className="aaa-blackboard-task">
          <summary>{task.title} · {boardTaskLabel(task.status)}</summary>
          <p>执行者 {task.ownerActorId} · 分工版本 {task.assignedRevision} · 任务 {task.taskId}</p>
          <p className="aaa-blackboard-text">{task.instructions}</p>
          {task.report && <><strong>执行回报 · 版本 {task.report.revision}</strong><p className="aaa-blackboard-text">{task.report.text}</p>
            <p className="aaa-blackboard-source">回报来源 {task.report.eventId}<br />分工读取来源 {task.report.assignmentReadEventId}</p></>}
        </details>)}
        {snapshot.summary ? <article className="aaa-blackboard-summary"><strong>协调汇总 · 版本 {snapshot.summary.revision}</strong>
          <p className="aaa-blackboard-text">{snapshot.summary.text}</p>
          <p className="aaa-blackboard-source">来源 {snapshot.summary.eventId}<br />引用回报 {snapshot.summary.reportEventIds.join(" · ")}</p>
        </article> : <p>协调汇总尚未发布。</p>}
        <details><summary>查看连线与记录来源</summary>
          {snapshot.relations.map(edge => <p key={edge.relationId} data-board-relation-source={edge.relationId}>
            {edge.kind === "assignment" ? "分配" : "回报"} · {edge.sourceThreadId} → {edge.targetThreadId}<br />
            任务 {edge.taskId} · 来源 {edge.eventId} · 版本 {edge.recordRevision}</p>)}
          {snapshot.events.map(event => <p key={event.eventId} className="aaa-blackboard-source">
            {event.kind} · {event.actorId} · v{event.revision} · {event.observedAt}<br />
            {event.eventId} · 操作 {event.operationId}</p>)}
        </details>
      </div>
    </details>}
  </section>;
}

/** The existing Agents panel receives its original scoped target; each link uses the original ChatView route. */
export function IndependentAgents({ scope, visible = true }: { scope: BlackboardScope; visible?: boolean }) {
  const reader = useBlackboardReader(), navigate = useNavigate();
  const state = useIndependentBlackboard(scope, reader, visible), threads = useOriginalBoardThreads(scope);
  return <IndependentBlackboardPanel scope={scope} state={checkedBoardState(state, scope, threads)} refresh={state.refresh} onOpen={id => {
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(scopeThreadRef(scope.environmentId as EnvironmentId, id as ThreadId)) });
  }} />;
}
