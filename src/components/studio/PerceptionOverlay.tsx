import type { Rect } from "@/lib/video-rect";
import type { PerceptionTarget, TextSpan } from "@/types";

interface PerceptionOverlayProps {
  /** Displayed (contain-fit) rect of the video, in container-relative px. */
  rect: Rect;
  targets: PerceptionTarget[];
  spans: TextSpan[];
}

/**
 * Read-only layer drawn over the video at its displayed rect: perception
 * targets (indigo boxes, name label chip) and OCR text spans (thin sky-blue
 * boxes). Region coordinates are fractional (0..1) against the video frame,
 * so they're scaled to `rect.width`/`rect.height` in px here. Purely
 * presentational — `pointerEvents: "none"` so it never intercepts clicks;
 * drag-to-select interaction lands in a later task.
 */
export function PerceptionOverlay({ rect, targets, spans }: PerceptionOverlayProps) {
  return (
    <div
      style={{
        position: "absolute",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: "none",
      }}
    >
      {targets.map((target) => {
        const region = target.region;
        if (!region) return null;
        return (
          <div
            key={target.id}
            style={{
              position: "absolute",
              left: region.x * rect.width,
              top: region.y * rect.height,
              width: region.w * rect.width,
              height: region.h * rect.height,
              boxSizing: "border-box",
              border: "1.5px solid #6366f1",
            }}
          >
            <span
              style={{
                position: "absolute",
                left: -1.5,
                top: -18,
                padding: "1px 6px",
                whiteSpace: "nowrap",
                fontSize: 11,
                fontWeight: 600,
                lineHeight: "16px",
                color: "#fff",
                background: "#6366f1",
                borderRadius: "3px 3px 0 0",
              }}
            >
              {target.name}
            </span>
          </div>
        );
      })}
      {spans.map((span, i) => (
        <div
          key={i}
          title={span.text}
          style={{
            position: "absolute",
            left: span.region.x * rect.width,
            top: span.region.y * rect.height,
            width: span.region.w * rect.width,
            height: span.region.h * rect.height,
            boxSizing: "border-box",
            border: "1px solid #38bdf8",
          }}
        />
      ))}
    </div>
  );
}
