import { useCallback, useMemo, useState } from "react";
import { Film, ImagePlus, Plus, ScanText } from "lucide-react";
import type { KindOption } from "@/components/studio/CreateTargetPopover";
import { StudioPlayer } from "@/components/studio/StudioPlayer";
import { type LoopRegion, StudioTimeline } from "@/components/studio/StudioTimeline";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useVideoAssetUrl } from "@/hooks/useVideoAssetUrl";
import { eventsInRange, segmentBasis, segmentNodeFromRange } from "@/lib/macro-segment";
import { waitNodeFromTarget } from "@/lib/macro-wait";
import type { MacroNode, PerceptionTarget, Recording, Region } from "@/types";

const DEFAULT_TIMEOUT_S = 10;
const MIN_TIMEOUT_S = 1;

// Visual Wait authoring has its own dedicated Text form (Add Text Wait,
// above) — scope the embedded player's popover to Image/Color only so the
// two Text paths don't overlap.
const VISUAL_WAIT_KINDS: KindOption[] = ["Image", "Color"];

const noop = () => {};

export interface AddNodePanelProps {
  recordings: Recording[];
  onAdd: (node: MacroNode) => void;
  /**
   * Persist a newly authored TemplateMatch target (invokes `save_target` to
   * crop + write the reference PNG) and return the target with its rewritten
   * `image` path. Only called for Image targets — Color targets need no
   * capture. Provided by MacroEditor; rethrows on failure (surfaced via its
   * banner) so no node is added.
   */
  captureImageWait?: (
    recordingId: string,
    target: PerceptionTarget,
    timestampMs: number,
  ) => Promise<PerceptionTarget>;
  /** Sample the average color of a region at a given playhead (invokes
   * `extract_region`), for the embedded player's Color authoring path. */
  sampleColor?: (
    recordingId: string,
    region: Region,
    timestampMs: number,
  ) => Promise<[number, number, number]>;
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
export function AddNodePanel({
  recordings,
  onAdd,
  captureImageWait,
  sampleColor,
}: AddNodePanelProps) {
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
  // Reused by the embedded Visual Wait player — src stays "" until it
  // resolves; StudioPlayer already renders its own "Loading…" state for that.
  const { url: videoUrl } = useVideoAssetUrl(selected?.video);

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

  // Fed to the embedded player's `onSaveTarget` — fires once the user finishes
  // dragging a box and saving it via CreateTargetPopover (scoped to Image/
  // Color below). Image targets need a capture round-trip first (save_target
  // crops + writes the reference PNG and returns the target with its
  // rewritten `image` path); Color targets already carry their sampled rgb
  // and are wrapped as-is. A captureImageWait rejection propagates out of
  // this handler (and StudioPlayer's own try/catch just logs + closes the
  // popover) — no node is added, matching every other error path here.
  const handleVisualTarget = useCallback(
    async (target: PerceptionTarget, timestampMs: number) => {
      if (!selected) return;
      if (target.kind.type === "TemplateMatch" && captureImageWait) {
        const captured = await captureImageWait(selected.id, target, timestampMs);
        onAdd(waitNodeFromTarget(captured));
      } else {
        onAdd(waitNodeFromTarget(target));
      }
    },
    [selected, captureImageWait, onAdd],
  );

  const handleSampleColor = useCallback(
    async (region: Region, timestampMs: number): Promise<[number, number, number]> => {
      if (!selected || !sampleColor) return [0, 0, 0];
      return sampleColor(selected.id, region, timestampMs);
    },
    [selected, sampleColor],
  );

  return (
    <div className="anp-root">
      <div className="anp-section">
        <div className="anp-title">
          <Film aria-hidden="true" />
          Add Segment
        </div>
        <div className="anp-field">
          <span className="anp-label">Recording</span>
          <Select value={recordingId} onValueChange={handleRecordingChange}>
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
        <div className="anp-field-grid">
          <label className="anp-field">
            <span className="anp-label">Start (s)</span>
            <input
              aria-label="Start (s)"
              className="anp-input"
              type="number"
              value={startS}
              onChange={(e) => handleStartChange(e.target.value)}
            />
          </label>
          <label className="anp-field">
            <span className="anp-label">End (s)</span>
            <input
              aria-label="End (s)"
              className="anp-input"
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
        <label className="anp-field">
          <span className="anp-label">Expected text</span>
          <input
            aria-label="Expected text"
            className="anp-input"
            value={expectText}
            onChange={(e) => setExpectText(e.target.value)}
            placeholder="Expected text"
          />
        </label>
        <label className="anp-field">
          <span className="anp-label">Timeout (s)</span>
          <input
            aria-label="Timeout (s)"
            className="anp-input"
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

      <div className="anp-section">
        <div className="anp-title">
          <ImagePlus aria-hidden="true" />
          Add Visual Wait
        </div>
        {selected?.video ? (
          <div className="anp-video-well">
            <StudioPlayer
              src={videoUrl ?? ""}
              fps={selected.video.fps}
              onTimeUpdate={noop}
              onReplay={noop}
              onSaveTarget={handleVisualTarget}
              onSampleColor={handleSampleColor}
              popoverKinds={VISUAL_WAIT_KINDS}
            />
          </div>
        ) : (
          <div className="anp-summary">
            Select a recording above, then drag a box on the frame to add an image or color wait.
          </div>
        )}
      </div>
    </div>
  );
}
