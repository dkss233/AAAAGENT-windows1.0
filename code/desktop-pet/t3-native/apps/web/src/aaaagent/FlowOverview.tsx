import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "../threadRoutes";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import { SidebarInset } from "../components/ui/sidebar";
import { NATIVE_READ } from "./NativeReadBoundary";
import { FlowCanvas, type FlowNode } from "./FlowCanvas";
import { nodeKey, projectKey } from "./flow-layout";
import { NativeChildConversation, useNativeChildReader } from "./NativeChildConversation";
import { nativeChildKey, projectChildFlowNodes, useNativeChildRelations, type NativeChildTarget } from "./native-child-flow";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useBlackboardReader } from "./BlackboardReader";
import { checkedBoardState, IndependentBlackboardPanel, useIndependentBlackboard, useOriginalBoardThreads } from "./IndependentBlackboard";
import { projectBoardFlow } from "./independent-blackboard";
import { nativeSessionState } from "./native-session-state";

export function FlowOverview({ preferredEnvironment, preferredProject }: {
  preferredEnvironment?: string; preferredProject?: string;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const configs = useServerConfigs();
  const navigate = useNavigate();
  const reader = useNativeChildReader();
  const [openedChild, setOpenedChild] = useState<FlowNode["nativeChild"] | null>(null);
  const preferred = preferredEnvironment && preferredProject ? projectKey(preferredEnvironment, preferredProject) : null;
  const [selected, setSelected] = useState<string | null>(() => {
    if (preferred) return preferred;
    try { return localStorage.getItem("aaaagent:flow:project"); } catch { return null; }
  });
  const current = projects.find(p => projectKey(p.environmentId, p.id) === selected) ??
    projects.find(p => projectKey(p.environmentId, p.id) === preferred) ?? projects[0];
  const key = current ? projectKey(current.environmentId, current.id) : "";
  const boardReader = useBlackboardReader();
  const boardScope = useMemo(() => current ? { environmentId: current.environmentId, projectId: current.id } : null, [key]);
  const boardRead = useIndependentBlackboard(boardScope, boardReader, openedChild === null);
  const originalBoardThreads = useOriginalBoardThreads(boardScope);
  const board = boardScope ? checkedBoardState(boardRead, boardScope, originalBoardThreads) : boardRead;
  // Keep the existing router's presentation projection aligned with the chosen project.
  useEffect(() => {
    if (current && (current.environmentId !== preferredEnvironment || current.id !== preferredProject)) {
      void navigate({ to: "/", search: { aaaEnvironment: current.environmentId, aaaProject: current.id }, replace: true });
    }
  }, [current?.environmentId, current?.id, preferredEnvironment, preferredProject, navigate]);
  const nodes = useMemo<FlowNode[]>(() => current ? threads
    .filter(t => t.environmentId === current.environmentId && t.projectId === current.id && !t.archivedAt)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(t => {
      const provider = configs.get(t.environmentId)?.providers.find(p => p.instanceId === t.modelSelection.instanceId);
      const { status, category } = nativeSessionState(t, NATIVE_READ);
      return { key: nodeKey(t.environmentId, t.id), environmentId: t.environmentId, threadId: t.id,
        title: t.title, provider: provider?.displayName ?? provider?.driver ?? t.session?.providerName ?? "执行者待核",
        model: t.modelSelection.model || "模型待核", status,
        category, updatedAt: t.updatedAt,
        progress: t.planProgress?.step ?? (t.session?.lastError ? "原会话有错误，展开查看" : "展开查看完整对话与工程详情") };
    }) : [], [configs, current, threads]);
  const targets = useMemo<NativeChildTarget[]>(() => current ? threads.filter(t => t.environmentId === current.environmentId &&
    t.projectId === current.id && !t.archivedAt && configs.get(t.environmentId)?.providers.some(p =>
      p.instanceId === t.modelSelection.instanceId && p.driver === "codex")).map(t => ({ environmentId: t.environmentId,
        projectId: current.id, parentThreadId: t.id, providerInstanceId: t.modelSelection.instanceId })) : [], [current, threads, configs]);
  const relations = useNativeChildRelations(targets, reader);
  const [loadedTurns, setLoadedTurns] = useState<Record<string, { updatedAt: string; status: string | null }>>({});
  const nativeGraph = useMemo(() => projectChildFlowNodes(nodes, relations.records.map(record => ({ ...record,
    children: record.children.map(child => {
      const loaded = loadedTurns[nativeChildKey(record.scope, child.nativeThreadId)];
      return loaded?.updatedAt === child.updatedAt ? { ...child, lastTurnStatus: loaded.status } : child;
    }) }))), [nodes, relations.records, loadedTurns]);
  const graph = useMemo(() => {
    if (!boardScope || !board.fresh) return nativeGraph;
    try {
      const projection = projectBoardFlow(nativeGraph.nodes, board.snapshot, boardScope, originalBoardThreads);
      return { nodes: projection.nodes, edges: [...nativeGraph.edges, ...projection.edges] };
    } catch { return nativeGraph; }
  }, [nativeGraph, boardScope, board.fresh, board.snapshot, originalBoardThreads]);
  useEffect(() => { setOpenedChild(null); }, [key]);
  return <SidebarInset className="aaa-flow-overview min-h-0 overflow-hidden">
    <div className="aaa-project-heading"><div><span className="aaa-eyebrow">WORKSPACE / FLOW</span>
      <h1>{current?.title ?? "项目总览"}</h1><p>原生对话节点 · 多轮交流留在同一会话</p></div>
      <label><span className="sr-only">选择项目</span><select aria-label="选择项目" value={key} onChange={e => {
        setSelected(e.target.value); try { localStorage.setItem("aaaagent:flow:project", e.target.value); } catch { /* page state still works */ }
      }}>{projects.map(p => <option key={projectKey(p.environmentId, p.id)} value={projectKey(p.environmentId, p.id)}>{p.title} · {p.id.slice(0, 6)}</option>)}</select></label>
    </div>
    {boardScope && <IndependentBlackboardPanel scope={boardScope} state={board} refresh={boardRead.refresh} onOpen={id => {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(scopeThreadRef(boardScope.environmentId as EnvironmentId, id as ThreadId)) });
    }} />}
    {current && targets.length > 0 && <div className="aaa-child-read-state"><button type="button" onClick={relations.refresh}>重新读取子任务</button>
      {relations.loading ? " · 正在读取真实子任务…" : relations.errors ? " · 部分原连接未能读取，已有主对话保留。" : ""}</div>}
    {current ? <FlowCanvas key={key} project={key} nodes={graph.nodes} edges={graph.edges} onOpen={n => {
      if (n.nativeChild) { if (n.nativeChild.verified) setOpenedChild(n.nativeChild); return; }
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(scopeThreadRef(n.environmentId as EnvironmentId, n.threadId as ThreadId)) });
    }} /> : <div className="aaa-flow-empty"><h2>还没有可用项目</h2><p>{NATIVE_READ ? "原服务还没有项目，本页不会创建项目或任务。" : "从原生侧栏管理项目，已有会话会显示在总览中。"}</p></div>}
    {openedChild && current && openedChild.target.projectId === current.id && openedChild.target.environmentId === current.environmentId &&
      <NativeChildConversation key={nativeChildKey(openedChild.target, openedChild.child.nativeThreadId)} target={openedChild.target}
        child={openedChild.child} reader={reader} onClose={() => setOpenedChild(null)} onLoaded={response => {
          setLoadedTurns(previous => ({ ...previous, [nativeChildKey(response.scope, response.child.nativeThreadId)]: {
            updatedAt: response.child.updatedAt, status: response.child.lastTurnStatus } }));
        }} onOpenParent={() => {
          const parentId = openedChild.child.parentNativeThreadId;
          const nativeParent = graph.nodes.find(node => node.nativeChild?.verified &&
            node.key === nativeChildKey(openedChild.target, parentId ?? ""));
          if (nativeParent?.nativeChild) { setOpenedChild(nativeParent.nativeChild); return; }
          setOpenedChild(null); void navigate({ to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(openedChild.target.environmentId as EnvironmentId, openedChild.target.parentThreadId)) });
        }} />}
  </SidebarInset>;
}
