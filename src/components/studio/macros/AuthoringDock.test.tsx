import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InputEventType, type InputEvent, type PerceptionTarget, type Recording } from "@/types";

// The dock's unit under test is its wiring: range→loopRegion conversion,
// drag→rounded onRangeChange, and passthrough of the target-authoring hooks.
// StudioPlayer itself (video element, popover) is stubbed to expose those
// props; StudioTimeline renders for real so the drag math is exercised.
const fixtures = vi.hoisted(() => ({
  target: {
    id: "t1",
    name: "Target",
    modality: "visual",
    region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    kind: { type: "TemplateMatch", image: "", threshold: 0.8, source_px: [0, 0] },
    created_at: 1,
  },
}));

vi.mock("@/components/studio/StudioPlayer", () => ({
  StudioPlayer: ({
    loopRegion,
    onSaveTarget,
  }: {
    loopRegion?: { a: number; b: number } | null;
    onSaveTarget?: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
  }) => (
    <div data-testid="player-stub">
      <div>loop: {loopRegion ? `${loopRegion.a}-${loopRegion.b}` : "none"}</div>
      <button
        type="button"
        onClick={() => onSaveTarget?.(fixtures.target as PerceptionTarget, 4200)}
      >
        Simulate save
      </button>
    </div>
  ),
}));

vi.mock("@/hooks/useVideoAssetUrl", () => ({
  useVideoAssetUrl: () => ({ url: "asset://video.mp4", error: null }),
}));

import { AuthoringDock } from "./AuthoringDock";

beforeEach(() => {
  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        left: 0,
        top: 0,
        right: 137,
        bottom: 50,
        width: 137,
        height: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

function mkEvent(key: string, timestamp: number): InputEvent {
  return { type: InputEventType.KeyPress, key, timestamp };
}

const recording: Recording = {
  id: "rec-1",
  name: "Recording One",
  events: [mkEvent("a", 100), mkEvent("b", 292)],
  created_at: 500,
  playback_speed: 1,
  video: {
    path: "/tmp/rec-1.mp4",
    start_ms: 0,
    duration_ms: 5000,
    width: 1920,
    height: 1080,
    fps: 30,
    has_audio: false,
  },
};

const baseProps = {
  recording,
  range: null,
  onRangeChange: () => {},
  onSaveTarget: async () => {},
  onSampleColor: async (): Promise<[number, number, number]> => [0, 0, 0],
};

describe("AuthoringDock", () => {
  it("rounds a timeline drag to whole ms before emitting onRangeChange", () => {
    const onRangeChange = vi.fn();
    const { container } = render(<AuthoringDock {...baseProps} onRangeChange={onRangeChange} />);

    // 137px track / 5000ms: msAt(8) = 8/137×5000 = 291.9708… → must emit 292.
    const track = container.querySelector(".tl-track") as HTMLElement;
    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 8, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 8, pointerId: 1 });

    expect(onRangeChange).toHaveBeenCalledWith({ a: 0, b: 292 });
  });

  it("feeds the shared range to the player's loopRegion in seconds", () => {
    render(<AuthoringDock {...baseProps} range={{ a: 2000, b: 4000 }} />);
    expect(screen.getByText("loop: 2-4")).toBeInTheDocument();
  });

  it("shows the selection wording, not loop wording, on its timeline", () => {
    render(<AuthoringDock {...baseProps} />);
    expect(screen.getByText("drag to select a range")).toBeInTheDocument();
  });

  it("passes onSaveTarget through to the player", async () => {
    const onSaveTarget = vi.fn().mockResolvedValue(undefined);
    render(<AuthoringDock {...baseProps} onSaveTarget={onSaveTarget} />);
    await userEvent.click(screen.getByRole("button", { name: /simulate save/i }));
    expect(onSaveTarget).toHaveBeenCalledWith(fixtures.target, 4200);
  });
});
