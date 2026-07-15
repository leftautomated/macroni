import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { LoopRegion } from "@/components/studio/StudioTimeline";
import { InputEventType, type InputEvent, type MacroNode, type Recording } from "@/types";
import { AddNodePanel } from "./AddNodePanel";

function mkEvent(key: string, timestamp: number): InputEvent {
  return { type: InputEventType.KeyPress, key, timestamp };
}

const recordingWithVideo: Recording = {
  id: "rec-1",
  name: "Recording One",
  events: [
    mkEvent("e0", 1000),
    mkEvent("e1", 2000),
    mkEvent("e2", 3000),
    mkEvent("e3", 4000),
    mkEvent("e4", 5000),
  ],
  created_at: 500,
  playback_speed: 1,
  video: {
    path: "/tmp/rec-1.mp4",
    start_ms: 1000,
    duration_ms: 5000,
    width: 1920,
    height: 1080,
    fps: 30,
    has_audio: false,
  },
};

const recordingWithoutVideo: Recording = {
  id: "rec-2",
  name: "No Video Recording",
  events: [],
  created_at: 0,
  playback_speed: 1,
};

const recordings: Recording[] = [recordingWithVideo, recordingWithoutVideo];

// AddNodePanel is controlled: MacroEditor owns recordingId + range. This
// harness reproduces that ownership (including range-reset-on-switch) and
// exposes a button standing in for a dock drag.
function Harness({
  recordings: recs,
  onAdd = () => {},
  dockRange = { a: 2000, b: 4000 },
}: {
  recordings: Recording[];
  onAdd?: (node: MacroNode) => void;
  dockRange?: LoopRegion;
}) {
  const [recordingId, setRecordingId] = useState("");
  const [range, setRange] = useState<LoopRegion | null>(null);
  return (
    <>
      <AddNodePanel
        recordings={recs}
        selectedRecordingId={recordingId}
        onSelectRecording={(id) => {
          setRecordingId(id);
          setRange(null);
        }}
        range={range}
        onRangeChange={setRange}
        onAdd={onAdd}
      />
      <button type="button" onClick={() => setRange(dockRange)}>
        Simulate dock drag
      </button>
    </>
  );
}

async function selectRecording(name: string | RegExp) {
  await userEvent.click(screen.getByRole("combobox", { name: /recording/i }));
  await userEvent.click(await screen.findByRole("option", { name }));
}

async function setStartEnd(start: string, end: string) {
  const startInput = screen.getByRole("spinbutton", { name: /start/i });
  const endInput = screen.getByRole("spinbutton", { name: /end/i });
  await userEvent.clear(startInput);
  if (start) await userEvent.type(startInput, start);
  await userEvent.clear(endInput);
  if (end) await userEvent.type(endInput, end);
}

describe("AddNodePanel", () => {
  it("only lists recordings that have video", async () => {
    render(<Harness recordings={recordings} />);
    await userEvent.click(screen.getByRole("combobox", { name: /recording/i }));
    expect(await screen.findByRole("option", { name: /recording one/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /no video recording/i })).not.toBeInTheDocument();
  });

  it("adds a Segment node from typed start/end with filtered events and provenance", async () => {
    const onAdd = vi.fn();
    render(<Harness recordings={recordings} onAdd={onAdd} />);

    await selectRecording("Recording One");
    await setStartEnd("1", "3");
    await userEvent.click(screen.getByRole("button", { name: /add segment/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const node = onAdd.mock.calls[0][0];
    expect(node.kind.type).toBe("Segment");
    expect(node.kind.events).toEqual([
      mkEvent("e1", 2000),
      mkEvent("e2", 3000),
      mkEvent("e3", 4000),
    ]);
    expect(node.kind.provenance).toEqual({
      recording_id: "rec-1",
      start_ms: 1000,
      end_ms: 3000,
    });
  });

  it("rounds fractional-second typed values to integer ms", async () => {
    const onAdd = vi.fn();
    render(<Harness recordings={recordings} onAdd={onAdd} />);

    await selectRecording("Recording One");
    await setStartEnd("1.001", "3.0004");
    await userEvent.click(screen.getByRole("button", { name: /add segment/i }));

    const node = onAdd.mock.calls[0][0];
    expect(node.kind.provenance.start_ms).toBe(1001);
    expect(Number.isInteger(node.kind.provenance.end_ms)).toBe(true);
  });

  it("reflects an external (dock) range in the chip, summary count, and inputs", async () => {
    render(<Harness recordings={recordings} />);
    await selectRecording("Recording One");
    await userEvent.click(screen.getByRole("button", { name: /simulate dock drag/i }));

    // rel range [2000,4000] over basis 1000 → events e2,e3,e4.
    expect(screen.getByText(/0:02–0:04 · 3 events/)).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /start/i })).toHaveValue(2);
    expect(screen.getByRole("spinbutton", { name: /end/i })).toHaveValue(4);
    expect(screen.getByRole("button", { name: /add segment/i })).toBeEnabled();
  });

  it("clears the range, inputs, and chip via the chip's clear button", async () => {
    render(<Harness recordings={recordings} />);
    await selectRecording("Recording One");
    await userEvent.click(screen.getByRole("button", { name: /simulate dock drag/i }));

    await userEvent.click(screen.getByRole("button", { name: /clear range/i }));

    expect(screen.queryByText(/3 events/)).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /start/i })).toHaveValue(0);
    expect(screen.getByRole("spinbutton", { name: /end/i })).toHaveValue(null);
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();
  });

  it("does not clobber a partially-typed buffer with the range echo", async () => {
    render(<Harness recordings={recordings} />);
    await selectRecording("Recording One");

    // End empty → every keystroke emits onRangeChange(null); the Start buffer
    // must keep the user's text rather than resetting to "0".
    const startInput = screen.getByRole("spinbutton", { name: /start/i });
    await userEvent.clear(startInput);
    await userEvent.type(startInput, "2");
    expect(startInput).toHaveValue(2);
  });

  it("disables Add Segment when end <= start, out of bounds, or nothing selected", async () => {
    render(<Harness recordings={recordings} />);
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();

    await selectRecording("Recording One");
    await setStartEnd("3", "3");
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();

    await setStartEnd("1", "10");
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();
  });

  it("adds a WaitFor text node with the exact TextOcr target shape", async () => {
    const onAdd = vi.fn();
    render(<Harness recordings={recordings} onAdd={onAdd} />);

    await userEvent.type(screen.getByLabelText(/expect/i), "Submit");
    const timeoutInput = screen.getByRole("spinbutton", { name: /timeout/i });
    await userEvent.clear(timeoutInput);
    await userEvent.type(timeoutInput, "8");
    await userEvent.click(screen.getByRole("button", { name: /add text wait/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const node = onAdd.mock.calls[0][0];
    expect(node.kind.type).toBe("WaitFor");
    expect(node.kind.target.kind).toEqual({ type: "TextOcr", expect: "Submit" });
    expect(node.kind.timeout_ms).toBe(8000);
  });

  it("defaults the Wait timeout to 10s and disables on empty expect", async () => {
    const onAdd = vi.fn();
    render(<Harness recordings={recordings} onAdd={onAdd} />);
    expect(screen.getByRole("button", { name: /add text wait/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/expect/i), "Loaded");
    await userEvent.click(screen.getByRole("button", { name: /add text wait/i }));
    expect(onAdd.mock.calls[0][0].kind.timeout_ms).toBe(10000);
  });

  it("always shows the visual-wait footnote, and the segment hint only before a selection", async () => {
    render(<Harness recordings={recordings} />);
    // Footnote is unconditional; the segment card hints until a recording is picked.
    expect(screen.getByText(/drag a box on the video frame/i)).toBeInTheDocument();
    expect(screen.getByText(/pick a recording above/i)).toBeInTheDocument();

    await selectRecording("Recording One");
    expect(screen.getByText(/drag a box on the video frame/i)).toBeInTheDocument();
    expect(screen.queryByText(/pick a recording above/i)).not.toBeInTheDocument();
  });
});
