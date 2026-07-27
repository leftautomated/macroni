import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { KindOption } from "@/components/studio/CreateTargetPopover";
import { StudioPlayer, type StudioPlayerHandle } from "@/components/studio/StudioPlayer";
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
import { eventsInRange, segmentBasis } from "@/lib/macro-segment";
import { fmtMmSs } from "@/lib/time-format";
import { videoDisplayRect } from "@/lib/video-rect";
import type { PerceptionTarget, Recording, Region } from "@/types";

// Trigger authoring by dragging on the frame is Image/Color only — text
// triggers come from clicking a span in the TriggerPicker overlay instead.
const DOCK_POPOVER_KINDS: KindOption[] = ["Image", "Color"];

const noop = () => {};

export interface AuthoringDockProps {
  /** Selected recording; callers only render the dock when `video` is set. */
  recording: Recording;
  /** Selector options — callers pass the video-bearing recordings. */
  recordings: Recording[];
  onSelectRecording: (id: string) => void;
  /** Shared action range, video-relative ms (integers). */
  range: LoopRegion | null;
  /** Fires with whole-ms values (rounded here) or null on clear. */
  onRangeChange: (range: LoopRegion | null) => void;
  /** Rule-anchor markers for the timeline's tick lane. */
  anchorTicks: Array<{ ms: number; label: string }>;
  /** Seek request from outside (rule card click), consumed once. */
  pendingSeekMs: number | null;
  onSeekConsumed: () => void;
  /**
   * Latest playhead in whole ms. Lets the deck's own Add rule anchor exactly
   * where this dock's would — callers should park it in a ref, it ticks every
   * animation frame during playback.
   */
  onPlayheadMs?: (ms: number) => void;
  /** Start a rule draft at the playhead (Add rule button / R key). */
  onAddRule: (timestampMs: number) => void;
  /** True while the trigger picker should be shown; the dock pauses. */
  picking: boolean;
  /** Picker overlay, rendered over the video's content rect. */
  pickerOverlay?: ReactNode;
  onSaveTarget: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
  onSampleColor: (region: Region, timestampMs: number) => Promise<[number, number, number]>;
  /** Escape pressed with a draft open. */
  onCancelDraft: () => void;
  hasDraft: boolean;
}

/**
 * Bottom authoring dock for the macro editor: the real StudioPlayer and
 * StudioTimeline, plus the clip row that drives rule authoring.
 * Scrub to the frame where the trigger appears, press "+ Add rule" (or R) to
 * open the trigger picker over the frame; the action range comes from
 * dragging on the timeline OR marking In/Out at the playhead (I/O keys or the
 * clip-row buttons), and loop-previews on the player either way. Escape
 * cancels an open draft, else clears the range; Enter adds the range-only
 * (no-draft) selection. Dragging a box on the frame authors an Image/Color
 * trigger through the player's existing popover flow.
 */
export function AuthoringDock({
  recording,
  recordings,
  onSelectRecording,
  range,
  onRangeChange,
  anchorTicks,
  pendingSeekMs,
  onSeekConsumed,
  onPlayheadMs,
  onAddRule,
  picking,
  pickerOverlay,
  onSaveTarget,
  onSampleColor,
  onCancelDraft,
  hasDraft,
}: AuthoringDockProps) {
  const playerRef = useRef<StudioPlayerHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [videoS, setVideoS] = useState(0);
  const onPlayheadMsRef = useRef(onPlayheadMs);
  onPlayheadMsRef.current = onPlayheadMs;
  // The player's transport bar renders into the timeline column (same
  // controlsHost pattern as StudioEditor), so the video fills the left pane
  // and scrub/transport/timeline stack together on the right.
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null);
  const { url } = useVideoAssetUrl(recording.video);

  const durationMs = recording.video?.duration_ms ?? 0;

  // The overlay must line up with the video's *displayed* pixels, not the
  // stage box — same contain-fit math StudioPlayer runs internally, measured
  // here against the identically sized `.adock-player` wrapper.
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setBox({ width: r.width, height: r.height });
    };
    update();
    // jsdom has no ResizeObserver — the overlay just sits on a zero rect there.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const contentRect = videoDisplayRect(box, {
    width: recording.video?.width ?? 0,
    height: recording.video?.height ?? 0,
  });

  // Picking pauses playback: the picker's boxes are pinned to the frame that
  // was OCR'd, so the video must not move underneath them.
  useEffect(() => {
    if (picking) playerRef.current?.pause();
  }, [picking]);

  // One-shot seek from a rule-card click.
  useEffect(() => {
    if (pendingSeekMs === null) return;
    playerRef.current?.seek(pendingSeekMs / 1000);
    onSeekConsumed();
  }, [pendingSeekMs, onSeekConsumed]);

  const recordingsWithVideo = useMemo(() => recordings.filter((r) => r.video), [recordings]);

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

  const handleTimeUpdate = (seconds: number) => {
    setVideoS(seconds);
    onPlayheadMsRef.current?.(Math.round(seconds * 1000));
  };

  const addRuleAtPlayhead = () => onAddRule(Math.round(videoS * 1000));

  // I/O/R/Enter/Escape while the dock is open. The window listener is bound
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
    } else if (e.key === "r" || e.key === "R") {
      addRuleAtPlayhead();
    } else if (e.key === "Enter" || e.key === "Escape") {
      // Enter/Escape must never steal activation from a focused control —
      // a focused button keeps its native Enter, an open Radix listbox
      // keeps its option selection. I/O/R deliberately still work with a
      // button focused (mark, then keep marking).
      if (t instanceof HTMLElement && t.closest("button, [role='option']")) return;
      if (e.key === "Escape" && hasDraft) {
        // A draft outranks the range: Escape backs out of authoring first.
        e.preventDefault();
        onCancelDraft();
      } else if (e.key === "Escape" && range) {
        e.preventDefault();
        onRangeChange(null);
      }
      // Enter is deliberately never claimed here. A range on its own no
      // longer creates anything (rules need a trigger), and confirming a
      // draft belongs to the draft card's own Add button — where a focused
      // Enter already works natively.
    }
  };
  useEffect(() => {
    const listen = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, []);

  return (
    <div className="adock-root">
      <div className="adock-stage">
        <div ref={stageRef} className="adock-player">
          {url && (
            <StudioPlayer
              key={recording.id}
              ref={playerRef}
              src={url}
              fps={recording.video?.fps ?? 30}
              onTimeUpdate={handleTimeUpdate}
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
        {pickerOverlay && (
          <div
            className="adock-overlay"
            style={{
              left: contentRect.left,
              top: contentRect.top,
              width: contentRect.width,
              height: contentRect.height,
            }}
          >
            {pickerOverlay}
          </div>
        )}
      </div>
      <div className="adock-timeline">
        <div ref={setControlsHost} className="adock-controls" />
        <div className="adock-cliprow">
          <Select value={recording.id} onValueChange={onSelectRecording}>
            <SelectTrigger
              aria-label="Recording"
              className="h-7 w-44 shrink-0 text-xs focus-visible:border-ring"
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
          <button
            type="button"
            className="adock-add"
            title="Start a rule at the playhead (R)"
            aria-label="Add rule at the playhead"
            onClick={addRuleAtPlayhead}
          >
            <Plus aria-hidden="true" />
            Add rule
          </button>
          {range && range.b > range.a && (
            <div className="adock-chip">
              <span>
                {fmtMmSs(range.a)}–{fmtMmSs(range.b)} ·{" "}
                {eventsInRange(recording.events, segmentBasis(recording), range.a, range.b).length}{" "}
                events
              </span>
              <button
                type="button"
                className="adock-chip-clear"
                aria-label="Clear range"
                onClick={() => onRangeChange(null)}
              >
                ✕
              </button>
            </div>
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
            // Round where the drag lands in shared state, so the clip row's
            // event summary and playInputsRule (which rounds internally)
            // always filter on identical bounds.
            onRangeChange(l ? { a: Math.round(l.a), b: Math.round(l.b) } : null)
          }
          perceptionTicks={anchorTicks}
          rangeWord="selection"
        />
      </div>
    </div>
  );
}
