import { describe, expect, it } from "vitest";
import { eventsInRange, segmentBasis, segmentNodeFromRange } from "./macro-segment";
import type { InputEvent, Recording } from "@/types";

const ev = (t: number): InputEvent =>
  ({ type: "MouseMove", x: 0, y: 0, timestamp: t }) as InputEvent;
const rec = (over: Partial<Recording> = {}): Recording => ({
  id: "r1",
  name: "r",
  created_at: 1000,
  playback_speed: 1,
  events: [ev(1000), ev(2000), ev(3000), ev(4000), ev(5000)], // basis+0..+4000
  video: {
    path: "r1.mp4",
    start_ms: 1000,
    duration_ms: 5000,
    width: 100,
    height: 100,
    fps: 30,
    has_audio: false,
  },
  ...over,
});

describe("macro-segment", () => {
  it("segmentBasis prefers video.start_ms, falls back to created_at", () => {
    expect(segmentBasis(rec())).toBe(1000);
    expect(segmentBasis(rec({ video: undefined }))).toBe(1000); // created_at
    expect(segmentBasis(rec({ created_at: 42, video: undefined }))).toBe(42);
  });

  it("eventsInRange filters inclusive against the basis", () => {
    const r = rec();
    const inRange = eventsInRange(r.events, 1000, 1000, 3000); // rel 1000..3000
    expect(inRange.map((e) => e.timestamp)).toEqual([2000, 3000, 4000]);
  });

  it("segmentNodeFromRange builds the exact node with rounded provenance", () => {
    const node = segmentNodeFromRange(rec(), 1000.4, 3000.6);
    expect(node.kind.type).toBe("Segment");
    if (node.kind.type !== "Segment") throw new Error();
    expect(node.kind.speed).toBe(1);
    expect(node.kind.provenance).toEqual({ recording_id: "r1", start_ms: 1000, end_ms: 3001 });
    expect(node.kind.events.map((e) => e.timestamp)).toEqual([2000, 3000, 4000]);
    expect(node.x).toBe(40);
    expect(node.y).toBe(40);
  });
});
