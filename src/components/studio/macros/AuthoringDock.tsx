import { useRef, useState } from "react";
import type { KindOption } from "@/components/studio/CreateTargetPopover";
import { StudioPlayer, type StudioPlayerHandle } from "@/components/studio/StudioPlayer";
import { type LoopRegion, StudioTimeline } from "@/components/studio/StudioTimeline";
import { useVideoAssetUrl } from "@/hooks/useVideoAssetUrl";
import { segmentBasis } from "@/lib/macro-segment";
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
  onSaveTarget: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
  onSampleColor: (region: Region, timestampMs: number) => Promise<[number, number, number]>;
}

/**
 * Bottom authoring dock for the macro editor: the real StudioPlayer and
 * StudioTimeline at full width, exactly as the main studio pairs them.
 * Dragging on the timeline selects the shared segment range (which the
 * player then loops, previewing the segment); dragging a box on the frame
 * authors an Image/Color wait through the player's existing popover flow.
 */
export function AuthoringDock({
  recording,
  range,
  onRangeChange,
  onSaveTarget,
  onSampleColor,
}: AuthoringDockProps) {
  const playerRef = useRef<StudioPlayerHandle>(null);
  const [videoS, setVideoS] = useState(0);
  const { url } = useVideoAssetUrl(recording.video);

  return (
    <div className="adock-root">
      <div className="adock-player">
        <StudioPlayer
          key={recording.id}
          ref={playerRef}
          src={url ?? ""}
          fps={recording.video?.fps ?? 30}
          onTimeUpdate={setVideoS}
          onReplay={noop}
          showReplay={false}
          loopRegion={range ? { a: range.a / 1000, b: range.b / 1000 } : null}
          onSaveTarget={onSaveTarget}
          onSampleColor={onSampleColor}
          popoverKinds={DOCK_POPOVER_KINDS}
        />
      </div>
      <div className="adock-timeline">
        <StudioTimeline
          events={recording.events}
          startMs={segmentBasis(recording)}
          durationMs={recording.video?.duration_ms ?? 0}
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
