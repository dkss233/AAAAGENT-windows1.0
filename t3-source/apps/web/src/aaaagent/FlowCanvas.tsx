import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { emptyLayout, fitNodes, locateNode, flowNodePosition, NODE_WIDTH, NODE_HEIGHT, readLayout, zoomAt,
  type FlowLayout, type Point } from "./flow-layout";
import type { NativeChildFlowNode } from "@t3tools/contracts";
import type { NativeChildTarget } from "./native-child-flow";

export type FlowNode = {
  key: string; title: string; threadId: string; environmentId: string;
  provider: string; model: string; status: string; category: string; updatedAt: string; progress: string;
  role?: string; parentKey?: string; siblingIndex?: number; openable?: boolean;
  nativeChild?: { target: NativeChildTarget; child: NativeChildFlowNode; verified: boolean };
};
export type FlowEdge = { key: string; source: string; target: string; label: string };
type Drag = { pointerId: number; key: string | null; start: Point; origin: Point; moved: boolean };
const storageKey = (project: string) => `aaaagent:flow:v1:${project}`;
function load(project: string) {
  try { return readLayout(localStorage.getItem(storageKey(project))); } catch { return emptyLayout(); }
}
function loadMode(project: string) {
  try {
    const saved = localStorage.getItem(`aaaagent:flow:mode:${project}`);
    if (saved === "list" || saved === "canvas") return saved;
  } catch { /* the current view remains usable */ }
  return matchMedia("(max-width: 640px)").matches ? "list" : "canvas";
}
export function FlowCanvas({ project, nodes, edges = [], onOpen }: {
  project: string; nodes: readonly FlowNode[]; edges?: readonly FlowEdge[]; onOpen: (node: FlowNode) => void;
}) {
  const arrowId = useId().replace(/:/g, "");
  const [layout, setLayout] = useState<FlowLayout>(() => load(project));
  const [mode, setMode] = useState(() => loadMode(project));
  const [storageError, setStorageError] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  useEffect(() => {
    try { localStorage.setItem(storageKey(project), JSON.stringify(layout)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [layout, project]);
  useEffect(() => {
    try { localStorage.setItem(`aaaagent:flow:mode:${project}`, mode); } catch { /* page state still works */ }
  }, [mode, project]);
  const query = layout.query.trim().toLocaleLowerCase();
  const visible = nodes.filter(n => (!query || `${n.title} ${n.provider} ${n.model} ${n.threadId}`.toLocaleLowerCase().includes(query)) &&
    (layout.filter === "all" || n.category === layout.filter));
  const getPosition = (key: string) => flowNodePosition(layout, nodes, key);
  const size = () => ({ width: canvas.current?.clientWidth ?? 800, height: canvas.current?.clientHeight ?? 500 });
  const fit = () => {
    const { width, height } = size();
    setLayout(l => ({ ...l, viewport: fitNodes(visible.map(n => flowNodePosition(l, nodes, n.key)), width, height) }));
  };
  const locate = () => {
    if (!layout.selected || !visible.some(n => n.key === layout.selected)) return;
    const { width, height } = size();
    setLayout(l => ({ ...l, viewport: locateNode(getPosition(l.selected!), l.viewport, width, height) }));
  };
  const zoom = (ratio: number) => {
    const { width, height } = size();
    setLayout(l => ({ ...l, viewport: zoomAt(l.viewport, l.viewport.zoom * ratio, { x: width / 2, y: height / 2 }) }));
  };
  const startDrag = (event: PointerEvent<HTMLElement>, key: string | null) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button,a,input,select")) return;
    if (drag.current) return;
    const origin = key ? getPosition(key) : layout.viewport;
    drag.current = { pointerId: event.pointerId, key, start: { x: event.clientX, y: event.clientY }, origin, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault(); event.stopPropagation();
    if (key) setLayout(l => ({ ...l, selected: key }));
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.start.x, dy = event.clientY - active.start.y;
    if (Math.hypot(dx, dy) < 4 && !active.moved) return;
    active.moved = true;
    setLayout(l => active.key
      ? { ...l, positions: { ...l.positions, [active.key]: { x: active.origin.x + dx / l.viewport.zoom, y: active.origin.y + dy / l.viewport.zoom } } }
      : { ...l, viewport: { ...l.viewport, x: active.origin.x + dx, y: active.origin.y + dy } });
    event.stopPropagation();
  };
  const endDrag = (event: PointerEvent<HTMLElement>, cancelled = false) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    event.stopPropagation();
    if (!cancelled && active.key && !active.moved) {
      const node = nodes.find(n => n.key === active.key);
      if (node && node.openable !== false) onOpen(node);
    }
  };
  const card = (node: FlowNode, isCanvas: boolean) => <article key={node.key}
    className={`aaa-flow-node ${layout.selected === node.key ? "is-selected" : ""}`}
    data-node-key={node.key} data-thread-id={node.threadId} tabIndex={0}
    aria-label={`${node.title}，${node.status}，对话 ${node.threadId}`}
    style={isCanvas ? { position: "absolute", left: getPosition(node.key).x, top: getPosition(node.key).y } : undefined}
    onPointerDown={isCanvas ? e => startDrag(e, node.key) : undefined}
    onPointerMove={isCanvas ? moveDrag : undefined}
    onPointerUp={isCanvas ? e => endDrag(e) : undefined}
    onPointerCancel={isCanvas ? e => endDrag(e, true) : undefined}
    onKeyDown={e => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter") { e.preventDefault(); if (node.openable !== false) onOpen(node); return; }
      const vectors: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
      const v = vectors[e.key];
      if (v && isCanvas) { e.preventDefault(); const p = getPosition(node.key), step = e.shiftKey ? 64 : 16;
        setLayout(l => ({ ...l, selected: node.key, positions: { ...l.positions, [node.key]: { x: p.x + v.x * step, y: p.y + v.y * step } } })); }
    }}>
    <div className="aaa-node-meta"><span title={`${node.role ?? "对话"} · ${node.provider}`}>{node.role ? `${node.role} · ` : ""}{node.provider}</span><span className={`aaa-node-status ${node.category}`}>{node.status}</span></div>
    <h2 title={node.title}>{node.title}</h2>
    <p className="aaa-node-progress" title={node.progress}>{node.progress}</p>
    <div className="aaa-node-model"><span title={node.model}>{node.model}</span><time dateTime={node.updatedAt} title={node.updatedAt}>{new Date(node.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div>
    <div className="aaa-node-footer"><small title={`${node.environmentId} / ${node.threadId}`}>{node.threadId.length > 14 ? `${node.threadId.slice(0, 5)}…${node.threadId.slice(-7)}` : node.threadId}</small>
      <button type="button" onClick={() => setLayout(l => ({ ...l, selected: node.key }))} aria-label={`选中 ${node.threadId}`}>选中</button>
      <button type="button" disabled={node.openable === false} title={node.openable === false ? "归属尚未核实，完整子对话不可读取" : undefined}
        onClick={() => onOpen(node)} aria-label={`展开对话 ${node.threadId}`}>展开 ↗</button></div>
  </article>;
  return <section className="aaa-flow-content">
    <div className="aaa-flow-tools">
      <label className="aaa-flow-search"><span className="sr-only">搜索当前项目对话</span>
        <input aria-label="搜索当前项目对话" placeholder="搜索对话、执行者或模型…" value={layout.query}
          onChange={e => setLayout(l => ({ ...l, query: e.target.value }))} /></label>
      <select aria-label="状态筛选" value={layout.filter} onChange={e => setLayout(l => ({ ...l, filter: e.target.value }))}>
        <option value="all">全部状态</option><option value="working">进行中</option><option value="attention">待处理</option><option value="settled">已结束</option>
      </select>
      <div className="aaa-view-switch"><button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>列表</button>
        <button type="button" aria-pressed={mode === "canvas"} onClick={() => setMode("canvas")}>画布</button></div>
    </div>
    <div className="aaa-canvas-tools" aria-label="画布工具">
      <button type="button" onClick={() => zoom(1 / 1.2)} disabled={mode !== "canvas"} aria-label="缩小画布">−</button>
      <output aria-label="画布缩放">{Math.round(layout.viewport.zoom * 100)}%</output>
      <button type="button" onClick={() => zoom(1.2)} disabled={mode !== "canvas"} aria-label="放大画布">＋</button>
      <button type="button" onClick={fit} disabled={mode !== "canvas" || !visible.length}>适应全部</button>
      <button type="button" onClick={locate} disabled={mode !== "canvas" || !visible.some(n => n.key === layout.selected)}>定位选中</button>
      <button type="button" onClick={() => setLayout(l => ({ ...l, positions: {}, viewport: { ...emptyLayout().viewport } }))}>重置布局</button>
      <span>{visible.length} 个对话</span>
    </div>
    {!visible.length ? <div className="aaa-flow-empty"><h2>{nodes.length ? "没有匹配的对话" : "这个项目还没有对话"}</h2>
      <p>{nodes.length ? "调整搜索或筛选查看当前项目的对话。" : "已有对话会显示在这里，多轮交流保留在同一个节点。"}</p></div>
      : mode === "list" ? <div className="aaa-flow-list">{visible.map(n => card(n, false))}</div>
      : <div ref={canvas} className="aaa-flow-canvas" tabIndex={0} aria-label="对话节点画布"
        data-viewport={JSON.stringify(layout.viewport)}
        onPointerDown={e => startDrag(e, null)} onPointerMove={moveDrag} onPointerUp={e => endDrag(e)} onPointerCancel={e => endDrag(e, true)}
        onWheel={e => {
          if (e.ctrlKey || e.metaKey) {
            const bounds = e.currentTarget.getBoundingClientRect();
            setLayout(l => ({ ...l, viewport: zoomAt(l.viewport, l.viewport.zoom * Math.exp(-e.deltaY * .002), { x: e.clientX - bounds.left, y: e.clientY - bounds.top }) }));
          } else setLayout(l => ({ ...l, viewport: { ...l.viewport, x: l.viewport.x - e.deltaX, y: l.viewport.y - e.deltaY } }));
        }}
        onKeyDown={e => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "+" || e.key === "=") { e.preventDefault(); zoom(1.2); }
          if (e.key === "-") { e.preventDefault(); zoom(1 / 1.2); }
          if (e.key.toLowerCase() === "f") { e.preventDefault(); fit(); }
          const vectors: Record<string, Point> = { ArrowLeft: { x: 40, y: 0 }, ArrowRight: { x: -40, y: 0 }, ArrowUp: { x: 0, y: 40 }, ArrowDown: { x: 0, y: -40 } };
          const v = vectors[e.key]; if (v) { e.preventDefault(); setLayout(l => ({ ...l, viewport: { ...l.viewport, x: l.viewport.x + v.x, y: l.viewport.y + v.y } })); }
        }}>
        <div className="aaa-flow-plane" style={{ transform: `translate(${layout.viewport.x}px, ${layout.viewport.y}px) scale(${layout.viewport.zoom})` }}>
          <svg className="aaa-flow-edges" aria-label="真实来源的有向关系" width="1" height="1">
            <defs><marker id={arrowId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>
            {edges.filter(edge => visible.some(n => n.key === edge.source) && visible.some(n => n.key === edge.target)).map(edge => {
              const from = getPosition(edge.source), to = getPosition(edge.target);
              const x1 = from.x + NODE_WIDTH / 2, y1 = from.y + NODE_HEIGHT, x2 = to.x + NODE_WIDTH / 2, y2 = to.y;
              const middle = (y1 + y2) / 2;
              return <g key={edge.key} data-relation-key={edge.key} data-source-key={edge.source} data-target-key={edge.target}>
                <title>{edge.label}</title><path d={`M${x1},${y1} C${x1},${middle} ${x2},${middle} ${x2},${y2}`} markerEnd={`url(#${arrowId})`} />
                <text x={(x1 + x2) / 2} y={middle - 7} textAnchor="middle">{edge.label}</text>
              </g>;
            })}
          </svg>{visible.map(n => card(n, true))}</div>
      </div>}
    <footer className="aaa-flow-note">{mode === "canvas" ? "拖动节点或空白处 · Ctrl/⌘ + 滚轮缩放 · 方向键移动 · Enter 展开 · F 适应全部。" : "选择对话后进入完整聊天与工程详情。"} 无来源关系的对话保持独立。
      {storageError && <span role="status">布局暂存于本页，当前浏览器无法保存。</span>}</footer>
  </section>;
}
