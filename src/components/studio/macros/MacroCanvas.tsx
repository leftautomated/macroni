import "@xyflow/react/dist/style.css";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
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
import "./macro-editor.css";

// Module-const: react-flow rebuilds its internal node-type map (and warns)
// whenever the `nodeTypes` object identity changes, so this must not be
// re-created per render.
const nodeTypes = { segment: SegmentNodeView, wait: WaitNodeView };

const defaultEdgeOptions = {
  type: "smoothstep",
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: "#f0cd78",
    width: 18,
    height: 18,
  },
  style: {
    stroke: "#f0cd78",
    strokeWidth: 2.3,
  },
};

const connectionLineStyle = {
  stroke: "#f4dda4",
  strokeWidth: 2.3,
};

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
  const canvasState = failedNodeId ? "failed" : liveNodeId ? "running" : "ready";
  const canvasStateLabel = failedNodeId ? "Failed" : liveNodeId ? "Running" : "Ready";

  return (
    <ReactFlowProvider>
      <div className="macro-canvas-frame">
        {doc.nodes.length === 0 && (
          <div className="macro-canvas-empty" aria-hidden="true">
            <div className="macro-canvas-empty-title">No nodes on this macro</div>
            <div className="macro-canvas-empty-copy">
              Create a segment or wait node from the sidebar.
            </div>
          </div>
        )}
        <ReactFlow
          className="macro-canvas-flow"
          nodes={decoratedNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onNodeDragStop={handleNodeDragStop}
          onSelectionChange={handleSelectionChange}
          deleteKeyCode={["Backspace", "Delete"]}
          defaultEdgeOptions={defaultEdgeOptions}
          connectionLineStyle={connectionLineStyle}
          fitView
          fitViewOptions={{ padding: 0.18, minZoom: 0.62, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.25}
            color="rgba(255,255,255,0.16)"
          />
          <Panel className="macro-canvas-panel" position="top-left">
            <span className="macro-canvas-panel-dot" data-state={canvasState} aria-hidden="true" />
            <span className="macro-canvas-panel-strong">{canvasStateLabel}</span>
            <span>
              {doc.nodes.length} node{doc.nodes.length === 1 ? "" : "s"} / {doc.edges.length} link
              {doc.edges.length === 1 ? "" : "s"}
            </span>
          </Panel>
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeBorderRadius={8}
            nodeColor={(node) => (node.type === "wait" ? "#f4dda4" : "#f0cd78")}
            maskColor="rgba(0,0,0,0.62)"
          />
          <Controls position="bottom-left" showInteractive={false} />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}
