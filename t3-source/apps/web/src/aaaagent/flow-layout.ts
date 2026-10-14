export type Point = { x: number; y: number };
export type Viewport = Point & { zoom: number };
export type FlowLayout = {
  positions: Record<string, Point>;
  viewport: Viewport;
  selected: string | null;
  query: string;
  filter: string;
};
export const NODE_WIDTH = 280;
export const NODE_HEIGHT = 188;
export const DEFAULT_VIEWPORT: Viewport = { x: 42, y: 40, zoom: 1 };
export const projectKey = (environmentId: string, projectId: string) =>
  JSON.stringify([environmentId, projectId]);
export const nodeKey = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const point = (value: unknown): value is Point =>
  !!value && typeof value === "object" && finite((value as Point).x) && finite((value as Point).y);
export const clampZoom = (zoom: number) => Math.max(0.3, Math.min(2.4, zoom));
export function emptyLayout(): FlowLayout {
  return { positions: {}, viewport: { ...DEFAULT_VIEWPORT }, selected: null, query: "", filter: "all" };
}
export function readLayout(raw: string | null): FlowLayout {
  const fallback = emptyLayout();
  try {
    const data = JSON.parse(raw ?? "null");
    if (!data || typeof data !== "object") return fallback;
    const positions: Record<string, Point> = {};
    for (const [key, value] of Object.entries(data.positions ?? {}).slice(0, 10000)) {
      if (point(value)) positions[key] = { x: value.x, y: value.y };
    }
    const viewport = point(data.viewport) && finite(data.viewport.zoom)
      ? { x: data.viewport.x, y: data.viewport.y, zoom: clampZoom(data.viewport.zoom) }
      : fallback.viewport;
    return { positions, viewport, selected: typeof data.selected === "string" ? data.selected : null,
      query: typeof data.query === "string" ? data.query.slice(0, 500) : "",
      filter: ["all", "working", "attention", "settled"].includes(data.filter) ? data.filter : "all" };
  } catch { return fallback; }
}
export function nodePosition(layout: FlowLayout, key: string, index: number): Point {
  return layout.positions[key] ?? { x: (index % 3) * 324, y: Math.floor(index / 3) * 234 };
}
export type FlowSpatialNode = { key: string; parentKey?: string; siblingIndex?: number };
export function flowNodePosition(layout: FlowLayout, nodes: readonly FlowSpatialNode[], key: string, visiting = new Set<string>()): Point {
  const index = nodes.findIndex(node => node.key === key), node = nodes[index];
  if (layout.positions[key]) return layout.positions[key];
  if (!node?.parentKey || visiting.has(key) || !nodes.some(parent => parent.key === node.parentKey)) return nodePosition(layout, key, Math.max(index, 0));
  const parent = flowNodePosition(layout, nodes, node.parentKey, new Set([...visiting, key]));
  return { x: parent.x + (node.siblingIndex ?? 0) * 324, y: parent.y + 254 };
}
export function zoomAt(viewport: Viewport, zoom: number, anchor: Point): Viewport {
  const next = clampZoom(zoom);
  const ratio = next / viewport.zoom;
  return { zoom: next, x: anchor.x - (anchor.x - viewport.x) * ratio,
    y: anchor.y - (anchor.y - viewport.y) * ratio };
}
export function fitNodes(positions: readonly Point[], width: number, height: number): Viewport {
  if (!positions.length || width <= 0 || height <= 0) return { ...DEFAULT_VIEWPORT };
  const left = Math.min(...positions.map(p => p.x));
  const top = Math.min(...positions.map(p => p.y));
  const right = Math.max(...positions.map(p => p.x + NODE_WIDTH));
  const bottom = Math.max(...positions.map(p => p.y + NODE_HEIGHT));
  const zoom = clampZoom(Math.min((width - 64) / (right - left), (height - 64) / (bottom - top), 1.2));
  return { zoom, x: width / 2 - (left + right) / 2 * zoom,
    y: height / 2 - (top + bottom) / 2 * zoom };
}
export function locateNode(position: Point, viewport: Viewport, width: number, height: number): Viewport {
  return { ...viewport, x: width / 2 - (position.x + NODE_WIDTH / 2) * viewport.zoom,
    y: height / 2 - (position.y + NODE_HEIGHT / 2) * viewport.zoom };
}
