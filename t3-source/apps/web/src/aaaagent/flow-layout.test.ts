import { describe, expect, it } from "vite-plus/test";
import { emptyLayout, fitNodes, locateNode, flowNodePosition, nodeKey, nodePosition, projectKey, readLayout, zoomAt } from "./flow-layout";
import { PreviewVoiceBridge } from "~/aaaIntegration/voiceBridge";

describe("AAA Flow uses original identities and view-only geometry", () => {
  it("separates the same thread/project id across environments, including delimiters", () => {
    expect(nodeKey("a/b", "c")).not.toBe(nodeKey("a", "b/c"));
    expect(nodeKey("env-a", "same")).not.toBe(nodeKey("env-b", "same"));
    expect(projectKey("env-a", "same")).not.toBe(projectKey("env-b", "same"));
  });
  it("restores existing positions independently of message or filtered-list order", () => {
    const layout = emptyLayout(); layout.positions[nodeKey("e", "thread")] = { x: 721, y: -45 };
    expect(nodePosition(layout, nodeKey("e", "thread"), 0)).toEqual({ x: 721, y: -45 });
    expect(nodePosition(layout, nodeKey("e", "thread"), 18)).toEqual({ x: 721, y: -45 });
  });
  it("round-trips view state and tolerates malformed or nonfinite saved data", () => {
    const layout = emptyLayout(); layout.viewport = { x: -322, y: 215, zoom: .7 }; layout.query = "same title";
    expect(readLayout(JSON.stringify(layout))).toEqual(layout);
    expect(readLayout("{" )).toEqual(emptyLayout());
    expect(readLayout('{"positions":{"bad":{"x":"no","y":3}},"viewport":{"x":0,"y":0,"zoom":999}}'))
      .toMatchObject({ positions: {}, viewport: { x: 0, y: 0, zoom: 2.4 } });
  });
  it("keeps the anchor's world coordinate stable when zoom changes", () => {
    const before = { x: -220, y: 80, zoom: .6 }, anchor = { x: 230, y: 175 };
    const after = zoomAt(before, 1.2, anchor);
    expect((anchor.x - after.x) / after.zoom).toBe((anchor.x - before.x) / before.zoom);
    expect((anchor.y - after.y) / after.zoom).toBe((anchor.y - before.y) / before.zoom);
  });
  it("fits distant nodes into a usable desktop viewport", () => {
    const positions = [{ x: -180, y: -60 }, { x: 780, y: 420 }];
    const viewport = fitNodes(positions, 1280, 800);
    for (const p of positions) {
      expect(p.x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(31);
      expect(p.y * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(31);
      expect((p.x + 280) * viewport.zoom + viewport.x).toBeLessThanOrEqual(1249);
      expect((p.y + 188) * viewport.zoom + viewport.y).toBeLessThanOrEqual(769);
    }
  });
  it("centers the selected node without resetting zoom or node positions", () => {
    const next = locateNode({ x: 912, y: -95 }, { x: 8, y: 9, zoom: .85 }, 900, 540);
    expect((912 + 140) * next.zoom + next.x).toBe(450);
    expect((-95 + 94) * next.zoom + next.y).toBe(270);
    expect(next.zoom).toBe(.85);
  });
});

describe("real child layout preserves root viewport and positions", () => {
  const nodes = [{ key: "root" }, { key: "a", parentKey: "root", siblingIndex: 0 },
    { key: "b", parentKey: "root", siblingIndex: 1 }, { key: "next", parentKey: "a", siblingIndex: 0 }];
  it("uses explicit parents for nested defaults and preserves independently dragged children", () => {
    const layout = emptyLayout(); layout.positions.root = { x: 600, y: -100 };
    expect(flowNodePosition(layout, nodes, "a")).toEqual({ x: 600, y: 154 });
    expect(flowNodePosition(layout, nodes, "b")).toEqual({ x: 924, y: 154 });
    expect(flowNodePosition(layout, nodes, "next")).toEqual({ x: 600, y: 408 });
    layout.positions.a = { x: -80, y: 42 };
    expect(flowNodePosition(layout, nodes, "a")).toEqual({ x: -80, y: 42 });
    expect(flowNodePosition(layout, nodes, "next")).toEqual({ x: -80, y: 296 });
    expect(layout.viewport).toEqual(emptyLayout().viewport);
  });
  it("handles missing/cyclic sources without recursive overflow", () => {
    const layout = emptyLayout();
    expect(flowNodePosition(layout, [{ key: "orphan", parentKey: "absent" }], "orphan")).toEqual({ x: 0, y: 0 });
    expect(Number.isFinite(flowNodePosition(layout, [{ key: "a", parentKey: "b" }, { key: "b", parentKey: "a" }], "a").y)).toBe(true);
  });
});

describe("AAA preview voice fills an exact original composer once", () => {
  const target = { environmentId: "env-a", threadId: "thread-a", inputId: "input-a", epoch: 1 };
  it("retains raw whitespace and rejects duplicate, wrong identity, and stale epoch", () => {
    const bridge = new PreviewVoiceBridge(); const filled: string[] = [];
    bridge.begin(target);
    expect(bridge.receive({ ...target, threadId: "thread-b" }, "wrong", t => filled.push(t))).toBe(false);
    expect(bridge.receive({ ...target, epoch: 0 }, "stale", t => filled.push(t))).toBe(false);
    expect(bridge.receive(target, "  原话\n保持原样  ", t => filled.push(t))).toBe(true);
    expect(bridge.receive(target, "duplicate", t => filled.push(t))).toBe(false);
    expect(filled).toEqual(["  原话\n保持原样  "]);
  });
  it("rejects a late transcript after cancel or switching target", () => {
    const bridge = new PreviewVoiceBridge(); const filled: string[] = [];
    bridge.begin(target); bridge.cancel();
    expect(bridge.receive(target, "cancelled", t => filled.push(t))).toBe(false);
    bridge.begin({ ...target, threadId: "thread-b", inputId: "input-b", epoch: 2 });
    expect(bridge.receive(target, "old task", t => filled.push(t))).toBe(false);
    expect(filled).toEqual([]);
  });
});
