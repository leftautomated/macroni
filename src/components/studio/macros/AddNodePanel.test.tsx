import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddNodePanel } from "./AddNodePanel";
import { InputEventType, type InputEvent, type Recording } from "@/types";

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

async function selectRecording(name: string) {
  await userEvent.selectOptions(screen.getByRole("combobox", { name: /recording/i }), name);
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
  it("only lists recordings that have video in the Add Segment select", () => {
    render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);
    expect(screen.getByRole("option", { name: /recording one/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /no video recording/i })).not.toBeInTheDocument();
  });

  it("adds a Segment node with events filtered to the relative range and correct provenance", async () => {
    const onAdd = vi.fn();
    render(<AddNodePanel recordings={recordings} onAdd={onAdd} />);

    await selectRecording("rec-1");
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
    expect(node.kind.speed).toBe(1);
    expect(node.kind.provenance).toEqual({
      recording_id: "rec-1",
      start_ms: 1000,
      end_ms: 3000,
    });
    expect(node.x).toBe(40);
    expect(node.y).toBe(40);
    expect(typeof node.id).toBe("string");
    expect(node.id.length).toBeGreaterThan(0);
  });

  it("falls back to the recording's created_at as the relative basis when video.start_ms is missing", async () => {
    const noStartMs: Recording = {
      ...recordingWithVideo,
      id: "rec-3",
      name: "No Start Ms",
      created_at: 2000,
      events: [mkEvent("a", 2000), mkEvent("b", 3000), mkEvent("c", 5000)],
      video: {
        ...recordingWithVideo.video!,
        start_ms: undefined as unknown as number,
      },
    };
    const onAdd = vi.fn();
    render(<AddNodePanel recordings={[noStartMs]} onAdd={onAdd} />);

    await selectRecording("No Start Ms");
    await setStartEnd("0", "1");
    await userEvent.click(screen.getByRole("button", { name: /add segment/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const node = onAdd.mock.calls[0][0];
    // basis = created_at (2000); rel range [0, 1000] -> timestamps [2000, 3000]
    expect(node.kind.events).toEqual([mkEvent("a", 2000), mkEvent("b", 3000)]);
  });

  it("disables the Add Segment button when end <= start", async () => {
    render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);

    await selectRecording("rec-1");
    await setStartEnd("3", "3");

    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();
  });

  it("disables the Add Segment button when no recording is selected", () => {
    render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();
  });

  it("disables the Add Segment button when the range is out of bounds", async () => {
    render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);

    await selectRecording("rec-1");
    await setStartEnd("1", "10");

    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();
  });

  it("adds a WaitFor text node with the exact TextOcr target shape", async () => {
    const onAdd = vi.fn();
    render(<AddNodePanel recordings={recordings} onAdd={onAdd} />);

    await userEvent.type(screen.getByLabelText(/expect/i), "Submit");
    const timeoutInput = screen.getByRole("spinbutton", { name: /timeout/i });
    await userEvent.clear(timeoutInput);
    await userEvent.type(timeoutInput, "8");

    await userEvent.click(screen.getByRole("button", { name: /add text wait/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const node = onAdd.mock.calls[0][0];
    expect(node.kind.type).toBe("WaitFor");
    expect(node.kind.target.kind).toEqual({ type: "TextOcr", expect: "Submit" });
    expect(node.kind.target.modality).toBe("visual");
    expect(node.kind.target.region).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(node.kind.target.name).toBe("Submit");
    expect(typeof node.kind.target.id).toBe("string");
    expect(typeof node.kind.target.created_at).toBe("number");
    expect(node.kind.timeout_ms).toBe(8000);
    expect(node.kind.poll_interval_ms).toBe(500);
    expect(node.x).toBe(40);
    expect(node.y).toBe(160);
    expect(typeof node.id).toBe("string");
  });

  it("defaults the Wait timeout to 10s when left unchanged", async () => {
    const onAdd = vi.fn();
    render(<AddNodePanel recordings={recordings} onAdd={onAdd} />);

    await userEvent.type(screen.getByLabelText(/expect/i), "Loaded");
    await userEvent.click(screen.getByRole("button", { name: /add text wait/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const node = onAdd.mock.calls[0][0];
    expect(node.kind.timeout_ms).toBe(10000);
  });

  it("disables the Add Text Wait button when expect is empty", async () => {
    render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);
    expect(screen.getByRole("button", { name: /add text wait/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/expect/i), "   ");
    expect(screen.getByRole("button", { name: /add text wait/i })).toBeDisabled();
  });
});
