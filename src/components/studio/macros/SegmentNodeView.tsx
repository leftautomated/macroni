import { Handle, Position, type NodeProps } from "@xyflow/react";
import { nodeSummary } from "@/lib/macro-flow";
import type { MacroNode } from "@/types";

const ACCENT = "#6366f1";
const FAILED = "#f87171";

/** Custom react-flow node for a `Segment` macro node — a recorded input clip. */
export function SegmentNodeView({ data }: NodeProps) {
  const node = data.node as MacroNode;
  const live = Boolean(data.live);
  const failed = Boolean(data.failed);
  const borderColor = failed ? FAILED : live ? ACCENT : "rgba(255,255,255,0.14)";

  return (
    <div
      style={{
        minWidth: 170,
        padding: "10px 14px",
        borderRadius: 10,
        background: "#16161d",
        border: `1.5px solid ${borderColor}`,
        boxShadow: failed
          ? `0 0 0 3px ${FAILED}33`
          : live
            ? `0 0 0 3px ${ACCENT}33, 0 0 14px ${ACCENT}66`
            : "none",
        color: "#e5e7eb",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 12,
        animation: live ? "macro-segment-pulse 1.6s ease-in-out infinite" : "none",
        transition: "border-color 150ms ease, box-shadow 150ms ease",
      }}
    >
      {live && (
        <style>{`
          @keyframes macro-segment-pulse {
            0%, 100% { box-shadow: 0 0 0 3px ${ACCENT}33, 0 0 14px ${ACCENT}66; }
            50% { box-shadow: 0 0 0 5px ${ACCENT}55, 0 0 24px ${ACCENT}aa; }
          }
        `}</style>
      )}
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: ACCENT, width: 8, height: 8, border: "none" }}
      />
      <div style={{ fontWeight: 600, marginBottom: 4, color: ACCENT }}>Segment</div>
      <div style={{ opacity: 0.85 }}>{nodeSummary(node)}</div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: ACCENT, width: 8, height: 8, border: "none" }}
      />
    </div>
  );
}
