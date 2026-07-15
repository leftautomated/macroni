import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InputEventType, type InputEvent, type PerceptionTarget, type Recording } from "@/types";

// The dock's unit under test is its wiring: range→loopRegion conversion,
// drag→rounded onRangeChange, In/Out marking from the playhead, and
// passthrough of the target-authoring hooks. StudioPlayer is stubbed to
// expose those props (including onTimeUpdate so tests can move the
// playhead); StudioTimeline renders for real so drag math is exercised.
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
    onTimeUpdate,
  }: {
    loopRegion?: { a: number; b: number } | null;
    onSaveTarget?: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
    onTimeUpdate: (seconds: number) => void;
  }) => (
    <div data-testid="player-stub">
      <div>loop: {loopRegion ? `${loopRegion.a}-${loopRegion.b}` : "none"}</div>
      <button
        type="button"
        onClick={() => onSaveTarget?.(fixtures.target as PerceptionTarget, 4200)}
      >
        Simulate save
      </button>
      <button type="button" onClick={() => onTimeUpdate(1)}>
        Seek 1s
      </button>
      <button type="button" onClick={() => onTimeUpdate(3)}>
        Seek 3s
      </button>
      <button type="button" onClick={() => onTimeUpdate(5)}>
        Seek 5s
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
  onAddSegment: () => {},
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

  describe("In/Out marking", () => {
    it("I with no range marks playhead→end; O with no range marks start→playhead", async () => {
      const onRangeChange = vi.fn();
      render(<AuthoringDock {...baseProps} onRangeChange={onRangeChange} />);

      await userEvent.click(screen.getByRole("button", { name: "Seek 1s" }));
      fireEvent.keyDown(window, { key: "i" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 1000, b: 5000 });

      fireEvent.keyDown(window, { key: "o" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 0, b: 1000 });
    });

    it("In keeps a later Out, and re-anchors to the end past it", async () => {
      const onRangeChange = vi.fn();
      const { rerender } = render(
        <AuthoringDock {...baseProps} range={{ a: 2000, b: 4000 }} onRangeChange={onRangeChange} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Seek 1s" }));
      fireEvent.keyDown(window, { key: "i" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 1000, b: 4000 });

      // Existing Out (500ms) is before the playhead → In extends to the end.
      rerender(
        <AuthoringDock {...baseProps} range={{ a: 0, b: 500 }} onRangeChange={onRangeChange} />,
      );
      fireEvent.keyDown(window, { key: "i" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 1000, b: 5000 });
    });

    it("Out keeps an earlier In, and re-anchors to 0 before it", async () => {
      const onRangeChange = vi.fn();
      render(
        <AuthoringDock {...baseProps} range={{ a: 2000, b: 4000 }} onRangeChange={onRangeChange} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Seek 3s" }));
      fireEvent.keyDown(window, { key: "o" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 2000, b: 3000 });

      // Playhead (1s) is before the existing In (2s) → Out re-anchors to 0.
      await userEvent.click(screen.getByRole("button", { name: "Seek 1s" }));
      fireEvent.keyDown(window, { key: "o" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 0, b: 1000 });
    });

    it("marks that would produce an empty range no-op", async () => {
      const onRangeChange = vi.fn();
      render(<AuthoringDock {...baseProps} onRangeChange={onRangeChange} />);

      // Out at playhead 0 → b == a == 0.
      fireEvent.keyDown(window, { key: "o" });
      // In at the end of the video → a == b == duration.
      await userEvent.click(screen.getByRole("button", { name: "Seek 5s" }));
      fireEvent.keyDown(window, { key: "i" });

      expect(onRangeChange).not.toHaveBeenCalled();
    });

    it("ignores keys typed into form fields and modifier chords", async () => {
      const onRangeChange = vi.fn();
      render(
        <>
          <AuthoringDock {...baseProps} onRangeChange={onRangeChange} />
          <input aria-label="Some sidebar field" />
        </>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Seek 1s" }));

      fireEvent.keyDown(screen.getByLabelText("Some sidebar field"), { key: "i" });
      fireEvent.keyDown(window, { key: "i", metaKey: true });
      fireEvent.keyDown(window, { key: "o", ctrlKey: true });

      expect(onRangeChange).not.toHaveBeenCalled();
    });

    it("the In/Out buttons mark exactly like the keys", async () => {
      const onRangeChange = vi.fn();
      render(<AuthoringDock {...baseProps} onRangeChange={onRangeChange} />);
      await userEvent.click(screen.getByRole("button", { name: "Seek 1s" }));

      await userEvent.click(screen.getByRole("button", { name: /mark in/i }));
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 1000, b: 5000 });

      await userEvent.click(screen.getByRole("button", { name: /mark out/i }));
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 0, b: 1000 });
    });
  });

  describe("clip row", () => {
    it("Enter adds only when a range exists; Escape clears it", () => {
      const onAddSegment = vi.fn();
      const onRangeChange = vi.fn();
      const { rerender } = render(
        <AuthoringDock {...baseProps} onAddSegment={onAddSegment} onRangeChange={onRangeChange} />,
      );

      fireEvent.keyDown(window, { key: "Enter" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onAddSegment).not.toHaveBeenCalled();
      expect(onRangeChange).not.toHaveBeenCalled();

      rerender(
        <AuthoringDock
          {...baseProps}
          range={{ a: 0, b: 2000 }}
          onAddSegment={onAddSegment}
          onRangeChange={onRangeChange}
        />,
      );
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onAddSegment).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onRangeChange).toHaveBeenCalledWith(null);
    });

    it("Enter yields to focused buttons and role=option targets", () => {
      const onAddSegment = vi.fn();
      render(
        <>
          <AuthoringDock {...baseProps} range={{ a: 0, b: 2000 }} onAddSegment={onAddSegment} />
          <button type="button">Sidebar action</button>
          <div role="option" aria-selected="false" tabIndex={0}>
            Recording One
          </div>
        </>,
      );

      fireEvent.keyDown(screen.getByRole("button", { name: "Sidebar action" }), { key: "Enter" });
      fireEvent.keyDown(screen.getByRole("option"), { key: "Enter" });
      expect(onAddSegment).not.toHaveBeenCalled();
    });

    it("Enter ignores repeats, already-handled events, and zero-width ranges", () => {
      const onAddSegment = vi.fn();
      const { rerender } = render(
        <AuthoringDock {...baseProps} range={{ a: 0, b: 2000 }} onAddSegment={onAddSegment} />,
      );

      fireEvent.keyDown(window, { key: "Enter", repeat: true });
      expect(onAddSegment).not.toHaveBeenCalled();

      // Zero-width range (timeline can emit {a: x, b: x} on a return-to-origin
      // drag): Enter must fall through, and no Add button is offered.
      rerender(
        <AuthoringDock {...baseProps} range={{ a: 1000, b: 1000 }} onAddSegment={onAddSegment} />,
      );
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onAddSegment).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /add segment/i })).not.toBeInTheDocument();
    });

    it("renders the chip with the event count, a clear button, and Add Segment", async () => {
      const onAddSegment = vi.fn();
      const onRangeChange = vi.fn();
      render(
        <AuthoringDock
          {...baseProps}
          range={{ a: 0, b: 2000 }}
          onAddSegment={onAddSegment}
          onRangeChange={onRangeChange}
        />,
      );

      // Events at rel 100 and 292 are both inside [0, 2000].
      expect(screen.getByText(/0:00–0:02 · 2 events/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /add segment/i }));
      expect(onAddSegment).toHaveBeenCalledTimes(1);

      await userEvent.click(screen.getByRole("button", { name: /clear range/i }));
      expect(onRangeChange).toHaveBeenCalledWith(null);
    });

    it("shows no chip or Add button without a range", () => {
      render(<AuthoringDock {...baseProps} />);
      expect(screen.queryByRole("button", { name: /add segment/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/events/)).not.toBeInTheDocument();
    });
  });
});
