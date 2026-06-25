import { describe, it, expect } from "vitest";
import { groupEvents, scrollSummary } from "./event-utils";
import { type InputEvent, InputEventType } from "@/types";

const key = (t: number): InputEvent => ({ type: InputEventType.KeyPress, key: "a", timestamp: t });
const scroll = (dx: number, dy: number, t: number): InputEvent => ({
  type: InputEventType.Scroll,
  delta_x: dx,
  delta_y: dy,
  timestamp: t,
});
const move = (x: number, y: number, t: number): InputEvent => ({
  type: InputEventType.MouseMove,
  x,
  y,
  timestamp: t,
});
const press = (button: string, x: number, y: number, t: number): InputEvent => ({
  type: InputEventType.ButtonPress,
  button,
  x,
  y,
  timestamp: t,
});
const release = (button: string, x: number, y: number, t: number): InputEvent => ({
  type: InputEventType.ButtonRelease,
  button,
  x,
  y,
  timestamp: t,
});

describe("groupEvents", () => {
  it("merges consecutive scrolls into one row with summed deltas and count", () => {
    const rows = groupEvents([
      key(0),
      scroll(1, -2, 10),
      scroll(0, -3, 20),
      scroll(2, -1, 30),
      key(40),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "event", index: 0 });
    expect(rows[1]).toMatchObject({
      kind: "scroll",
      startIndex: 1,
      endIndex: 3,
      count: 3,
      deltaX: 3,
      deltaY: -6,
      timestamp: 10,
    });
    expect(rows[2]).toMatchObject({ kind: "event", index: 4 });
  });

  it("starts a fresh scroll group after a non-scroll event interrupts", () => {
    const rows = groupEvents([scroll(0, -1, 0), key(5), scroll(0, -1, 10)]);
    expect(rows.map((r) => r.kind)).toEqual(["scroll", "event", "scroll"]);
  });

  it("merges consecutive mouse moves into one row keeping the latest position", () => {
    const rows = groupEvents([move(1, 1, 0), move(5, 6, 10), move(9, 12, 20), key(30)]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "move",
      startIndex: 0,
      endIndex: 2,
      count: 3,
      x: 9,
      y: 12,
      timestamp: 0,
    });
    expect(rows[1]).toMatchObject({ kind: "event", index: 3 });
  });

  it("collapses an adjacent press+release into a click", () => {
    const rows = groupEvents([press("Left", 10, 20, 0), release("Left", 10, 20, 5)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "click",
      startIndex: 0,
      endIndex: 1,
      button: "Left",
      x: 10,
      y: 20,
      timestamp: 0,
    });
  });

  it("leaves a drag (press → moves → release) expanded, not collapsed to a click", () => {
    const rows = groupEvents([press("Left", 0, 0, 0), move(5, 5, 10), release("Left", 5, 5, 20)]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "move", "event"]);
  });

  it("returns an empty list for no events", () => {
    expect(groupEvents([])).toEqual([]);
  });
});

describe("scrollSummary", () => {
  it("shows a vertical arrow with magnitude", () => {
    expect(scrollSummary(0, 240)).toBe("↓ 240");
    expect(scrollSummary(0, -60)).toBe("↑ 60");
  });

  it("shows both axes, vertical first", () => {
    expect(scrollSummary(12, -5)).toBe("↑ 5  → 12");
  });

  it("returns a dash for no movement", () => {
    expect(scrollSummary(0, 0)).toBe("—");
  });
});
