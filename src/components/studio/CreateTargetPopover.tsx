import { useState } from "react";
import type { Region, TargetKind } from "@/types";

type KindOption = "Text" | "Image" | "Color";

const KIND_OPTIONS: KindOption[] = ["Text", "Image", "Color"];

interface CreateTargetPopoverProps {
  /** The dragged selection (fractional 0..1 against the video frame). */
  region: Region;
  /** Fixed-position anchor in viewport (client) coordinates — the pointer-up point. */
  anchor: { x: number; y: number };
  defaultName?: string;
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
  onSave,
  onCancel,
}: CreateTargetPopoverProps) {
  const [name, setName] = useState(defaultName);
  const [kind, setKind] = useState<KindOption>("Text");
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
          background: #1c1c24;
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px;
          box-shadow: 0 16px 40px rgba(0,0,0,0.5);
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          font-size: 12px;
          color: #e5e7eb;
        }
        .ctp-meta { font-size: 11px; color: rgba(255,255,255,0.45); }
        .ctp-input {
          width: 100%;
          box-sizing: border-box;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 6px;
          padding: 6px 8px;
          color: #e5e7eb;
          font-size: 12px;
        }
        .ctp-input:focus { outline: none; border-color: #6366f1; }
        .ctp-kinds { display: flex; gap: 4px; }
        .ctp-kind {
          flex: 1;
          border: 1px solid rgba(255,255,255,0.12);
          background: transparent;
          color: rgba(255,255,255,0.7);
          border-radius: 6px;
          padding: 6px 0;
          font-size: 12px;
          cursor: pointer;
          transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .ctp-kind:hover { background: rgba(255,255,255,0.06); }
        .ctp-kind.sel { border-color: #6366f1; background: rgba(99,102,241,0.22); color: #fff; }
        .ctp-actions { display: flex; justify-content: flex-end; gap: 6px; }
        .ctp-cancel {
          border: none; background: transparent; color: rgba(255,255,255,0.6);
          border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer;
        }
        .ctp-cancel:hover { background: rgba(255,255,255,0.08); color: #fff; }
        .ctp-save {
          border: 1px solid rgba(99,102,241,0.5); background: rgba(99,102,241,0.28);
          color: #fff; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: background 120ms ease;
        }
        .ctp-save:hover { background: rgba(99,102,241,0.4); }
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
        {KIND_OPTIONS.map((option) => (
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
