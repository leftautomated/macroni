import { describe, it, expect } from "vitest";
import { findActiveEventIndex } from "../usePlaybackSync";
import type { InputEvent } from "@/types";
import { InputEventType } from "@/types";

const mk = (t: number): InputEvent => ({
  type: InputEventType.KeyPress,
  key: "a",
  timestamp: t,
});

describe("findActiveEventIndex", () => {
  const events = [mk(100), mk(200), mk(350), mk(500)];

  it("returns 0 before first event", () => {
    expect(findActiveEventIndex(events, 50)).toBe(0);
  });

  it("returns exact match", () => {
    expect(findActiveEventIndex(events, 200)).toBe(1);
  });

  it("returns nearest preceding event for times between events", () => {
    expect(findActiveEventIndex(events, 300)).toBe(1);
    expect(findActiveEventIndex(events, 349)).toBe(1);
    expect(findActiveEventIndex(events, 350)).toBe(2);
  });

  it("returns last event for times past end", () => {
    expect(findActiveEventIndex(events, 9999)).toBe(3);
  });

  it("returns -1 for empty list", () => {
    expect(findActiveEventIndex([], 100)).toBe(-1);
  });
});
