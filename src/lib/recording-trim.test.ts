import { describe, expect, it } from "vitest";
import { InputEventType, type Recording } from "@/types";
import type { ProjectDoc } from "@/types/project";
import { projectWithTrim, recordingWithinTrim, trimFromProject } from "./recording-trim";

const doc: ProjectDoc = {
  version: 1,
  media: { screenMp4: "clip.mp4" },
  framing: {
    background: { type: "solid", color: [30, 30, 30, 255] },
    paddingPx: 64,
    borderRadiusPx: 12,
    shadow: { blurPx: 32, offsetYPx: 16, opacity: 0.35 },
  },
  zoomRegions: [],
  trimRegions: [],
  speedRegions: [],
};

describe("recording trim", () => {
  it("stores a kept range and removes it when extended back to the full recording", () => {
    const cut = projectWithTrim(doc, { a: 1200, b: 4100 }, 5000);
    expect(trimFromProject(cut, 5000)).toEqual({ a: 1200, b: 4100 });
    expect(projectWithTrim(cut, { a: 0, b: 5000 }, 5000).trimRegions).toEqual([]);
  });

  it("filters replay events non-destructively using the recording time basis", () => {
    const recording: Recording = {
      id: "rec",
      name: "Clip",
      created_at: 1000,
      playback_speed: 1,
      events: [
        { type: InputEventType.KeyPress, key: "a", timestamp: 1000 },
        { type: InputEventType.KeyRelease, key: "a", timestamp: 2000 },
        { type: InputEventType.KeyPress, key: "b", timestamp: 3000 },
      ],
    };
    const trimmed = recordingWithinTrim(recording, { a: 900, b: 2100 });
    expect(trimmed.events.map((event) => event.timestamp)).toEqual([2000, 3000]);
    expect(recording.events).toHaveLength(3);
  });
});
