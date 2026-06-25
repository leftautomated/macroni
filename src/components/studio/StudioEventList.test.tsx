import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StudioEventList } from "./StudioEventList";
import { type InputEvent, InputEventType } from "@/types";

const events: InputEvent[] = [
  { type: InputEventType.KeyPress, key: "a", timestamp: 1000 },
  { type: InputEventType.ButtonPress, button: "Left", x: 12, y: 34, timestamp: 1500 },
];

const noop = () => {};

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; the autoscroll effect calls it.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("StudioEventList", () => {
  it("renders each event with a start-relative timestamp and description", () => {
    render(
      <StudioEventList
        events={events}
        startMs={1000}
        activeIndex={0}
        onSeek={noop}
        onUserScroll={noop}
        autoScrollEnabled={false}
      />,
    );
    expect(screen.getByText(/key press/i)).toBeInTheDocument();
    expect(screen.getByText(/mouse press/i)).toBeInTheDocument();
    // Relative to startMs=1000: event0 at 0ms, event1 at 500ms.
    expect(screen.getByText("0:00.00")).toBeInTheDocument();
    expect(screen.getByText("0:00.50")).toBeInTheDocument();
  });

  it("shows the empty state when there are no events", () => {
    render(
      <StudioEventList
        events={[]}
        startMs={0}
        activeIndex={-1}
        onSeek={noop}
        onUserScroll={noop}
        autoScrollEnabled={false}
      />,
    );
    expect(screen.getByText(/no events recorded/i)).toBeInTheDocument();
  });

  it("collapses a scroll run into a group row that expands on click (not seek)", async () => {
    const onSeek = vi.fn();
    const withScroll: InputEvent[] = [
      { type: InputEventType.Scroll, delta_x: 0, delta_y: -10, timestamp: 1000 },
      { type: InputEventType.Scroll, delta_x: 0, delta_y: -20, timestamp: 1050 },
      { type: InputEventType.KeyPress, key: "a", timestamp: 2000 },
    ];
    render(
      <StudioEventList
        events={withScroll}
        startMs={1000}
        activeIndex={-1}
        onSeek={onSeek}
        onUserScroll={noop}
        autoScrollEnabled={false}
      />,
    );
    // Two scrolls collapse into one summary row with a ×2 count.
    expect(screen.getByText("×2")).toBeInTheDocument();

    // Clicking the group header expands it rather than seeking.
    await userEvent.click(screen.getByTitle("Expand 2 events"));
    expect(onSeek).not.toHaveBeenCalled();
    expect(screen.getByTitle("Collapse")).toBeInTheDocument();
  });

  it("collapses an adjacent press+release into a Click row", () => {
    const withClick: InputEvent[] = [
      { type: InputEventType.ButtonPress, button: "Left", x: 12, y: 34, timestamp: 1000 },
      { type: InputEventType.ButtonRelease, button: "Left", x: 12, y: 34, timestamp: 1100 },
    ];
    render(
      <StudioEventList
        events={withClick}
        startMs={1000}
        activeIndex={-1}
        onSeek={noop}
        onUserScroll={noop}
        autoScrollEnabled={false}
      />,
    );
    expect(screen.getByText(/click left/i)).toBeInTheDocument();
    // It became a single group row, not two press/release rows.
    expect(screen.queryByText(/mouse release/i)).not.toBeInTheDocument();
  });

  it("calls onSeek with the row index when a row is clicked", async () => {
    const onSeek = vi.fn();
    render(
      <StudioEventList
        events={events}
        startMs={1000}
        activeIndex={0}
        onSeek={onSeek}
        onUserScroll={noop}
        autoScrollEnabled={false}
      />,
    );
    await userEvent.click(screen.getByText(/mouse press/i));
    expect(onSeek).toHaveBeenCalledWith(1);
  });
});
