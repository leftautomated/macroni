import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { MacroDoc, MacroNode } from "@/types";
import { canConnect, docToFlow, flowToDoc, nodeSummary, withRunState } from "./macro-flow";

const segmentNode = (
  id: string,
  x: number,
  y: number,
  overrides: Partial<MacroNode> = {},
): MacroNode => ({
  id,
  kind: { type: "Segment", events: [], speed: 1 },
  x,
  y,
  ...overrides,
});

const waitNode = (id: string, x: number, y: number): MacroNode => ({
  id,
  kind: {
    type: "WaitFor",
    target: {
      id: "target-1",
      name: "target",
      modality: "visual",
      kind: { type: "TextOcr", expect: "Go" },
      created_at: 0,
    },
    timeout_ms: 5000,
    poll_interval_ms: 100,
  },
  x,
  y,
});

const makeDoc = (): MacroDoc => ({
  id: "doc-1",
  name: "My Macro",
  nodes: [segmentNode("a", 10, 20), waitNode("b", 100, 200)],
  edges: [{ from: "a", to: "b" }],
  created_at: 0,
});

describe("docToFlow", () => {
  it("maps node type/position and edge id for a 2-node+1-edge doc", () => {
    const doc = makeDoc();
    const { nodes, edges } = docToFlow(doc);

    expect(nodes).toHaveLength(2);
    const a = nodes.find((n) => n.id === "a");
    const b = nodes.find((n) => n.id === "b");
    expect(a?.type).toBe("segment");
    expect(a?.position).toEqual({ x: 10, y: 20 });
    expect(a?.data.node).toEqual(doc.nodes[0]);
    expect(b?.type).toBe("wait");
    expect(b?.position).toEqual({ x: 100, y: 200 });
    expect(b?.data.node).toEqual(doc.nodes[1]);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ id: "a->b", source: "a", target: "b" });
  });
});

describe("flowToDoc", () => {
  it("round-trips positions and edges and preserves a WaitFor kind", () => {
    const doc = makeDoc();
    const nodes: Node[] = [
      { id: "a", type: "segment", position: { x: 50, y: 60 }, data: { node: doc.nodes[0] } },
      { id: "b", type: "wait", position: { x: 150, y: 260 }, data: { node: doc.nodes[1] } },
    ];
    const edges: Edge[] = [{ id: "a->b", source: "a", target: "b" }];

    const result = flowToDoc(doc, nodes, edges);

    expect(result.id).toBe(doc.id);
    expect(result.name).toBe(doc.name);
    expect(result.created_at).toBe(doc.created_at);

    const a = result.nodes.find((n) => n.id === "a");
    const b = result.nodes.find((n) => n.id === "b");
    expect(a).toMatchObject({ x: 50, y: 60 });
    expect(b).toMatchObject({ x: 150, y: 260 });
    // WaitFor kind preserved, not just positions
    expect(b?.kind).toEqual(doc.nodes[1].kind);
    expect(a?.kind).toEqual(doc.nodes[0].kind);

    expect(result.edges).toEqual([{ from: "a", to: "b" }]);
    // base node order preserved
    expect(result.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("canConnect", () => {
  const edges: Edge[] = [{ id: "a->b", source: "a", target: "b" }];

  it("rejects a self-connection", () => {
    expect(canConnect(edges, "a", "a")).toBe(false);
  });

  it("rejects when source already has an out-edge", () => {
    expect(canConnect(edges, "a", "c")).toBe(false);
  });

  it("rejects when target already has an in-edge", () => {
    expect(canConnect(edges, "c", "b")).toBe(false);
  });

  it("accepts a fresh link", () => {
    expect(canConnect(edges, "b", "c")).toBe(true);
  });
});

describe("nodeSummary", () => {
  it("summarizes a 3-event segment with duration", () => {
    const node = segmentNode("s", 0, 0, {
      kind: {
        type: "Segment",
        events: [
          { type: "MouseMove" as never, x: 0, y: 0, timestamp: 1000 } as never,
          { type: "MouseMove" as never, x: 1, y: 1, timestamp: 1500 } as never,
          { type: "MouseMove" as never, x: 2, y: 2, timestamp: 2500 } as never,
        ],
        speed: 1,
      },
    });
    expect(nodeSummary(node)).toBe("3 events · 1.5s");
    expect(nodeSummary(node)).toContain("3 events");
  });

  it("returns 0s duration for fewer than 2 events", () => {
    const node = segmentNode("s", 0, 0, { kind: { type: "Segment", events: [], speed: 1 } });
    expect(nodeSummary(node)).toBe("0 events · 0s");
  });

  it("summarizes a text wait with its expected string", () => {
    const node = waitNode("w", 0, 0);
    expect(nodeSummary(node)).toBe('wait: "Go" · 5s');
    expect(nodeSummary(node)).toContain('wait: "Go"');
  });

  it("summarizes a text wait with no expect as 'any text'", () => {
    const node: MacroNode = {
      id: "w2",
      kind: {
        type: "WaitFor",
        target: {
          id: "t2",
          name: "t2",
          modality: "visual",
          kind: { type: "TextOcr" },
          created_at: 0,
        },
        timeout_ms: 2000,
        poll_interval_ms: 100,
      },
      x: 0,
      y: 0,
    };
    expect(nodeSummary(node)).toBe('wait: "any text" · 2s');
  });

  it("summarizes a template-match wait", () => {
    const node: MacroNode = {
      id: "w3",
      kind: {
        type: "WaitFor",
        target: {
          id: "t3",
          name: "t3",
          modality: "visual",
          kind: { type: "TemplateMatch", image: "img.png", threshold: 0.9, source_px: [0, 0] },
          created_at: 0,
        },
        timeout_ms: 1000,
        poll_interval_ms: 100,
      },
      x: 0,
      y: 0,
    };
    expect(nodeSummary(node)).toBe("wait: image");
  });

  it("summarizes a color-sample wait", () => {
    const node: MacroNode = {
      id: "w4",
      kind: {
        type: "WaitFor",
        target: {
          id: "t4",
          name: "t4",
          modality: "visual",
          kind: { type: "ColorSample", rgb: [255, 0, 0], tolerance: 5 },
          created_at: 0,
        },
        timeout_ms: 1000,
        poll_interval_ms: 100,
      },
      x: 0,
      y: 0,
    };
    expect(nodeSummary(node)).toBe("wait: color");
  });
});

describe("withRunState", () => {
  const nodes: Node[] = [
    { id: "a", type: "segment", position: { x: 0, y: 0 }, data: { node: segmentNode("a", 0, 0) } },
    { id: "b", type: "wait", position: { x: 0, y: 0 }, data: { node: waitNode("b", 0, 0) } },
    { id: "c", type: "segment", position: { x: 0, y: 0 }, data: { node: segmentNode("c", 0, 0) } },
  ];

  it("sets live/failed on the right node and leaves others' data.live false", () => {
    const result = withRunState(nodes, "b", "c");

    const a = result.find((n) => n.id === "a");
    const b = result.find((n) => n.id === "b");
    const c = result.find((n) => n.id === "c");

    expect(a?.data.live).toBe(false);
    expect(a?.data.failed).toBe(false);
    expect(b?.data.live).toBe(true);
    expect(b?.data.failed).toBe(false);
    expect(c?.data.live).toBe(false);
    expect(c?.data.failed).toBe(true);

    // preserves other data (immutably)
    expect(a?.data.node).toEqual(nodes[0].data.node);
    expect(result).not.toBe(nodes);
    expect(result[0]).not.toBe(nodes[0]);
  });

  it("sets both to false when ids are null", () => {
    const result = withRunState(nodes, null, null);
    for (const n of result) {
      expect(n.data.live).toBe(false);
      expect(n.data.failed).toBe(false);
    }
  });
});
