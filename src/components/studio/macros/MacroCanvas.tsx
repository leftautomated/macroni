import "@xyflow/react/dist/style.css";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnect,
  type OnEdgesChange,
  type OnNodeDrag,
  type OnNodesChange,
  type OnSelectionChangeFunc,
} from "@xyflow/react";
import { SegmentNodeView } from "@/components/studio/macros/SegmentNodeView";
import { WaitNodeView } from "@/components/studio/macros/WaitNodeView";
import { canConnect, docToFlow, flowToDoc, withRunState } from "@/lib/macro-flow";
import type { MacroDoc } from "@/types";

// Module-const: react-flow rebuilds its internal node-type map (and warns)
// whenever the `nodeTypes` object identity changes, so this must not be
// re-created per render.
const nodeTypes = { segment: SegmentNodeView, wait: WaitNodeView };

function isStructuralNodeChange(changes: NodeChange[]): boolean {
  return changes.some(
    (change) => change.type === "add" || change.type === "remove" || change.type === "replace",
  );
}

function isStructuralEdgeChange(changes: EdgeChange[]): boolean {
  return changes.some(
    (change) => change.type === "add" || change.type === "remove" || change.type === "replace",
  );
}

export interface MacroCanvasProps {
  doc: MacroDoc;
  liveNodeId: string | null;
  failedNodeId: string | null;
  onChange: (doc: MacroDoc) => void;
  onSelectionChange?: (nodeId: string | null) => void;
}

export function MacroCanvas({
  doc,
  liveNodeId,
  failedNodeId,
  onChange,
  onSelectionChange,
}: MacroCanvasProps) {
  // Seeded once from the initial doc; subsequent re-seeding happens explicitly
  // in the doc.id effect below (which skips its mount re-fire).
  const initialFlow = useMemo(() => docToFlow(doc), []);
  const [nodes, setNodes] = useNodesState<Node>(initialFlow.nodes);
  const [edges, setEdges] = useEdgesState<Edge>(initialFlow.edges);

  // Mirrors of the latest nodes/edges, updated synchronously inside the
  // setState updaters below. react-flow can fire onNodesChange and
  // onEdgesChange back-to-back in the same tick (e.g. deleting a node also
  // removes its edges); reading these refs instead of the `nodes`/`edges`
  // closures guarantees flowToDoc always sees the latest values regardless
  // of which handler ran last.
  const nodesRef = useRef(initialFlow.nodes);
  const edgesRef = useRef(initialFlow.edges);
  const seededDocIdRef = useRef(doc.id);

  // Re-seed the canvas whenever a *different* macro doc is loaded. Guarded so the
  // effect's mount run is a no-op (the initialFlow seed above already covers it)
  // and content-only edits to the same doc don't reset the canvas.
  useEffect(() => {
    if (seededDocIdRef.current === doc.id) return;
    seededDocIdRef.current = doc.id;
    const seeded = docToFlow(doc);
    nodesRef.current = seeded.nodes;
    edgesRef.current = seeded.edges;
    setNodes(seeded.nodes);
    setEdges(seeded.edges);
  }, [doc, setNodes, setEdges]);

  const handleNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      setNodes((current) => {
        const next = applyNodeChanges(changes, current);
        nodesRef.current = next;
        if (isStructuralNodeChange(changes)) {
          onChange(flowToDoc(doc, next, edgesRef.current));
        }
        return next;
      });
    },
    [doc, onChange, setNodes],
  );

  const handleEdgesChange = useCallback<OnEdgesChange>(
    (changes) => {
      setEdges((current) => {
        const next = applyEdgeChanges(changes, current);
        edgesRef.current = next;
        if (isStructuralEdgeChange(changes)) {
          onChange(flowToDoc(doc, nodesRef.current, next));
        }
        return next;
      });
    },
    [doc, onChange, setEdges],
  );

  const handleConnect = useCallback<OnConnect>(
    (connection) => {
      if (!canConnect(edgesRef.current, connection.source, connection.target)) return;
      setEdges((current) => {
        const next = addEdge(connection, current);
        edgesRef.current = next;
        onChange(flowToDoc(doc, nodesRef.current, next));
        return next;
      });
    },
    [doc, onChange, setEdges],
  );

  const handleNodeDragStop = useCallback<OnNodeDrag>(() => {
    onChange(flowToDoc(doc, nodesRef.current, edgesRef.current));
  }, [doc, onChange]);

  const handleSelectionChange = useCallback<OnSelectionChangeFunc>(
    ({ nodes: selected }) => {
      onSelectionChange?.(selected[0]?.id ?? null);
    },
    [onSelectionChange],
  );

  const decoratedNodes = useMemo(
    () => withRunState(nodes, liveNodeId, failedNodeId),
    [nodes, liveNodeId, failedNodeId],
  );

  return (
    <ReactFlowProvider>
      <div style={{ width: "100%", height: "100%" }}>
        <ReactFlow
          nodes={decoratedNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onNodeDragStop={handleNodeDragStop}
          onSelectionChange={handleSelectionChange}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}
