import type { CSSProperties } from "react";
import { Image, Pipette, ScanText, Timer } from "lucide-react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { MacroNode, TargetKind } from "@/types";

const ACCENT = "var(--macro-accent-text)";

function targetLabel(kind: TargetKind): string {
  if (kind.type === "TextOcr") return "Text";
  if (kind.type === "TemplateMatch") return "Image";
  return "Color";
}

function targetDetail(kind: TargetKind): string {
  if (kind.type === "TextOcr") return kind.expect?.trim() || "any text";
  if (kind.type === "TemplateMatch") return `${Math.round(kind.threshold * 100)}% match`;
  return `rgb(${kind.rgb.join(", ")})`;
}

function targetIcon(kind: TargetKind) {
  if (kind.type === "TextOcr") return ScanText;
  if (kind.type === "TemplateMatch") return Image;
  return Pipette;
}

/** Custom react-flow node for a `WaitFor` macro node — pauses for a perception target. */
export function WaitNodeView({ data }: NodeProps) {
  const node = data.node as MacroNode;
  if (node.kind.type !== "WaitFor") return null;

  const live = Boolean(data.live);
  const failed = Boolean(data.failed);
  const stateLabel = failed ? "Failed" : live ? "Live" : null;
  const TargetIcon = targetIcon(node.kind.target.kind);
  const timeoutS = node.kind.timeout_ms / 1000;

  return (
    <div
      className={`macro-node macro-node--wait${live ? " macro-node--live" : ""}${
        failed ? " macro-node--failed" : ""
      }`}
      style={{ "--macro-node-accent": ACCENT } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} className="macro-node-handle" />
      <div className="macro-node-body">
        <div className="macro-node-head">
          <div className="macro-node-type">
            <TargetIcon aria-hidden="true" />
            Wait
          </div>
          {stateLabel && (
            <div className="macro-node-badge" data-state={failed ? "failed" : undefined}>
              {stateLabel}
            </div>
          )}
        </div>
        <div className="macro-node-meta">
          <span className="macro-node-chip">
            <strong>{targetLabel(node.kind.target.kind)}</strong>
          </span>
          <span className="macro-node-chip" title={targetDetail(node.kind.target.kind)}>
            {targetDetail(node.kind.target.kind)}
          </span>
          <span className="macro-node-chip">
            <Timer aria-hidden="true" /> <strong>{timeoutS}s</strong>
          </span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="macro-node-handle" />
    </div>
  );
}
