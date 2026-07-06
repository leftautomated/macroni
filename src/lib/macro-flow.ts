import type { Edge, Node } from "@xyflow/react";
import type { MacroDoc, MacroNode } from "@/types";

/** Convert a MacroDoc into react-flow nodes/edges for rendering on the canvas. */
export function docToFlow(doc: MacroDoc): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = doc.nodes.map((node) => ({
    id: node.id,
    type: node.kind.type === "Segment" ? "segment" : "wait",
    position: { x: node.x, y: node.y },
    data: { node },
  }));
  const edges: Edge[] = doc.edges.map((edge) => ({
    id: `${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
  }));
  return { nodes, edges };
}

/** Write react-flow node positions and edges back into a MacroDoc, preserving node kinds/order. */
export function flowToDoc(base: MacroDoc, nodes: Node[], edges: Edge[]): MacroDoc {
  const positionById = new Map(nodes.map((n) => [n.id, n.position]));
  const updatedNodes: MacroNode[] = base.nodes.map((node) => {
    const position = positionById.get(node.id);
    return position ? { ...node, x: position.x, y: position.y } : node;
  });
  const updatedEdges = edges.map((e) => ({ from: e.source, to: e.target }));
  return {
    id: base.id,
    name: base.name,
    created_at: base.created_at,
    nodes: updatedNodes,
    edges: updatedEdges,
  };
}

/** Enforce a linear canvas: reject self-links and any second in/out edge. */
export function canConnect(edges: Edge[], source: string, target: string): boolean {
  if (source === target) return false;
  const hasOutEdge = edges.some((e) => e.source === source);
  if (hasOutEdge) return false;
  const hasInEdge = edges.some((e) => e.target === target);
  if (hasInEdge) return false;
  return true;
}

/** Human-readable one-line summary of a macro node, for canvas/list display. */
export function nodeSummary(node: MacroNode): string {
  const { kind } = node;
  if (kind.type === "Segment") {
    const { events } = kind;
    let dur = 0;
    if (events.length >= 2) {
      const first = events[0];
      const last = events[events.length - 1];
      dur = Math.round(((last.timestamp - first.timestamp) / 1000) * 10) / 10;
    }
    return `${events.length} events · ${dur}s`;
  }
  const timeoutS = kind.timeout_ms / 1000;
  const targetKind = kind.target.kind;
  if (targetKind.type === "TextOcr") {
    const expect = targetKind.expect ?? "any text";
    return `wait: "${expect}" · ${timeoutS}s`;
  }
  if (targetKind.type === "TemplateMatch") {
    return "wait: image";
  }
  return "wait: color";
}

/** Immutably annotate flow nodes with live/failed run-state flags for highlighting. */
export function withRunState(
  flowNodes: Node[],
  liveNodeId: string | null,
  failedNodeId: string | null,
): Node[] {
  return flowNodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      live: node.id === liveNodeId,
      failed: node.id === failedNodeId,
    },
  }));
}
