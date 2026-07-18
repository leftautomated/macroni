import type { CSSProperties } from "react";
import { MousePointer2 } from "lucide-react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { nodeSummary } from "@/lib/macro-flow";
import type { MacroNode, MacroNodeKind } from "@/types";

const ACCENT = "var(--macro-accent)";

function segmentDurationLabel(kind: Extract<MacroNodeKind, { type: "Segment" }>): string {
  if (kind.provenance) {
    return `${((kind.provenance.end_ms - kind.provenance.start_ms) / 1000).toFixed(1)}s`;
  }
  if (kind.events.length < 2) return "0s";
  const first = kind.events[0];
  const last = kind.events[kind.events.length - 1];
  return `${Math.round(((last.timestamp - first.timestamp) / 1000) * 10) / 10}s`;
}

/** Custom react-flow node for a `Segment` macro node — a recorded input clip. */
export function SegmentNodeView({ data }: NodeProps) {
  const node = data.node as MacroNode;
  if (node.kind.type !== "Segment") return null;

  const live = Boolean(data.live);
  const failed = Boolean(data.failed);
  const stateLabel = failed ? "Failed" : live ? "Live" : "Segment";
  const duration = segmentDurationLabel(node.kind);
  const recording = node.kind.provenance?.recording_id ?? "manual";
  const speed = `${node.kind.speed}x`;

  return (
    <div
      className={`macro-node macro-node--segment${live ? " macro-node--live" : ""}${
        failed ? " macro-node--failed" : ""
      }`}
      style={{ "--macro-node-accent": ACCENT } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="macro-node-handle" />
      <div className="macro-node-body">
        <div className="macro-node-head">
          <div className="macro-node-type">
            <MousePointer2 aria-hidden="true" />
            Segment
          </div>
          <div className="macro-node-badge" data-state={failed ? "failed" : undefined}>
            {stateLabel}
          </div>
        </div>
        <div className="macro-node-summary">{nodeSummary(node)}</div>
        <div className="macro-node-meta">
          <span className="macro-node-chip">
            <strong>{node.kind.events.length}</strong> events
          </span>
          <span className="macro-node-chip">
            <strong>{duration}</strong>
          </span>
          <span className="macro-node-chip">
            <strong>{speed}</strong>
          </span>
          <span className="macro-node-chip" title={recording}>
            {recording}
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="macro-node-handle" />
    </div>
  );
}
