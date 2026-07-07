import { useMemo, useState } from "react";
import { type LoopRegion, StudioTimeline } from "@/components/studio/StudioTimeline";
import { eventsInRange, segmentBasis, segmentNodeFromRange } from "@/lib/macro-segment";
import { waitNodeFromTarget } from "@/lib/macro-wait";
import type { MacroNode, PerceptionTarget, Recording } from "@/types";

const DEFAULT_TIMEOUT_S = 10;
const MIN_TIMEOUT_S = 1;

export interface AddNodePanelProps {
  recordings: Recording[];
  onAdd: (node: MacroNode) => void;
}

/** A range currently selected on the Add Segment timeline, in basis-relative ms. */
interface RangeMs {
  start: number;
  end: number;
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
  // Numeric-second text inputs are a separate, freely-editable buffer so the
  // user can type partial values (e.g. "1.") — they're parsed into `rangeMs`
  // (the canonical range) on every change, and re-synced from `rangeMs` when
  // the timeline drag sets it instead.
  const [startS, setStartS] = useState("0");
  const [endS, setEndS] = useState("");
  const [rangeMs, setRangeMs] = useState<RangeMs | null>(null);

  const [expectText, setExpectText] = useState("");
  const [timeoutS, setTimeoutS] = useState(String(DEFAULT_TIMEOUT_S));

  const selected = recordingsWithVideo.find((r) => r.id === recordingId) ?? null;

  const handleRecordingChange = (id: string) => {
    setRecordingId(id);
    setRangeMs(null);
    setStartS("0");
    setEndS("");
  };

  // Parses the start/end second text fields into `rangeMs`, rounding to whole
  // ms and rejecting (→ null, disabling Add) anything out of [0, duration_ms]
  // or with end <= start — mirrors segmentNodeFromRange's own rounding.
  const applyTypedRange = (nextStartS: string, nextEndS: string) => {
    if (!selected?.video) {
      setRangeMs(null);
      return;
    }
    const s = Number(nextStartS);
    const e = Number(nextEndS);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      setRangeMs(null);
      return;
    }
    const startMs = Math.round(s * 1000);
    const endMs = Math.round(e * 1000);
    if (startMs < 0 || endMs <= startMs || endMs > selected.video.duration_ms) {
      setRangeMs(null);
      return;
    }
    setRangeMs({ start: startMs, end: endMs });
  };

  const handleStartChange = (value: string) => {
    setStartS(value);
    applyTypedRange(value, endS);
  };
  const handleEndChange = (value: string) => {
    setEndS(value);
    applyTypedRange(startS, value);
  };

  const handleLoopChange = (loop: LoopRegion | null) => {
    if (loop) {
      // StudioTimeline's msAt() emits fractional ms (clientX/width × dur). Round
      // here so the summary's eventsInRange and segmentNodeFromRange (which rounds
      // internally) filter on identical bounds — otherwise a boundary event could
      // be counted in the summary but excluded from the added node (or vice versa).
      const start = Math.round(loop.a);
      const end = Math.round(loop.b);
      setRangeMs({ start, end });
      setStartS(String(start / 1000));
      setEndS(String(end / 1000));
    } else {
      // StudioTimeline fires onLoopChange(null) on its ✕ clear button and on any
      // plain (non-drag) track click. Reset the numeric buffers too, or they'd
      // keep showing the now-deleted range — breaking the single-source-of-truth
      // invariant (mirrors handleRecordingChange).
      setRangeMs(null);
      setStartS("0");
      setEndS("");
    }
  };

  const segmentValid = selected !== null && rangeMs !== null && rangeMs.end > rangeMs.start;

  const handleAddSegment = () => {
    if (!segmentValid || !selected?.video || !rangeMs) return;
    onAdd(segmentNodeFromRange(selected, rangeMs.start, rangeMs.end));
  };

  const expectValid = expectText.trim().length > 0;
  const timeout = Number(timeoutS);
  const timeoutValid = Number.isFinite(timeout) && timeout >= MIN_TIMEOUT_S;

  const handleAddWait = () => {
    if (!expectValid) return;
    const expect = expectText.trim();
    // Same rounding concern as the segment ms values above.
    const timeoutMs = Math.round((timeoutValid ? timeout : DEFAULT_TIMEOUT_S) * 1000);
    const target: PerceptionTarget = {
      id: crypto.randomUUID(),
      name: expect,
      modality: "visual",
      region: { x: 0, y: 0, w: 1, h: 1 },
      kind: { type: "TextOcr", expect },
      created_at: Date.now(),
    };
    onAdd(waitNodeFromTarget(target, timeoutMs));
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
        .anp-summary { font-size: 11px; color: rgba(255,255,255,0.5); }
      `}</style>

      <div className="anp-section">
        <div className="anp-title">Add Segment</div>
        <select
          aria-label="Recording"
          className="anp-input"
          value={recordingId}
          onChange={(e) => handleRecordingChange(e.target.value)}
        >
          <option value="">Select recording…</option>
          {recordingsWithVideo.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name || r.id}
            </option>
          ))}
        </select>
        {selected?.video && (
          <>
            <StudioTimeline
              events={selected.events}
              startMs={segmentBasis(selected)}
              durationMs={selected.video.duration_ms}
              videoMs={0}
              onSeekSeconds={() => {}}
              loop={rangeMs ? { a: rangeMs.start, b: rangeMs.end } : null}
              onLoopChange={handleLoopChange}
            />
            <div className="anp-summary">
              {rangeMs
                ? `${eventsInRange(selected.events, segmentBasis(selected), rangeMs.start, rangeMs.end).length} events · ${((rangeMs.end - rangeMs.start) / 1000).toFixed(1)}s`
                : "Drag on the timeline to select a range"}
            </div>
          </>
        )}
        <div className="anp-row">
          <input
            aria-label="Start (s)"
            className="anp-input"
            type="number"
            value={startS}
            onChange={(e) => handleStartChange(e.target.value)}
          />
          <input
            aria-label="End (s)"
            className="anp-input"
            type="number"
            value={endS}
            onChange={(e) => handleEndChange(e.target.value)}
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
