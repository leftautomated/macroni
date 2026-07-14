import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InputEventType, type InputEvent, type PerceptionTarget, type Recording } from "@/types";

// StudioPlayer pulls in real <video>/ResizeObserver/perception-overlay
// rendering that's irrelevant here — the unit under test is AddNodePanel's
// node-building wiring around StudioPlayer's onSaveTarget callback, not video
// playback. The stub exposes two buttons that invoke the real onSaveTarget
// prop it was given with a canned TemplateMatch or ColorSample target, the
// same way StudioPlayer's real drag-to-select → CreateTargetPopover flow
// would once the user finishes authoring a target.
const fixtures = vi.hoisted(() => ({
  templateMatchTarget: {
    id: "target-image-1",
    name: "Target 1",
    modality: "visual",
    region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    kind: { type: "TemplateMatch", image: "", threshold: 0.8, source_px: [0, 0] },
    created_at: 1000,
  },
  colorSampleTarget: {
    id: "target-color-1",
    name: "Target 2",
    modality: "visual",
    region: { x: 0.3, y: 0.3, w: 0.1, h: 0.1 },
    kind: { type: "ColorSample", rgb: [10, 20, 30], tolerance: 10 },
    created_at: 2000,
  },
}));

vi.mock("@/components/studio/StudioPlayer", () => ({
  StudioPlayer: ({
    onSaveTarget,
  }: {
    onSaveTarget?: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
  }) => (
    <div data-testid="studio-player-stub">
      <button
        type="button"
        onClick={() => onSaveTarget?.(fixtures.templateMatchTarget as PerceptionTarget, 4200)}
      >
        Simulate Image Save
      </button>
      <button
        type="button"
        onClick={() => onSaveTarget?.(fixtures.colorSampleTarget as PerceptionTarget, 4200)}
      >
        Simulate Color Save
      </button>
    </div>
  ),
}));

import { AddNodePanel } from "./AddNodePanel";

beforeEach(() => {
  // jsdom returns zeroed rects; give the timeline track a 100px width so the
  // clientX→ms drag math is deterministic, and stub pointer capture (not
  // implemented in jsdom). Mirrors StudioTimeline.test.tsx's beforeEach.
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

// The recording picker is a Radix (shadcn) Select: options only exist in the
// DOM while the dropdown is open, so open it via the trigger first, then
// click the option by its visible name.
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
  it("only lists recordings that have video in the Add Segment select", async () => {
    render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);
    await userEvent.click(screen.getByRole("combobox", { name: /recording/i }));
    expect(await screen.findByRole("option", { name: /recording one/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /no video recording/i })).not.toBeInTheDocument();
  });

  it("adds a Segment node with events filtered to the relative range and correct provenance", async () => {
    const onAdd = vi.fn();
    render(<AddNodePanel recordings={recordings} onAdd={onAdd} />);

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

  it("rounds a fractional-second start/end to integer ms (Rust i64/u64 deserialization)", async () => {
    const onAdd = vi.fn();
    render(<AddNodePanel recordings={recordings} onAdd={onAdd} />);

    await selectRecording("Recording One");
    await setStartEnd("1.001", "3.0004");

    await userEvent.click(screen.getByRole("button", { name: /add segment/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const node = onAdd.mock.calls[0][0];
    expect(node.kind.provenance.start_ms).toBe(1001);
    expect(Number.isInteger(node.kind.provenance.start_ms)).toBe(true);
    expect(Number.isInteger(node.kind.provenance.end_ms)).toBe(true);
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

    await selectRecording("Recording One");
    await setStartEnd("3", "3");

    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();
  });

  it("disables the Add Segment button when no recording is selected", () => {
    render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();
  });

  it("drags a range on the timeline and adds a segment with those events", async () => {
    const onAdd = vi.fn();
    const { container } = render(<AddNodePanel recordings={recordings} onAdd={onAdd} />);

    await selectRecording("Recording One");

    // rec-1's 5 events span basis(1000)+0..+4000; duration_ms=5000 over a
    // mocked 100px track: clientX 40 → 40% → 2000ms, 80 → 80% → 4000ms.
    const track = container.querySelector(".tl-track") as HTMLElement;
    fireEvent.pointerDown(track, { clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 80, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 80, pointerId: 1 });

    expect(screen.getByText("3 events · 2.0s")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /add segment/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const node = onAdd.mock.calls[0][0];
    expect(node.kind.type).toBe("Segment");
    expect(node.kind.events).toEqual([
      mkEvent("e2", 3000),
      mkEvent("e3", 4000),
      mkEvent("e4", 5000),
    ]);
    expect(node.kind.provenance).toEqual({
      recording_id: "rec-1",
      start_ms: 2000,
      end_ms: 4000,
    });
  });

  it("disables Add until a range is selected", async () => {
    const { container } = render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);

    await selectRecording("Recording One");
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();
    expect(screen.getByText("Drag on the timeline to select a range")).toBeInTheDocument();

    const track = container.querySelector(".tl-track") as HTMLElement;
    fireEvent.pointerDown(track, { clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 80, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 80, pointerId: 1 });

    expect(screen.getByRole("button", { name: /add segment/i })).toBeEnabled();
  });

  it("resets the numeric inputs when the timeline range is cleared", async () => {
    const { container } = render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);
    await selectRecording("Recording One");

    // Drag 40→80 (rel 2000..4000ms) so the numeric fields populate to 2/4.
    const track = container.querySelector(".tl-track") as HTMLElement;
    fireEvent.pointerDown(track, { clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 80, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 80, pointerId: 1 });

    const startInput = screen.getByRole("spinbutton", { name: /start/i });
    const endInput = screen.getByRole("spinbutton", { name: /end/i });
    expect(startInput).toHaveValue(2);
    expect(endInput).toHaveValue(4);

    // StudioTimeline's ✕ clear button fires onLoopChange(null) (same path as a
    // plain non-drag track click). The numeric buffers must clear too, or they'd
    // keep describing a range that no longer exists.
    await userEvent.click(screen.getByRole("button", { name: /loop/i }));

    expect(startInput).toHaveValue(0);
    expect(endInput).toHaveValue(null);
    expect(screen.getByText("Drag on the timeline to select a range")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();
  });

  it("rounds the dragged range so the summary count matches the added node's events", async () => {
    // Non-evenly-divisible track width so msAt() (clientX/width × dur) yields a
    // fractional ms at the drag boundary. An event sits exactly on the rounded
    // boundary but NOT on the raw fraction, so an unrounded handleLoopChange
    // would count it in the summary differently than segmentNodeFromRange (which
    // rounds internally) counts it in the built node — "what you see ≠ what's added".
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

    // basis = video.start_ms = 0 → rel = timestamp. Event at rel 292 is the
    // boundary event; the one at rel 100 sits safely inside the range.
    const rec: Recording = {
      ...recordingWithVideo,
      id: "rec-frac",
      name: "Fractional",
      events: [mkEvent("inside", 100), mkEvent("boundary", 292)],
      video: { ...recordingWithVideo.video!, start_ms: 0, duration_ms: 5000 },
    };
    const onAdd = vi.fn();
    const { container } = render(<AddNodePanel recordings={[rec]} onAdd={onAdd} />);
    await selectRecording("Fractional");

    // Drag clientX 0 → 8 over the 137px/5000ms track: msAt(8) = 8/137×5000 =
    // 291.9708ms, which rounds to 292 — landing on the boundary event.
    const track = container.querySelector(".tl-track") as HTMLElement;
    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 8, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 8, pointerId: 1 });

    // Summary count and the built node's event count must agree. Against the
    // unrounded version this fails: summary reads 1 (292 > 291.97, excluded),
    // node reads 2 (292 <= round(291.97)=292, included).
    const summaryText = screen.getByText(/events ·/).textContent ?? "";
    const summaryCount = Number(summaryText.match(/^(\d+)/)?.[1]);

    await userEvent.click(screen.getByRole("button", { name: /add segment/i }));
    const node = onAdd.mock.calls[0][0];

    expect(summaryCount).toBe(node.kind.events.length);
    expect(summaryCount).toBe(2);
    expect(node.kind.provenance.end_ms).toBe(292);
  });

  it("disables the Add Segment button when the range is out of bounds", async () => {
    render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);

    await selectRecording("Recording One");
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

  it("rounds a fractional-second timeout to integer ms", async () => {
    const onAdd = vi.fn();
    render(<AddNodePanel recordings={recordings} onAdd={onAdd} />);

    await userEvent.type(screen.getByLabelText(/expect/i), "Ready");
    const timeoutInput = screen.getByRole("spinbutton", { name: /timeout/i });
    await userEvent.clear(timeoutInput);
    await userEvent.type(timeoutInput, "2.0016");

    await userEvent.click(screen.getByRole("button", { name: /add text wait/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const node = onAdd.mock.calls[0][0];
    expect(node.kind.timeout_ms).toBe(2002);
    expect(Number.isInteger(node.kind.timeout_ms)).toBe(true);
  });

  it("disables the Add Text Wait button when expect is empty", async () => {
    render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);
    expect(screen.getByRole("button", { name: /add text wait/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/expect/i), "   ");
    expect(screen.getByRole("button", { name: /add text wait/i })).toBeDisabled();
  });

  describe("Add Visual Wait", () => {
    it("does not render the visual-wait player when no recording is selected", () => {
      render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);
      expect(screen.queryByTestId("studio-player-stub")).not.toBeInTheDocument();
    });

    it("renders the visual-wait player once a recording with video is selected", async () => {
      render(<AddNodePanel recordings={recordings} onAdd={() => {}} />);
      await selectRecording("Recording One");
      expect(screen.getByTestId("studio-player-stub")).toBeInTheDocument();
    });

    it("captures a TemplateMatch target via captureImageWait and adds a WaitFor node with the captured (returned) target", async () => {
      const onAdd = vi.fn();
      const capturedTarget: PerceptionTarget = {
        ...(fixtures.templateMatchTarget as PerceptionTarget),
        kind: {
          type: "TemplateMatch",
          image: "targets/rec-1/target-image-1.png",
          threshold: 0.8,
          source_px: [1920, 1080],
        },
      };
      const captureImageWait = vi.fn().mockResolvedValue(capturedTarget);
      const sampleColor = vi.fn();
      render(
        <AddNodePanel
          recordings={recordings}
          onAdd={onAdd}
          captureImageWait={captureImageWait}
          sampleColor={sampleColor}
        />,
      );

      await selectRecording("Recording One");
      await userEvent.click(screen.getByRole("button", { name: /simulate image save/i }));

      await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
      expect(captureImageWait).toHaveBeenCalledWith("rec-1", fixtures.templateMatchTarget, 4200);
      expect(sampleColor).not.toHaveBeenCalled();
      const node = onAdd.mock.calls[0][0];
      expect(node.kind.type).toBe("WaitFor");
      expect(node.kind.target).toBe(capturedTarget);
      expect(node.kind.timeout_ms).toBe(10000);
      expect(node.kind.poll_interval_ms).toBe(500);
    });

    it("wraps a ColorSample target directly, without calling captureImageWait", async () => {
      const onAdd = vi.fn();
      const captureImageWait = vi.fn();
      render(
        <AddNodePanel
          recordings={recordings}
          onAdd={onAdd}
          captureImageWait={captureImageWait}
          sampleColor={vi.fn()}
        />,
      );

      await selectRecording("Recording One");
      await userEvent.click(screen.getByRole("button", { name: /simulate color save/i }));

      await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
      expect(captureImageWait).not.toHaveBeenCalled();
      const node = onAdd.mock.calls[0][0];
      expect(node.kind.type).toBe("WaitFor");
      expect(node.kind.target).toEqual(fixtures.colorSampleTarget);
    });
  });
});
