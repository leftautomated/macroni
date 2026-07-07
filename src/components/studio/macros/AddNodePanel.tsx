import { useMemo, useState } from "react";
import { segmentNodeFromRange } from "@/lib/macro-segment";
import type { MacroNode, Recording } from "@/types";

const DEFAULT_TIMEOUT_S = 10;
const MIN_TIMEOUT_S = 1;

export interface AddNodePanelProps {
  recordings: Recording[];
  onAdd: (node: MacroNode) => void;
}

/**
 * Sidebar panel for building new macro nodes: "Add Segment" carves a time
 * range out of a recording's captured input events, "Add Text Wait" builds a
 * WaitFor node against a to-be-OCR'd text target. Both forms just collect
 * input and hand a fully-formed MacroNode to `onAdd` — this component never
 * touches the doc or the canvas directly.
 */
export function AddNodePanel({ recordings, onAdd }: AddNodePanelProps) {
  const recordingsWithVideo = useMemo(() => recordings.filter((r) => r.video), [recordings]);

  const [recordingId, setRecordingId] = useState("");
  const [startS, setStartS] = useState("0");
  const [endS, setEndS] = useState("");

  const [expectText, setExpectText] = useState("");
  const [timeoutS, setTimeoutS] = useState(String(DEFAULT_TIMEOUT_S));

  const selected = recordingsWithVideo.find((r) => r.id === recordingId) ?? null;
  const duration = selected?.video ? selected.video.duration_ms / 1000 : 0;

  const start = Number(startS);
  const end = Number(endS);
  const segmentValid =
    selected !== null &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end > start &&
    end <= duration;

  const handleAddSegment = () => {
    if (!segmentValid || !selected?.video) return;
    onAdd(segmentNodeFromRange(selected, start * 1000, end * 1000));
  };

  const expectValid = expectText.trim().length > 0;
  const timeout = Number(timeoutS);
  const timeoutValid = Number.isFinite(timeout) && timeout >= MIN_TIMEOUT_S;

  const handleAddWait = () => {
    if (!expectValid) return;
    const expect = expectText.trim();
    // Same rounding concern as the segment ms values above.
    const timeoutMs = Math.round((timeoutValid ? timeout : DEFAULT_TIMEOUT_S) * 1000);
    onAdd({
      id: crypto.randomUUID(),
      kind: {
        type: "WaitFor",
        target: {
          id: crypto.randomUUID(),
          name: expect,
          modality: "visual",
          region: { x: 0, y: 0, w: 1, h: 1 },
          kind: { type: "TextOcr", expect },
          created_at: Date.now(),
        },
        timeout_ms: timeoutMs,
        poll_interval_ms: 500,
      },
      x: 40,
      y: 160,
    });
  };

  return (
    <div className="anp-root">
      <style>{`
        .anp-root { display: flex; flex-direction: column; gap: 16px; font-family: system-ui, -apple-system, sans-serif; }
        .anp-section { display: flex; flex-direction: column; gap: 8px; }
        .anp-title { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.85); }
        .anp-row { display: flex; gap: 6px; }
        .anp-input {
          width: 100%;
          box-sizing: border-box;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 6px;
          padding: 6px 8px;
          color: #e5e7eb;
          font-size: 12px;
        }
        .anp-input:focus { outline: none; border-color: #6366f1; }
        .anp-add {
          border: 1px solid rgba(99,102,241,0.5); background: rgba(99,102,241,0.28);
          color: #fff; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: background 120ms ease;
        }
        .anp-add:hover:not(:disabled) { background: rgba(99,102,241,0.4); }
        .anp-add:disabled { opacity: 0.4; cursor: default; }
      `}</style>

      <div className="anp-section">
        <div className="anp-title">Add Segment</div>
        <select
          aria-label="Recording"
          className="anp-input"
          value={recordingId}
          onChange={(e) => setRecordingId(e.target.value)}
        >
          <option value="">Select recording…</option>
          {recordingsWithVideo.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name || r.id}
            </option>
          ))}
        </select>
        <div className="anp-row">
          <input
            aria-label="Start (s)"
            className="anp-input"
            type="number"
            value={startS}
            onChange={(e) => setStartS(e.target.value)}
          />
          <input
            aria-label="End (s)"
            className="anp-input"
            type="number"
            value={endS}
            onChange={(e) => setEndS(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="anp-add"
          disabled={!segmentValid}
          onClick={handleAddSegment}
        >
          Add Segment
        </button>
      </div>

      <div className="anp-section">
        <div className="anp-title">Add Text Wait</div>
        <input
          aria-label="Expected text"
          className="anp-input"
          value={expectText}
          onChange={(e) => setExpectText(e.target.value)}
          placeholder="Expected text"
        />
        <input
          aria-label="Timeout (s)"
          className="anp-input"
          type="number"
          value={timeoutS}
          onChange={(e) => setTimeoutS(e.target.value)}
        />
        <button type="button" className="anp-add" disabled={!expectValid} onClick={handleAddWait}>
          Add Text Wait
        </button>
      </div>
    </div>
  );
}
