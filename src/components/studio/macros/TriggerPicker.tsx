import type { TextSpan } from "@/types";

export interface TriggerPickerProps {
  /** null = OCR in flight (show scanning state, no boxes yet). */
  spans: TextSpan[] | null;
  onPickSpan: (span: TextSpan) => void;
  onCancel: () => void;
}

/**
 * Overlay for the paused authoring frame: clickable boxes over OCR-detected
 * text spans. The root is pointer-transparent so the player's drag-to-select
 * (image/color trigger authoring) still works underneath; only the boxes and
 * the hint/cancel chip catch the pointer.
 */
export function TriggerPicker({ spans, onPickSpan, onCancel }: TriggerPickerProps) {
  return (
    <div className="tp-root" data-scanning={spans === null || undefined}>
      {spans?.map((span, i) => (
        <button
          key={`${span.text}-${i}`}
          type="button"
          className="tp-span"
          style={{
            left: `${span.region.x * 100}%`,
            top: `${span.region.y * 100}%`,
            width: `${span.region.w * 100}%`,
            height: `${span.region.h * 100}%`,
          }}
          title={span.text}
          aria-label={`Use text "${span.text}" as the trigger`}
          onClick={() => onPickSpan(span)}
        />
      ))}
      <div className="tp-chip">
        {spans === null ? (
          <span>Scanning frame for text…</span>
        ) : spans.length === 0 ? (
          <span>No text found — drag a box on the frame for an image or color trigger</span>
        ) : (
          <span>Click text to use it as the trigger, or drag a box</span>
        )}
        <button type="button" className="tp-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
