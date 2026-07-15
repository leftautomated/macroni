import { useEffect, useMemo, useRef, useState } from "react";
import { Film, ImagePlus, Plus, ScanText } from "lucide-react";
import type { LoopRegion } from "@/components/studio/StudioTimeline";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { eventsInRange, segmentBasis, segmentNodeFromRange } from "@/lib/macro-segment";
import { waitNodeFromTarget } from "@/lib/macro-wait";
import type { MacroNode, PerceptionTarget, Recording } from "@/types";

const DEFAULT_TIMEOUT_S = 10;
const MIN_TIMEOUT_S = 1;

export interface AddNodePanelProps {
  recordings: Recording[];
  /** Shared authoring context, owned by MacroEditor. */
  selectedRecordingId: string;
  onSelectRecording: (id: string) => void;
  /** Segment range from the dock timeline, video-relative ms, or null. */
  range: LoopRegion | null;
  onRangeChange: (range: LoopRegion | null) => void;
  onAdd: (node: MacroNode) => void;
}

function fmtS(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function sameRange(x: LoopRegion | null, y: LoopRegion | null): boolean {
  return x === y || (!!x && !!y && x.a === y.a && x.b === y.b);
}

/**
 * Sidebar forms for building macro nodes. Fully controlled: the recording
 * selection and segment range live in MacroEditor (shared with the
 * AuthoringDock, where the actual timeline/frame dragging happens); this
 * component only collects form input and hands fully-formed MacroNodes to
 * `onAdd`.
 */
export function AddNodePanel({
  recordings,
  selectedRecordingId,
  onSelectRecording,
  range,
  onRangeChange,
  onAdd,
}: AddNodePanelProps) {
  const recordingsWithVideo = useMemo(() => recordings.filter((r) => r.video), [recordings]);
  const selected = recordingsWithVideo.find((r) => r.id === selectedRecordingId) ?? null;

  // Numeric-second text inputs are a separate, freely-editable buffer so the
  // user can type partial values (e.g. "1.") — parsed into the shared range
  // on every change, and re-synced from it when a dock drag sets it instead.
  const [startS, setStartS] = useState("0");
  const [endS, setEndS] = useState("");
  // Range values this component itself just emitted from typing. The sync
  // effect skips those echoes so it never clobbers a buffer mid-keystroke;
  // anything else (dock drags, chip clear, recording switch) re-syncs.
  const lastTyped = useRef<LoopRegion | null | undefined>(undefined);

  useEffect(() => {
    const echo = lastTyped.current !== undefined && sameRange(lastTyped.current, range);
    lastTyped.current = undefined;
    if (echo) return;
    if (range) {
      setStartS(String(range.a / 1000));
      setEndS(String(range.b / 1000));
    } else {
      setStartS("0");
      setEndS("");
    }
  }, [range]);

  const [expectText, setExpectText] = useState("");
  const [timeoutS, setTimeoutS] = useState(String(DEFAULT_TIMEOUT_S));

  const handleRecordingChange = (id: string) => {
    // MacroEditor resets the shared range on switch; reset the local buffers
    // here too, since a null→null range transition won't re-run the sync.
    setStartS("0");
    setEndS("");
    onSelectRecording(id);
  };

  // Parses the start/end second text fields into the shared range, rounding
  // to whole ms and rejecting (→ null, disabling Add) anything out of
  // [0, duration_ms] or with end <= start — mirrors segmentNodeFromRange's
  // own rounding.
  const applyTypedRange = (nextStartS: string, nextEndS: string) => {
    let next: LoopRegion | null = null;
    if (selected?.video) {
      const s = Number(nextStartS);
      const e = Number(nextEndS);
      if (Number.isFinite(s) && Number.isFinite(e)) {
        const a = Math.round(s * 1000);
        const b = Math.round(e * 1000);
        if (a >= 0 && b > a && b <= selected.video.duration_ms) next = { a, b };
      }
    }
    lastTyped.current = next;
    onRangeChange(next);
  };

  const handleStartChange = (value: string) => {
    setStartS(value);
    applyTypedRange(value, endS);
  };
  const handleEndChange = (value: string) => {
    setEndS(value);
    applyTypedRange(startS, value);
  };

  const segmentValid = selected !== null && range !== null && range.b > range.a;

  const handleAddSegment = () => {
    if (!segmentValid || !selected?.video || !range) return;
    onAdd(segmentNodeFromRange(selected, range.a, range.b));
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
      <div className="anp-field">
        <span className="anp-label">Recording</span>
        <Select value={selectedRecordingId} onValueChange={handleRecordingChange}>
          <SelectTrigger
            aria-label="Recording"
            className="h-8 focus:ring-0 focus:ring-offset-0 focus-visible:ring-2"
          >
            <SelectValue placeholder="Select recording..." />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {recordingsWithVideo.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name || r.id}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="anp-section">
        <div className="anp-title">
          <Film aria-hidden="true" />
          Add Segment
        </div>
        {/* The dock's timeline carries its own "drag to select a range"
            hint — no need to repeat it here; the chip appears once a range
            exists. */}
        {selected ? (
          range && (
            <div className="anp-chip">
              <span>
                {fmtS(range.a)}–{fmtS(range.b)} ·{" "}
                {eventsInRange(selected.events, segmentBasis(selected), range.a, range.b).length}{" "}
                events
              </span>
              <button
                type="button"
                className="anp-chip-clear"
                aria-label="Clear range"
                onClick={() => onRangeChange(null)}
              >
                ✕
              </button>
            </div>
          )
        ) : (
          <div className="anp-summary">Pick a recording above to carve a segment</div>
        )}
        <div className="anp-field-grid">
          <label className="anp-field" htmlFor="anp-start-input">
            <span className="anp-label">Start (s)</span>
            <Input
              id="anp-start-input"
              aria-label="Start (s)"
              className="h-8"
              type="number"
              value={startS}
              onChange={(e) => handleStartChange(e.target.value)}
            />
          </label>
          <label className="anp-field" htmlFor="anp-end-input">
            <span className="anp-label">End (s)</span>
            <Input
              id="anp-end-input"
              aria-label="End (s)"
              className="h-8"
              type="number"
              value={endS}
              onChange={(e) => handleEndChange(e.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          className="anp-add"
          disabled={!segmentValid}
          onClick={handleAddSegment}
        >
          <Plus aria-hidden="true" />
          Add Segment
        </button>
      </div>

      <div className="anp-section">
        <div className="anp-title">
          <ScanText aria-hidden="true" />
          Add Text Wait
        </div>
        <label className="anp-field" htmlFor="anp-expect-input">
          <span className="anp-label">Expected text</span>
          <Input
            id="anp-expect-input"
            aria-label="Expected text"
            className="h-8"
            value={expectText}
            onChange={(e) => setExpectText(e.target.value)}
            placeholder="Expected text"
          />
        </label>
        <label className="anp-field" htmlFor="anp-timeout-input">
          <span className="anp-label">Timeout (s)</span>
          <Input
            id="anp-timeout-input"
            aria-label="Timeout (s)"
            className="h-8"
            type="number"
            value={timeoutS}
            onChange={(e) => setTimeoutS(e.target.value)}
          />
        </label>
        <button type="button" className="anp-add" disabled={!expectValid} onClick={handleAddWait}>
          <Plus aria-hidden="true" />
          Add Text Wait
        </button>
      </div>

      <div className="anp-footnote">
        <ImagePlus aria-hidden="true" />
        <span>Image or color waits: drag a box on the video frame in the dock below.</span>
      </div>
    </div>
  );
}
