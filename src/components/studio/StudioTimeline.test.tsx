import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("zooms in further via the zoom slider", () => {
    const { container } = render(
      <StudioTimeline {...base} durationMs={60000} onSeekSeconds={noop} onLoopChange={noop} />,
    );
    // Slider at the far right = most zoomed-in = the 2s minimum window.
    fireEvent.change(screen.getByRole("slider", { name: /zoom/i }), { target: { value: "1" } });
    const track = container.querySelector(".tl-track") as HTMLElement;
    // 60s / 2s window → 3000% track width.
    expect(track.style.width).toBe("3000%");
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

  it("renders perception ticks and seeks on click", () => {
    const onSeek = vi.fn();
    render(
      <StudioTimeline
        {...base}
        onSeekSeconds={onSeek}
        onLoopChange={noop}
        perceptionTicks={[{ ms: 500, label: "Submit" }]}
      />,
    );
    const tick = screen.getByTitle("Submit");
    // A real click is pointerdown → pointerup → click. The tick stops
    // pointerdown, so the track's own click-seek never arms — otherwise the
    // track would derive 1.0s from clientX 50 over the 100px/2000ms track and
    // fire a second, wrong seek.
    fireEvent.pointerDown(tick, { clientX: 50, pointerId: 1 });
    fireEvent.pointerUp(tick, { clientX: 50, pointerId: 1 });
    fireEvent.click(tick, { clientX: 50 });
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(0.5);
  });

  it("shows a custom scrollbar thumb when the track overflows, and drags to scroll", () => {
    const { container } = render(
      <StudioTimeline {...base} durationMs={60000} onSeekSeconds={noop} onLoopChange={noop} />,
    );
    const scroller = container.querySelector(".tl-scroll") as HTMLElement;
    // jsdom has no layout: give the scroller geometry (100px viewport, 200px
    // content) and fire a scroll so the thumb re-measures.
    Object.defineProperty(scroller, "clientWidth", { value: 100, configurable: true });
    Object.defineProperty(scroller, "scrollWidth", { value: 200, configurable: true });
    fireEvent.scroll(scroller);

    const thumb = container.querySelector(".tl-hthumb") as HTMLElement;
    expect(thumb.style.width).toBe("50px"); // viewport/content = half the strip
    expect(thumb.style.left).toBe("0px");

    // Dragging the thumb 25px across the 50px of free strip scrolls half of
    // the 100px of hidden content.
    const strip = container.querySelector(".tl-hscroll") as HTMLElement;
    fireEvent.pointerDown(strip, { clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 35, pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: 35, pointerId: 1 });
    expect(scroller.scrollLeft).toBe(50);
  });

  it("renders a space-switch tick on the keys lane with direction tooltip", () => {
    const evs: InputEvent[] = [
      { type: InputEventType.SpaceSwitch, direction: "right", count: 2, timestamp: 1500 },
    ];
    const { container } = render(
      <StudioTimeline {...base} events={evs} onSeekSeconds={noop} onLoopChange={noop} />,
    );
    const lanes = container.querySelectorAll(".tl-lane");
    // Lane order in the DOM: mouse lane first, keys lane second.
    const keysLane = lanes[1] as HTMLElement;
    const tick = keysLane.querySelector('[title*="⇄ →"][title*="×2"]') as HTMLElement;
    expect(tick).toBeTruthy();
    expect(tick.style.background).toBe("rgb(244, 114, 182)"); // #f472b6
    // Mouse lane must NOT contain it.
    expect((lanes[0] as HTMLElement).querySelector('[title*="⇄"]')).toBeNull();
    expect(screen.getByText("Space")).toBeInTheDocument(); // legend
  });
});
