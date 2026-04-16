import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventTimeline } from "../EventTimeline";
import { InputEventType } from "@/types";
import type { InputEvent } from "@/types";

describe("EventTimeline", () => {
  it("renders a marker per non-MouseMove event", () => {
    const events: InputEvent[] = [
      { type: InputEventType.KeyPress, key: "a", timestamp: 1000 },
      { type: InputEventType.MouseMove, x: 0, y: 0, timestamp: 1100 },
      { type: InputEventType.ButtonPress, button: "Left", x: 0, y: 0, timestamp: 1500 },
    ];
    render(
      <EventTimeline
        events={events}
        startMs={1000}
        durationMs={1000}
        activeIndex={0}
        onSeek={() => {}}
      />,
    );
    const markers = screen.getAllByTestId(/^event-marker-/);
    expect(markers.length).toBe(2); // MouseMove filtered out
  });
});
