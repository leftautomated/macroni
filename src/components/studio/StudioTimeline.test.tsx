import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { StudioTimeline } from "./StudioTimeline";
import { type InputEvent, InputEventType } from "@/types";

const events: InputEvent[] = [
  { type: InputEventType.ButtonPress, button: "Left", x: 0, y: 0, timestamp: 1000 },
  { type: InputEventType.MouseMove, x: 5, y: 5, timestamp: 1100 },
  { type: InputEventType.ButtonRelease, button: "Left", x: 9, y: 9, timestamp: 1200 },
  { type: InputEventType.KeyPress, key: "a", timestamp: 1500 },
];

const noop = () => {};
const base = { events, startMs: 1000, durationMs: 2000, videoMs: 0, loop: null };

beforeEach(() => {
  // jsdom returns zeroed rects; give the track a width so the time math works,
  // and stub pointer capture (not implemented in jsdom).
  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        left: 0,
        top: 0,
        right: 100,
        bottom: 50,
        width: 100,
        height: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("StudioTimeline", () => {
  it("renders a span for the drag and a tick for the key", () => {
    const { container } = render(
      <StudioTimeline {...base} onSeekSeconds={noop} onLoopChange={noop} />,
    );
    expect(container.querySelector(".tl-span")).toBeTruthy();
    expect(container.querySelectorAll(".tl-tick").length).toBeGreaterThanOrEqual(1);
  });

  it("zooms to a 30s window and scrolls long recordings, with labeled segments", () => {
    const { container } = render(
      <StudioTimeline
        {...base}
        events={[
          { type: InputEventType.KeyPress, key: "a", timestamp: 1000 },
          { type: InputEventType.KeyRelease, key: "a", timestamp: 1100 },
        ]}
        durationMs={60000}
        onSeekSeconds={noop}
        onLoopChange={noop}
      />,
    );
    const track = container.querySelector(".tl-track") as HTMLElement;
    // 60s at the default 30s window → track is twice the viewport (scrollable).
    expect(track.style.width).toBe("200%");
    // Labeled time segments (e.g. 0:05) appear in the ruler.
    const labels = Array.from(container.querySelectorAll(".tl-rlabel")).map((n) => n.textContent);
    expect(labels).toContain("0:05");
  });

  it("renders a key press+release as a single keystroke tick in the keys lane", () => {
    const keyEvents: InputEvent[] = [
      { type: InputEventType.KeyPress, key: "a", timestamp: 1100 },
      { type: InputEventType.KeyRelease, key: "a", timestamp: 1150 },
    ];
    const { container } = render(
      <StudioTimeline {...base} events={keyEvents} onSeekSeconds={noop} onLoopChange={noop} />,
    );
    // Two raw events collapse to one tick (no separate press/release ticks).
    expect(container.querySelectorAll(".tl-tick")).toHaveLength(1);
    expect(container.querySelector('[title*="Key a"]')).toBeTruthy();
  });

  it("seeks to the clicked time on a plain click", () => {
    const onSeekSeconds = vi.fn();
    const { container } = render(
      <StudioTimeline {...base} onSeekSeconds={onSeekSeconds} onLoopChange={noop} />,
    );
    const track = container.querySelector(".tl-track") as HTMLElement;
    fireEvent.pointerDown(track, { clientX: 50, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 50, pointerId: 1 });
    // 50/100 across a 2000ms duration = 1000ms = 1.0s.
    expect(onSeekSeconds).toHaveBeenCalledWith(1);
  });

  it("sets a loop region when dragging across the track", () => {
    const onLoopChange = vi.fn();
    const { container } = render(
      <StudioTimeline {...base} onSeekSeconds={noop} onLoopChange={onLoopChange} />,
    );
    const track = container.querySelector(".tl-track") as HTMLElement;
    fireEvent.pointerDown(track, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 80, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 80, pointerId: 1 });
    expect(onLoopChange).toHaveBeenCalled();
    const calls = onLoopChange.mock.calls;
    expect(calls[calls.length - 1][0]).toMatchObject({ a: 400, b: 1600 });
  });
});
