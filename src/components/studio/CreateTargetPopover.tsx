import { useState } from "react";
import type { Region, TargetKind } from "@/types";

export type KindOption = "Text" | "Image" | "Color";

const KIND_OPTIONS: KindOption[] = ["Text", "Image", "Color"];

interface CreateTargetPopoverProps {
  /** The dragged selection (fractional 0..1 against the video frame). */
  region: Region;
  /** Fixed-position anchor in viewport (client) coordinates — the pointer-up point. */
  anchor: { x: number; y: number };
  defaultName?: string;
  /** Which kind buttons to offer — defaults to all three. Callers that only
   * want a subset (e.g. macro Visual Wait authoring, which has its own Text
   * form) pass a narrower list. */
  kinds?: KindOption[];
  onSave: (name: string, kind: TargetKind) => void;
  onCancel: () => void;
}

function buildKind(kind: KindOption, expectText: string): TargetKind {
  switch (kind) {
    case "Text":
      return { type: "TextOcr", expect: expectText.trim() ? expectText.trim() : null };
    case "Image":
      return { type: "TemplateMatch", image: "", threshold: 0.8, source_px: [0, 0] };
    case "Color":
      return { type: "ColorSample", rgb: [0, 0, 0], tolerance: 10 };
  }
}

/**
 * Small fixed-position card that appears where the user releases a
 * drag-to-select on the video: name the target, pick what kind of perception
 * it is (Text/Image/Color), and save. The parent owns the pending region and
 * combines it with this card's `(name, kind)` to build the full target —
 * this component never sees the backend, it just collects input.
 */
export function CreateTargetPopover({
  region,
  anchor,
  defaultName = "Target 1",
  kinds = KIND_OPTIONS,
  onSave,
  onCancel,
}: CreateTargetPopoverProps) {
  const [name, setName] = useState(defaultName);
  const [kind, setKind] = useState<KindOption>(kinds[0] ?? "Text");
  const [expectText, setExpectText] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = () => {
    if (saving) return;
    setSaving(true);
    onSave(name, buildKind(kind, expectText));
  };

  return (
    <div
      className="ctp-root"
      style={{ position: "fixed", left: anchor.x, top: anchor.y, zIndex: 200 }}
    >
      <style>{`
        .ctp-root {
          width: 220px;
          background: var(--studio-surface);
          border: 1px solid var(--studio-border);
          border-radius: 10px;
          box-shadow: 0 16px 40px rgb(0 0 0 / 28%);
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          font-size: 12px;
          color: var(--studio-text);
        }
        .ctp-meta { font-size: 11px; color: var(--studio-text-subtle); }
        .ctp-input {
          width: 100%;
          box-sizing: border-box;
          background: var(--studio-control);
          border: 1px solid var(--studio-border-strong);
          border-radius: 6px;
          padding: 6px 8px;
          color: var(--studio-text);
          font-size: 12px;
        }
        .ctp-input:focus { outline: none; border-color: var(--studio-accent); }
        .ctp-kinds { display: flex; gap: 4px; }
        .ctp-kind {
          flex: 1;
          border: 1px solid var(--studio-border-strong);
          background: transparent;
          color: var(--studio-text-muted);
          border-radius: 6px;
          padding: 6px 0;
          font-size: 12px;
          cursor: pointer;
          transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .ctp-kind:hover { background: var(--studio-hover); }
        .ctp-kind.sel { border-color: var(--studio-accent-border); background: var(--studio-accent-soft); color: var(--studio-accent); }
        .ctp-actions { display: flex; justify-content: flex-end; gap: 6px; }
        .ctp-cancel {
          border: none; background: transparent; color: var(--studio-text-muted);
          border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer;
        }
        .ctp-cancel:hover { background: var(--studio-hover); color: var(--studio-text); }
        .ctp-save {
          border: 1px solid var(--studio-accent-border); background: var(--studio-accent-soft);
          color: var(--studio-accent); border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: background 120ms ease;
        }
        .ctp-save:hover { background: color-mix(in oklch, var(--studio-accent) 20%, transparent); }
        .ctp-save:disabled { opacity: 0.6; cursor: default; }
      `}</style>

      <div className="ctp-meta">
        {Math.round(region.w * 100)}% × {Math.round(region.h * 100)}% selection
      </div>

      <input
        className="ctp-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Target name"
        aria-label="Target name"
      />

      <div className="ctp-kinds">
        {kinds.map((option) => (
          <button
            key={option}
            type="button"
            className={`ctp-kind${kind === option ? " sel" : ""}`}
            onClick={() => setKind(option)}
          >
            {option}
          </button>
        ))}
      </div>

      {kind === "Text" && (
        <input
          className="ctp-input"
          value={expectText}
          onChange={(e) => setExpectText(e.target.value)}
          placeholder="Expected text (optional)"
          aria-label="Expected text"
        />
      )}

      <div className="ctp-actions">
        <button type="button" className="ctp-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ctp-save" onClick={handleSave} disabled={saving}>
          Save
        </button>
      </div>
    </div>
  );
}
