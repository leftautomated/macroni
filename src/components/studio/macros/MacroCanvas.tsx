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
import { canConnect, docToFlow, flowToDoc, shouldReseed, withRunState } from "@/lib/macro-flow";
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
  // in the `lastEmittedRef` effect below (which skips its mount re-fire).
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

  // The exact MacroDoc object this canvas last emitted via onChange (or null
  // before the first emission). Re-seeding compares the incoming `doc` prop
  // against this BY REFERENCE — not by id — so an external change to the SAME
  // macro (e.g. the add-node panel appending a node, which builds a new doc
  // object without touching doc.id) still re-seeds and shows the new node,
  // while the canvas's own round trip (the parent sets its state to this exact
  // emitted object) is recognized and skipped.
  const lastEmittedRef = useRef<MacroDoc | null>(null);

  // Re-seed the canvas whenever `doc` isn't the object this canvas itself last
  // emitted — a different macro was loaded, or something external mutated the
  // doc out from under it. Content-only edits that round-trip through the
  // parent unchanged (drag/connect/delete) are skipped via shouldReseed.
  useEffect(() => {
    if (!shouldReseed(doc, lastEmittedRef.current)) return;
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
          const emitted = flowToDoc(doc, next, edgesRef.current);
          lastEmittedRef.current = emitted;
          onChange(emitted);
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
          const emitted = flowToDoc(doc, nodesRef.current, next);
          lastEmittedRef.current = emitted;
          onChange(emitted);
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
        const emitted = flowToDoc(doc, nodesRef.current, next);
        lastEmittedRef.current = emitted;
        onChange(emitted);
        return next;
      });
    },
    [doc, onChange, setEdges],
  );

  const handleNodeDragStop = useCallback<OnNodeDrag>(() => {
    const emitted = flowToDoc(doc, nodesRef.current, edgesRef.current);
    lastEmittedRef.current = emitted;
    onChange(emitted);
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
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}
