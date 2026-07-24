import { type ReactNode, useEffect, useRef, useState } from "react";
import { Frame, Workflow } from "lucide-react";
import type { KindOption } from "@/components/studio/CreateTargetPopover";
import { StudioPlayer, type StudioPlayerHandle } from "@/components/studio/StudioPlayer";
import { type LoopRegion, StudioTimeline } from "@/components/studio/StudioTimeline";
import { useVideoAssetUrl } from "@/hooks/useVideoAssetUrl";
import { eventsInRange, segmentBasis } from "@/lib/macro-segment";
import { fmtMmSs } from "@/lib/time-format";
import type { PerceptionTarget, Recording, Region } from "@/types";

// Visual Wait authoring in the dock is Image/Color only — Text waits have
// their own dedicated sidebar form (mirrors the old embedded-player scoping).
const DOCK_POPOVER_KINDS: KindOption[] = ["Image", "Color"];

const noop = () => {};

export interface AuthoringDockProps {
  /** Selected recording; callers only render the dock when `video` is set. */
  recording: Recording;
  /** Shared segment range, video-relative ms (integers). */
  range: LoopRegion | null;
  /** Fires with whole-ms values (rounded here) or null on clear. */
  onRangeChange: (range: LoopRegion | null) => void;
  /** Build + add a Segment node from the current shared range. */
  onAddSegment: () => void;
  onSaveTarget: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
  onSampleColor: (region: Region, timestampMs: number) => Promise<[number, number, number]>;
  /** Macro graph rendered over the video. Omit when the dock is used standalone. */
  canvasOverlay?: ReactNode;
}

/**
 * Bottom authoring dock for the macro editor: the real StudioPlayer and
 * StudioTimeline, with the macro canvas sharing the player's stage when an
 * overlay is supplied. Canvas mode owns stage gestures; Frame mode hands them
 * to the player for playback and visual-target selection.
 * Segments come from dragging on the timeline OR marking In/Out at the
 * playhead (I/O keys or the clip-row buttons); either way the shared range
 * loop-previews on the player. Enter adds the segment, Escape clears.
 * Dragging a box on the frame authors an Image/Color wait through the
 * player's existing popover flow.
 */
export function AuthoringDock({
  recording,
  range,
  onRangeChange,
  onAddSegment,
  onSaveTarget,
  onSampleColor,
  canvasOverlay,
}: AuthoringDockProps) {
  const playerRef = useRef<StudioPlayerHandle>(null);
  const [videoS, setVideoS] = useState(0);
  // The player's transport bar renders into the timeline column (same
  // controlsHost pattern as StudioEditor), so the video fills the left pane
  // and scrub/transport/timeline stack together on the right.
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null);
  const [interactionMode, setInteractionMode] = useState<"canvas" | "frame">("canvas");
  const { url } = useVideoAssetUrl(recording.video);

  const durationMs = recording.video?.duration_ms ?? 0;

  // Marks always emit a complete, valid range (b > a, whole ms): a lone In
  // runs to the end of the video, a lone Out starts at 0, and a mark that
  // would produce an empty range no-ops.
  const markIn = () => {
    const p = Math.round(videoS * 1000);
    const b = range && range.b > p ? range.b : durationMs;
    if (b > p) onRangeChange({ a: p, b });
  };
  const markOut = () => {
    const p = Math.round(videoS * 1000);
    const a = range && range.a < p ? range.a : 0;
    if (p > a) onRangeChange({ a, b: p });
  };

  // I/O/Enter/Escape while the dock is open. The window listener is bound
  // once; the ref indirection lets it read the latest playhead/range without
  // re-binding on every onTimeUpdate tick. Form fields and modifier chords
  // are ignored so typing in the sidebar (or app shortcuts) never marks, and
  // Enter/Escape are only claimed when they act.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(noop);
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.repeat) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    ) {
      return;
    }
    if (e.key === "i" || e.key === "I") {
      markIn();
    } else if (e.key === "o" || e.key === "O") {
      markOut();
    } else if (e.key === "Enter" || e.key === "Escape") {
      // Enter/Escape must never steal activation from a focused control —
      // a focused button keeps its native Enter, an open Radix listbox
      // keeps its option selection. I/O marking deliberately still works
      // with a button focused (mark, then keep marking).
      if (t instanceof HTMLElement && t.closest("button, [role='option']")) return;
      if (e.key === "Enter" && range && range.b > range.a) {
        e.preventDefault();
        onAddSegment();
      } else if (e.key === "Escape" && range) {
        e.preventDefault();
        onRangeChange(null);
      }
    }
  };
  useEffect(() => {
    const listen = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, []);

  return (
    <div className="adock-root">
      <div className="adock-stage" data-interaction-mode={interactionMode}>
        <div className="adock-player">
          {url && (
            <StudioPlayer
              key={recording.id}
              ref={playerRef}
              src={url}
              fps={recording.video?.fps ?? 30}
              onTimeUpdate={setVideoS}
              onReplay={noop}
              showReplay={false}
              controlsHost={controlsHost}
              loopRegion={range ? { a: range.a / 1000, b: range.b / 1000 } : null}
              onSaveTarget={onSaveTarget}
              onSampleColor={onSampleColor}
              popoverKinds={DOCK_POPOVER_KINDS}
            />
          )}
        </div>
        {canvasOverlay && (
          <div className="adock-canvas" aria-hidden={interactionMode === "frame"}>
            {canvasOverlay}
          </div>
        )}
        {canvasOverlay && (
          <fieldset className="adock-mode-switch" aria-label="Stage interaction">
            <button
              type="button"
              className="adock-mode"
              data-active={interactionMode === "canvas"}
              aria-pressed={interactionMode === "canvas"}
              title="Edit and connect macro nodes"
              onClick={() => setInteractionMode("canvas")}
            >
              <Workflow aria-hidden="true" />
              Canvas
            </button>
            <button
              type="button"
              className="adock-mode"
              data-active={interactionMode === "frame"}
              aria-pressed={interactionMode === "frame"}
              title="Play the video or drag a visual target"
              onClick={() => setInteractionMode("frame")}
            >
              <Frame aria-hidden="true" />
              Frame
            </button>
          </fieldset>
        )}
      </div>
      <div className="adock-timeline">
        <div ref={setControlsHost} className="adock-controls" />
        <div className="adock-cliprow">
          <button
            type="button"
            className="adock-mark"
            title="Mark In at the playhead (I)"
            aria-label="Mark In"
            onClick={markIn}
          >
            ⌈ In
          </button>
          <button
            type="button"
            className="adock-mark"
            title="Mark Out at the playhead (O)"
            aria-label="Mark Out"
            onClick={markOut}
          >
            ⌋ Out
          </button>
          {range && range.b > range.a && (
            <>
              <div className="anp-chip adock-chip">
                <span>
                  {fmtMmSs(range.a)}–{fmtMmSs(range.b)} ·{" "}
                  {
                    eventsInRange(recording.events, segmentBasis(recording), range.a, range.b)
                      .length
                  }{" "}
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
              <button
                type="button"
                className="adock-add"
                title="Add this range as a Segment node (Enter)"
                onClick={onAddSegment}
              >
                + Add Segment
              </button>
            </>
          )}
        </div>
        <StudioTimeline
          events={recording.events}
          startMs={segmentBasis(recording)}
          durationMs={durationMs}
          videoMs={videoS * 1000}
          onSeekSeconds={(s) => playerRef.current?.seek(s)}
          loop={range}
          onLoopChange={(l) =>
            // Round where the drag lands in shared state, so the sidebar's
            // event summary and segmentNodeFromRange (which rounds
            // internally) always filter on identical bounds.
            onRangeChange(l ? { a: Math.round(l.a), b: Math.round(l.b) } : null)
          }
          rangeWord="selection"
        />
      </div>
    </div>
  );
}
