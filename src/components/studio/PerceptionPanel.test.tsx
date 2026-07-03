import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PerceptionTarget, Recording } from "@/types";

const mockInvoke = vi.fn();
const mockLogEvent = vi.fn();

vi.mock("@/lib/observability", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  logEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

import { PerceptionPanel } from "./PerceptionPanel";

const colorTarget: PerceptionTarget = {
  id: "t1",
  name: "Health bar",
  modality: "visual",
  region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
  kind: { type: "ColorSample", rgb: [0, 0, 0], tolerance: 10 },
  created_at: 0,
};

const textTarget: PerceptionTarget = {
  id: "t2",
  name: "Score label",
  modality: "visual",
  region: { x: 0.3, y: 0.3, w: 0.2, h: 0.1 },
  kind: { type: "TextOcr" },
  created_at: 0,
};

const templateTarget: PerceptionTarget = {
  id: "t3",
  name: "Play button",
  modality: "visual",
  region: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
  kind: { type: "TemplateMatch", image: "targets/1/t3.png", threshold: 0.8, source_px: [100, 100] },
  created_at: 0,
};

const regionlessTarget: PerceptionTarget = {
  id: "t4",
  name: "No region yet",
  modality: "visual",
  region: null,
  kind: { type: "TextOcr" },
  created_at: 0,
};

function rowFor(name: string) {
  return screen.getByText(name).closest(".pp-row") as HTMLElement;
}

describe("PerceptionPanel", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockLogEvent.mockReset();
  });

  it("tests a Color target on the current frame and renders a match result", async () => {
    mockInvoke.mockResolvedValueOnce({ type: "Color", rgb: [1, 2, 3], matched: true });

    render(
      <PerceptionPanel
        recordingId="1"
        targets={[colorTarget, textTarget]}
        playheadMs={1234}
        onRecordingUpdate={vi.fn()}
      />,
    );

    const row = rowFor("Health bar");
    await userEvent.click(within(row).getByRole("button", { name: /test frame/i }));

    expect(mockInvoke).toHaveBeenCalledWith("extract_region", {
      source: { type: "Recording", recording_id: "1", timestamp_ms: 1234 },
      region: colorTarget.region,
      kind: colorTarget.kind,
    });

    await waitFor(() => {
      expect(within(row).getByText(/match/i)).toBeInTheDocument();
    });
  });

  it("tests a target live, sending a Live source", async () => {
    mockInvoke.mockResolvedValueOnce({ type: "Color", rgb: [4, 5, 6], matched: false });

    render(
      <PerceptionPanel
        recordingId="1"
        targets={[colorTarget]}
        playheadMs={1234}
        onRecordingUpdate={vi.fn()}
      />,
    );

    const row = rowFor("Health bar");
    await userEvent.click(within(row).getByRole("button", { name: /test live/i }));

    expect(mockInvoke).toHaveBeenCalledWith("extract_region", {
      source: { type: "Live" },
      region: colorTarget.region,
      kind: colorTarget.kind,
    });

    await waitFor(() => {
      expect(within(row).getByText(/no match/i)).toBeInTheDocument();
    });
  });

  it("deletes a target and hands the resolved recording to onRecordingUpdate", async () => {
    const updated: Recording = {
      id: "1",
      name: "Rec",
      events: [],
      created_at: 0,
      playback_speed: 1,
      targets: [textTarget],
    };
    mockInvoke.mockResolvedValueOnce(updated);
    const onRecordingUpdate = vi.fn();

    render(
      <PerceptionPanel
        recordingId="1"
        targets={[colorTarget, textTarget]}
        playheadMs={1234}
        onRecordingUpdate={onRecordingUpdate}
      />,
    );

    const row = rowFor("Health bar");
    await userEvent.click(within(row).getByRole("button", { name: /delete/i }));

    expect(mockInvoke).toHaveBeenCalledWith("delete_target", {
      recordingId: "1",
      targetId: "t1",
    });

    await waitFor(() => {
      expect(onRecordingUpdate).toHaveBeenCalledWith(updated);
    });
  });

  it("renders joined OCR span text, or a no-text-found fallback", async () => {
    mockInvoke.mockResolvedValueOnce({
      type: "Text",
      spans: [
        { text: "Hello", region: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: 0.9 },
        { text: "World", region: { x: 0.1, y: 0, w: 0.1, h: 0.1 }, confidence: 0.9 },
      ],
    });

    render(
      <PerceptionPanel
        recordingId="1"
        targets={[textTarget]}
        playheadMs={0}
        onRecordingUpdate={vi.fn()}
      />,
    );

    const row = rowFor("Score label");
    await userEvent.click(within(row).getByRole("button", { name: /test frame/i }));

    await waitFor(() => {
      expect(within(row).getByText("Hello World")).toBeInTheDocument();
    });

    mockInvoke.mockResolvedValueOnce({ type: "Text", spans: [] });
    await userEvent.click(within(row).getByRole("button", { name: /test frame/i }));

    await waitFor(() => {
      expect(within(row).getByText(/no text found/i)).toBeInTheDocument();
    });
  });

  it("renders Template results with a 2-decimal score, matched or not", async () => {
    mockInvoke.mockResolvedValueOnce({ type: "Template", matched: true, score: 0.9345 });

    render(
      <PerceptionPanel
        recordingId="1"
        targets={[templateTarget]}
        playheadMs={0}
        onRecordingUpdate={vi.fn()}
      />,
    );

    const row = rowFor("Play button");
    await userEvent.click(within(row).getByRole("button", { name: /test frame/i }));

    await waitFor(() => {
      expect(within(row).getByText("match 0.93")).toBeInTheDocument();
    });

    mockInvoke.mockResolvedValueOnce({ type: "Template", matched: false, score: 0.41 });
    await userEvent.click(within(row).getByRole("button", { name: /test frame/i }));

    await waitFor(() => {
      expect(within(row).getByText("no match 0.41")).toBeInTheDocument();
    });
  });

  it("shows an error result and logs when extract_region rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("boom"));

    render(
      <PerceptionPanel
        recordingId="1"
        targets={[colorTarget]}
        playheadMs={0}
        onRecordingUpdate={vi.fn()}
      />,
    );

    const row = rowFor("Health bar");
    await userEvent.click(within(row).getByRole("button", { name: /test frame/i }));

    await waitFor(() => {
      expect(within(row).getByText(/error/i)).toBeInTheDocument();
    });
    expect(mockLogEvent).toHaveBeenCalledWith(
      "error",
      "studio.perception",
      "extract_region_failed",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("disables Test buttons for a target with no region", () => {
    render(
      <PerceptionPanel
        recordingId="1"
        targets={[regionlessTarget]}
        playheadMs={0}
        onRecordingUpdate={vi.fn()}
      />,
    );

    const row = rowFor("No region yet");
    expect(within(row).getByRole("button", { name: /test frame/i })).toBeDisabled();
    expect(within(row).getByRole("button", { name: /test live/i })).toBeDisabled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
