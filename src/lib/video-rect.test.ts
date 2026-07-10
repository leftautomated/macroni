import { describe, expect, it } from "vitest";
import { videoDisplayRect } from "./video-rect";

describe("videoDisplayRect", () => {
  it("letterboxes a wide video in a tall container", () => {
    const r = videoDisplayRect({ width: 100, height: 200 }, { width: 1920, height: 1080 });
    expect(r.width).toBeCloseTo(100);
    expect(r.height).toBeCloseTo(56.25);
    expect(r.left).toBeCloseTo(0);
    expect(r.top).toBeCloseTo((200 - 56.25) / 2);
  });

  it("pillarboxes a tall video in a wide container", () => {
    const r = videoDisplayRect({ width: 200, height: 100 }, { width: 1080, height: 1920 });
    expect(r.height).toBeCloseTo(100);
    expect(r.left).toBeCloseTo((200 - 56.25) / 2);
  });

  it("returns a zero rect on degenerate input", () => {
    expect(videoDisplayRect({ width: 0, height: 0 }, { width: 1920, height: 1080 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});
