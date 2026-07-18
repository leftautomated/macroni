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
    expect(screen.getByRole("button", { name: /Keystroke, a/ })).toBeInTheDocument();
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

  it("cuts and extends the kept recording range with draggable handles", () => {
    const onTrimChange = vi.fn();
    const onTrimCommit = vi.fn();
    const { rerender } = render(
      <StudioTimeline
        {...base}
        trim={{ a: 0, b: 2000 }}
        onTrimChange={onTrimChange}
        onTrimCommit={onTrimCommit}
        onSeekSeconds={noop}
        onLoopChange={noop}
      />,
    );
    const start = screen.getByRole("button", { name: /trim start/i });
    fireEvent.pointerDown(start, { clientX: 0, pointerId: 3 });
    fireEvent.pointerMove(start, { clientX: 25, pointerId: 3 });
    fireEvent.pointerUp(start, { clientX: 25, pointerId: 3 });
    expect(onTrimCommit).toHaveBeenLastCalledWith({ a: 500, b: 2000 });

    rerender(
      <StudioTimeline
        {...base}
        trim={{ a: 500, b: 1600 }}
        onTrimChange={onTrimChange}
        onTrimCommit={onTrimCommit}
        onSeekSeconds={noop}
        onLoopChange={noop}
      />,
    );
    expect(screen.getByText(/kept 0:00\.50–0:01\.60/i)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: /trim start/i }), {
      key: "ArrowLeft",
    });
    expect(onTrimCommit).toHaveBeenLastCalledWith({ a: 400, b: 1600 });
    fireEvent.click(screen.getByRole("button", { name: /reset trim/i }));
    expect(onTrimCommit).toHaveBeenLastCalledWith({ a: 0, b: 2000 });
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
    const tick = screen.getByRole("button", { name: /Text snapshot, Submit/ });
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

  it("renders a space-switch tick on the keys lane with a detailed tooltip", async () => {
    const evs: InputEvent[] = [
      { type: InputEventType.SpaceSwitch, direction: "right", count: 2, timestamp: 1500 },
    ];
    const { container } = render(
      <StudioTimeline {...base} events={evs} onSeekSeconds={noop} onLoopChange={noop} />,
    );
    const lanes = container.querySelectorAll(".tl-lane");
    // Lane order in the DOM: mouse lane first, keys lane second.
    const tick = screen.getByRole("button", { name: /Space Switch, ⇄ → ×2/ });
    expect((lanes[1] as HTMLElement).contains(tick)).toBe(true);
    expect(tick).toBeTruthy();
    expect(tick.style.background).toBe("rgb(213, 81, 129)"); // #d55181
    // Mouse lane must NOT contain it.
    expect((lanes[0] as HTMLElement).querySelector('[aria-label*="⇄"]')).toBeNull();
    expect(screen.getByText("Space")).toBeInTheDocument(); // legend

    fireEvent.focus(tick);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Space Switch");
    expect(tooltip).toHaveTextContent("0:00.50");
    expect(tooltip).toHaveTextContent("⇄ → ×2");
  });

  it("hides inline span labels until the full word has enough room", () => {
    const { container } = render(
      <StudioTimeline {...base} onSeekSeconds={noop} onLoopChange={noop} />,
    );
    const span = container.querySelector(".tl-span") as HTMLElement;
    const label = span.querySelector(".tl-span-label") as HTMLElement;
    const styles = Array.from(container.querySelectorAll("style"))
      .map((style) => style.textContent)
      .join("\n");

    expect(label).toHaveTextContent("Drag");
    expect(styles).toContain("@container (min-width: 52px)");
    expect(styles).toContain(".tl-span-label { display: none;");
    expect(span.getAttribute("aria-label")).toContain("Drag");
  });

  it("swaps loop wording for selection wording when rangeWord='selection'", () => {
    const { rerender } = render(
      <StudioTimeline
        {...base}
        rangeWord="selection"
        loop={null}
        onSeekSeconds={noop}
        onLoopChange={noop}
      />,
    );
    expect(screen.getByText("drag to select a range")).toBeInTheDocument();

    // base's durationMs is 2000 — keep the loop inside the track.
    rerender(
      <StudioTimeline
        {...base}
        rangeWord="selection"
        loop={{ a: 500, b: 1500 }}
        onSeekSeconds={noop}
        onLoopChange={noop}
      />,
    );
    expect(screen.getByRole("button", { name: /selection 0:00–0:01/ })).toBeInTheDocument();
    expect(screen.queryByText(/⟳ loop/)).not.toBeInTheDocument();
  });
});
